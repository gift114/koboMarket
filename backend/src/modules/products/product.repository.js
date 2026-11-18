const Product = require('./product.model');
const { SORTS, mongoAfterCursor } = require('./product.query');

function variantToDomain(v) {
  return { id: String(v._id), sku: v.sku || null, attributes: v.attributes || {}, priceKobo: v.priceKobo, stock: v.stock };
}

function toDomain(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    vendorId: String(doc.vendorId),
    vendorUserId: String(doc.vendorUserId),
    name: doc.name,
    slug: doc.slug,
    description: doc.description || '',
    category: doc.category,
    images: doc.images || [],
    tags: doc.tags || [],
    priceKobo: doc.priceKobo,
    stock: doc.stock,
    variants: (doc.variants || []).map(variantToDomain),
    isActive: doc.isActive,
    deletedAt: doc.deletedAt || null,
    ratingSum: doc.ratingSum,
    ratingCount: doc.ratingCount,
    ratingAvg: doc.ratingAvg,
    createdAt: doc.createdAt,
  };
}

// variants come in as { id, sku, attributes, priceKobo, stock }; the stored _id is the id.
const variantsToDb = (variants) => variants.map(({ id, ...rest }) => ({ _id: id, ...rest }));

async function create(data) {
  const doc = await Product.create({ ...data, variants: variantsToDb(data.variants || []) });
  return toDomain(doc.toObject());
}

/** Any product that is not soft-deleted (inactive ones included). */
async function findById(id) {
  return toDomain(await Product.findOne({ _id: id, deletedAt: null }).lean());
}

async function findBySlug(slug) {
  return toDomain(await Product.findOne({ slug, deletedAt: null }).lean());
}

async function update(id, patch) {
  const set = { ...patch };
  if (set.variants) set.variants = variantsToDb(set.variants);
  const doc = await Product.findOneAndUpdate(
    { _id: id, deletedAt: null },
    { $set: set },
    { returnDocument: 'after', runValidators: true },
  ).lean();
  return toDomain(doc);
}

/** Soft delete. Atomic and one-shot: returns null if it was already deleted. */
async function softDelete(id) {
  const doc = await Product.findOneAndUpdate(
    { _id: id, deletedAt: null },
    { $set: { deletedAt: new Date(), isActive: false } },
    { returnDocument: 'after' },
  ).lean();
  return toDomain(doc);
}

/**
 * Public listing. `filters`: { q, category, minPrice, maxPrice, vendorId, minRating, tag }.
 * `after` is the decoded cursor or null. Returns up to `limit` products in sort order.
 */
async function search({ filters, sort, limit, after }) {
  const query = { deletedAt: null, isActive: true };
  if (filters.q) query.$text = { $search: filters.q };
  if (filters.category) query.category = filters.category;
  if (filters.vendorId) query.vendorId = filters.vendorId;
  if (filters.tag) query.tags = filters.tag;
  if (filters.minRating !== undefined) query.ratingAvg = { $gte: filters.minRating };
  if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
    query.priceKobo = {};
    if (filters.minPrice !== undefined) query.priceKobo.$gte = filters.minPrice;
    if (filters.maxPrice !== undefined) query.priceKobo.$lte = filters.maxPrice;
  }
  if (after) Object.assign(query, { $and: [mongoAfterCursor(sort, after)] });

  const { field, dir } = SORTS[sort];
  const docs = await Product.find(query).sort({ [field]: dir, _id: dir }).limit(limit).lean();
  return docs.map(toDomain);
}

/**
 * Add one rating to the aggregate in ONE atomic update (pipeline form), so two reviews
 * arriving together can never overwrite each other's count: no read-modify-write in JS.
 */
async function addRating(id, rating) {
  const doc = await Product.findOneAndUpdate(
    { _id: id, deletedAt: null },
    [
      { $set: { ratingSum: { $add: ['$ratingSum', rating] }, ratingCount: { $add: ['$ratingCount', 1] } } },
      { $set: { ratingAvg: { $round: [{ $divide: ['$ratingSum', '$ratingCount'] }, 2] } } },
    ],
    { returnDocument: 'after' },
  ).lean();
  return toDomain(doc);
}

/** Several non-deleted products at once (inactive ones included), as a Map of id -> product. */
async function findManyByIds(ids) {
  if (ids.length === 0) return new Map();
  const docs = await Product.find({ _id: { $in: ids }, deletedAt: null }).lean();
  return new Map(docs.map((d) => [String(d._id), toDomain(d)]));
}

/**
 * Take `quantity` units out of stock, atomically and only if enough are there. The guard is
 * part of the filter, so two buyers racing for the last unit cannot both win: exactly one
 * update matches. Returns true if the stock was taken.
 *
 * A product with variants keeps stock per variant AND a total (sum of variants); both are
 * decremented in this one single-document update, so they never drift apart.
 */
async function decrementStock(productId, variantId, quantity) {
  const filter = variantId
    ? { _id: productId, deletedAt: null, isActive: true, variants: { $elemMatch: { _id: variantId, stock: { $gte: quantity } } } }
    : { _id: productId, deletedAt: null, isActive: true, 'variants.0': { $exists: false }, stock: { $gte: quantity } };
  const update = variantId ? { $inc: { stock: -quantity, 'variants.$.stock': -quantity } } : { $inc: { stock: -quantity } };
  const doc = await Product.findOneAndUpdate(filter, update, { returnDocument: 'after' }).lean();
  return doc !== null;
}

/** Put units back (compensation). Unconditional on active/deleted: the stock still belongs to the product. */
async function restoreStock(productId, variantId, quantity) {
  const filter = variantId ? { _id: productId, 'variants._id': variantId } : { _id: productId };
  const update = variantId ? { $inc: { stock: quantity, 'variants.$.stock': quantity } } : { $inc: { stock: quantity } };
  const doc = await Product.findOneAndUpdate(filter, update, { returnDocument: 'after' }).lean();
  return doc !== null;
}

async function listByVendor(vendorId, { limit, cursor }) {
  const query = { vendorId, deletedAt: null };
  if (cursor) query._id = { $lt: cursor };
  const docs = await Product.find(query).sort({ _id: -1 }).limit(limit).lean();
  return docs.map(toDomain);
}

module.exports = { create, findById, findManyByIds, decrementStock, restoreStock, findBySlug, update, softDelete, search, addRating, listByVendor };
