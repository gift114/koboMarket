const { randomBytes } = require('crypto');
const AppError = require('../../utils/AppError');
const vendorRepository = require('../vendors/vendor.repository');
const productRepository = require('./product.repository');
const { toProductView } = require('./product.mapper');
const { encodeCursor, decodeCursor } = require('./product.query');

const newId = () => randomBytes(12).toString('hex');

function slugify(name) {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || 'product';
}

/** The caller must own an APPROVED store (the vendor role alone is not enough proof). */
async function requireApprovedVendor(userId) {
  const vendor = await vendorRepository.findByUserId(userId);
  if (!vendor || vendor.status !== 'approved') {
    throw AppError.forbidden('Only approved vendors can manage products', 'NOT_AN_APPROVED_VENDOR');
  }
  return vendor;
}

/** The product must exist and belong to this vendor. */
async function requireOwnProduct(vendor, productId) {
  const product = await productRepository.findById(productId);
  if (!product) throw AppError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
  if (product.vendorId !== vendor.id) {
    throw AppError.forbidden('This product belongs to another vendor', 'NOT_YOUR_PRODUCT');
  }
  return product;
}

/** New variants get ids; existing ones keep theirs (carts and orders point at variant ids). */
function withVariantIds(variants, existing = []) {
  const known = new Set(existing.map((v) => v.id));
  return variants.map((v) => {
    if (v.id && !known.has(v.id)) {
      throw AppError.validation([{ path: 'variants', message: `Variant ${v.id} does not belong to this product` }]);
    }
    return { ...v, id: v.id || newId() };
  });
}

/** Price and stock of a product that has variants are DERIVED: lowest price, total stock. */
const derive = (variants) => ({
  priceKobo: Math.min(...variants.map((v) => v.priceKobo)),
  stock: variants.reduce((sum, v) => sum + v.stock, 0),
});

const priceNeeded = () =>
  AppError.validation([{ path: 'priceKobo', message: 'priceKobo is required for a product without variants' }]);
const variantsOwnPrice = () =>
  AppError.validation([{ path: 'variants', message: 'A product with variants gets its price and stock from the variants' }]);

async function create(userId, body) {
  const vendor = await requireApprovedVendor(userId);

  let pricing;
  let variants = [];
  if (body.variants.length > 0) {
    if (body.priceKobo !== undefined || body.stock !== undefined) throw variantsOwnPrice();
    variants = withVariantIds(body.variants);
    pricing = derive(variants);
  } else {
    if (body.priceKobo === undefined) throw priceNeeded();
    pricing = { priceKobo: body.priceKobo, stock: body.stock ?? 0 };
  }

  const base = slugify(body.name);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
    try {
      const product = await productRepository.create({
        vendorId: vendor.id,
        vendorUserId: userId,
        name: body.name,
        slug,
        description: body.description,
        category: body.category,
        images: body.images,
        tags: [...new Set(body.tags)],
        variants,
        isActive: body.isActive,
        ...pricing,
      });
      return toProductView(product);
    } catch (err) {
      const slugTaken = err.code === 11000 && err.keyPattern && err.keyPattern.slug;
      if (!slugTaken) throw err;
    }
  }
  throw AppError.conflict('Could not generate a unique slug, please try again', 'SLUG_CONFLICT');
}

async function update(userId, productId, body) {
  const vendor = await requireApprovedVendor(userId);
  const product = await requireOwnProduct(vendor, productId);

  const patch = {};
  for (const key of ['name', 'description', 'category', 'images', 'isActive']) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (body.tags !== undefined) patch.tags = [...new Set(body.tags)];

  const hasVariantsAfter = body.variants !== undefined ? body.variants.length > 0 : product.variants.length > 0;
  if (hasVariantsAfter) {
    if (body.priceKobo !== undefined || body.stock !== undefined) throw variantsOwnPrice();
    if (body.variants !== undefined) {
      patch.variants = withVariantIds(body.variants, product.variants);
      Object.assign(patch, derive(patch.variants));
    }
  } else if (body.variants !== undefined) {
    // Variants removed: the product needs its own price again.
    if (body.priceKobo === undefined) throw priceNeeded();
    Object.assign(patch, { variants: [], priceKobo: body.priceKobo, stock: body.stock ?? 0 });
  } else {
    if (body.priceKobo !== undefined) patch.priceKobo = body.priceKobo;
    if (body.stock !== undefined) patch.stock = body.stock;
  }

  const updated = await productRepository.update(productId, patch);
  if (!updated) throw AppError.notFound('Product not found', 'PRODUCT_NOT_FOUND'); // deleted meanwhile
  return toProductView(updated);
}

async function remove(userId, productId) {
  const vendor = await requireApprovedVendor(userId);
  await requireOwnProduct(vendor, productId);
  const deleted = await productRepository.softDelete(productId);
  if (!deleted) throw AppError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
  return { id: productId, deleted: true };
}

/** Public product page by slug. Inactive and deleted products look like they do not exist. */
async function getBySlug(slug) {
  const product = await productRepository.findBySlug(slug);
  if (!product || !product.isActive) throw AppError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
  return toProductView(product);
}

async function list({ q, category, tag, vendor, minPrice, maxPrice, minRating, sort, limit, cursor }) {
  const after = cursor ? decodeCursor(sort, cursor) : null;
  // One extra row tells us whether another page exists.
  const rows = await productRepository.search({
    filters: { q, category, tag, vendorId: vendor, minPrice, maxPrice, minRating },
    sort,
    limit: limit + 1,
    after,
  });
  const page = rows.slice(0, limit);
  return {
    products: page.map(toProductView),
    nextCursor: rows.length > limit ? encodeCursor(sort, page[page.length - 1]) : null,
  };
}

async function listMine(userId, { limit, cursor }) {
  const vendor = await requireApprovedVendor(userId);
  const rows = await productRepository.listByVendor(vendor.id, { limit: limit + 1, cursor });
  const page = rows.slice(0, limit);
  return {
    products: page.map(toProductView),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
  };
}

module.exports = { create, update, remove, getBySlug, list, listMine };
