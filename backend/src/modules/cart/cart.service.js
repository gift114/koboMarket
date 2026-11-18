const { randomBytes } = require('crypto');
const AppError = require('../../utils/AppError');
const { formatNaira } = require('../../utils/money');
const cartRepository = require('./cart.repository');
const productRepository = require('../products/product.repository');

const MAX_LINES = 50;
const MAX_QUANTITY = 99;
const MAX_ATTEMPTS = 15;
const newId = () => randomBytes(12).toString('hex');

// ------------------------------------------------------------------ helpers

/** What the cart line points at right now: price, stock and whether it can still be bought. */
function resolve(product, variantId) {
  if (!product || !product.isActive) return { issue: 'PRODUCT_UNAVAILABLE' };
  if (product.variants.length > 0) {
    const variant = product.variants.find((v) => v.id === variantId);
    if (!variant) return { issue: 'VARIANT_UNAVAILABLE' };
    return { priceKobo: variant.priceKobo, stock: variant.stock, variant };
  }
  if (variantId) return { issue: 'VARIANT_UNAVAILABLE' }; // the product no longer has variants
  return { priceKobo: product.priceKobo, stock: product.stock, variant: null };
}

const issueFor = (resolved, quantity) => {
  if (resolved.issue) return resolved.issue;
  if (resolved.stock === 0) return 'OUT_OF_STOCK';
  if (quantity > resolved.stock) return 'INSUFFICIENT_STOCK';
  return null;
};

/**
 * Read-modify-write with optimistic concurrency: re-read and retry if another request changed
 * the cart in between, so simultaneous requests from one user can never lose an update or
 * exceed a stock limit.
 */
async function mutate(userId, change) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const cart = await cartRepository.findByUserId(userId);
    const items = cart ? cart.items.map((i) => ({ ...i })) : [];
    const next = await change(items);
    const saved = await cartRepository.save(userId, next, cart ? cart.rev : null);
    if (saved) return saved;
  }
  throw AppError.conflict('The cart is changing too quickly, please try again', 'CART_BUSY');
}

const insufficientStock = (available, requested) =>
  AppError.conflict(
    available === 0 ? 'This item is out of stock' : `Only ${available} left in stock`,
    available === 0 ? 'OUT_OF_STOCK' : 'INSUFFICIENT_STOCK',
    { availableStock: available, requestedQuantity: requested },
  );

// ------------------------------------------------------------------ the cart view

/** The cart as the buyer should see it NOW: current prices and stock, with warnings. */
async function toView(cart) {
  const items = cart ? cart.items : [];
  const products = await productRepository.findManyByIds([...new Set(items.map((i) => i.productId))]);

  const lines = items.map((item) => {
    const product = products.get(item.productId);
    const resolved = resolve(product, item.variantId);
    const issue = issueFor(resolved, item.quantity);
    const currentPriceKobo = resolved.priceKobo ?? null;
    return {
      id: item.id,
      productId: item.productId,
      variantId: item.variantId,
      name: product ? product.name : null,
      slug: product ? product.slug : null,
      image: product && product.images[0] ? product.images[0] : null,
      attributes: resolved.variant ? resolved.variant.attributes : null,
      vendorId: product ? product.vendorId : null,
      quantity: item.quantity,
      addedPriceKobo: item.priceKobo,
      currentPriceKobo,
      priceChanged: currentPriceKobo !== null && currentPriceKobo !== item.priceKobo,
      lineTotalKobo: currentPriceKobo === null ? 0 : currentPriceKobo * item.quantity,
      availableStock: resolved.stock ?? 0,
      available: issue === null,
      issue,
    };
  });

  const purchasable = lines.filter((l) => l.available);
  const byVendor = new Map();
  for (const l of purchasable) {
    const group = byVendor.get(l.vendorId) || { vendorId: l.vendorId, itemCount: 0, subtotalKobo: 0 };
    group.itemCount += l.quantity;
    group.subtotalKobo += l.lineTotalKobo;
    byVendor.set(l.vendorId, group);
  }
  const totalKobo = purchasable.reduce((sum, l) => sum + l.lineTotalKobo, 0);

  return {
    items: lines,
    vendors: [...byVendor.values()],
    itemCount: lines.reduce((sum, l) => sum + l.quantity, 0),
    totalKobo, // purchasable lines only, at CURRENT prices
    totalDisplay: formatNaira(totalKobo),
    hasIssues: lines.some((l) => !l.available || l.priceChanged),
  };
}

async function getCart(userId) {
  return toView(await cartRepository.findByUserId(userId));
}

// ------------------------------------------------------------------ changes

async function addItem(user, { productId, variantId = null, quantity }) {
  const product = (await productRepository.findManyByIds([productId])).get(productId);
  if (!product || !product.isActive) throw AppError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
  if (product.vendorUserId === user.id) {
    throw AppError.forbidden('You cannot buy your own product', 'CANNOT_BUY_OWN_PRODUCT');
  }

  if (product.variants.length > 0 && !variantId) {
    throw AppError.validation([{ path: 'variantId', message: 'This product has variants: choose one' }]);
  }
  const resolved = resolve(product, variantId);
  if (resolved.issue) {
    throw AppError.validation([{ path: 'variantId', message: 'That variant does not exist for this product' }]);
  }

  const cart = await mutate(user.id, async (items) => {
    const line = items.find((i) => i.productId === productId && i.variantId === variantId);
    const wanted = (line ? line.quantity : 0) + quantity;
    if (wanted > MAX_QUANTITY) {
      throw AppError.conflict(`You can buy at most ${MAX_QUANTITY} of one item`, 'QUANTITY_LIMIT');
    }
    if (wanted > resolved.stock) throw insufficientStock(resolved.stock, wanted);

    if (line) {
      line.quantity = wanted;
      line.priceKobo = resolved.priceKobo; // re-add = the buyer has now seen the current price
    } else {
      if (items.length >= MAX_LINES) {
        throw AppError.conflict(`A cart can hold at most ${MAX_LINES} different items`, 'CART_FULL');
      }
      items.push({ id: newId(), productId, variantId, quantity, priceKobo: resolved.priceKobo, addedAt: new Date() });
    }
    return items;
  });
  return toView(cart);
}

async function updateQuantity(userId, itemId, quantity) {
  const cart = await mutate(userId, async (items) => {
    const line = items.find((i) => i.id === itemId);
    if (!line) throw AppError.notFound('Cart item not found', 'CART_ITEM_NOT_FOUND');

    const product = (await productRepository.findManyByIds([line.productId])).get(line.productId);
    const resolved = resolve(product, line.variantId);
    if (resolved.issue) {
      throw AppError.conflict('This item is no longer available, please remove it', resolved.issue);
    }
    if (quantity > resolved.stock) throw insufficientStock(resolved.stock, quantity);

    line.quantity = quantity;
    line.priceKobo = resolved.priceKobo;
    return items;
  });
  return toView(cart);
}

async function removeItem(userId, itemId) {
  const cart = await mutate(userId, async (items) => {
    const next = items.filter((i) => i.id !== itemId);
    if (next.length === items.length) throw AppError.notFound('Cart item not found', 'CART_ITEM_NOT_FOUND');
    return next;
  });
  return toView(cart);
}

/** Remove specific lines (the ones just bought). Lines added meanwhile are left alone. */
async function removeItems(userId, itemIds) {
  const gone = new Set(itemIds);
  await mutate(userId, async (items) => items.filter((i) => !gone.has(i.id)));
}

/** Empty the cart. */
async function clear(userId) {
  await mutate(userId, async () => []);
}

// ------------------------------------------------------------------ checkout

/**
 * Re-validate the whole cart against the database and price it at CURRENT prices. The prices
 * stored in the cart are never used to charge anyone.
 *
 * Throws 409 CART_INVALID (with the list of problems) if the cart is empty or any line is
 * unavailable or exceeds stock. Otherwise returns the lines to buy, the total, and which
 * prices changed since the buyer added them (so checkout can show or enforce a confirmation).
 */
async function prepareCheckout(userId) {
  const cart = await cartRepository.findByUserId(userId);
  if (!cart || cart.items.length === 0) {
    throw AppError.conflict('Your cart is empty', 'CART_EMPTY');
  }
  const view = await toView(cart);

  const problems = view.items
    .filter((l) => !l.available)
    .map((l) => ({
      itemId: l.id,
      productId: l.productId,
      name: l.name,
      issue: l.issue,
      requestedQuantity: l.quantity,
      availableStock: l.availableStock,
    }));
  if (problems.length > 0) {
    throw AppError.conflict('Some items in your cart cannot be bought as they are', 'CART_INVALID', { problems });
  }

  const products = await productRepository.findManyByIds(view.items.map((l) => l.productId));
  const lines = view.items.map((l) => {
    const product = products.get(l.productId);
    return {
      itemId: l.id,
      productId: l.productId,
      variantId: l.variantId,
      vendorId: product.vendorId,
      vendorUserId: product.vendorUserId,
      name: l.name,
      quantity: l.quantity,
      unitPriceKobo: l.currentPriceKobo,
      lineTotalKobo: l.lineTotalKobo,
    };
  });
  const totalKobo = lines.reduce((sum, l) => sum + l.lineTotalKobo, 0);
  if (!Number.isSafeInteger(totalKobo)) throw AppError.conflict('Cart total is too large', 'CART_TOO_LARGE');

  return {
    lines,
    totalKobo,
    priceChanges: view.items
      .filter((l) => l.priceChanged)
      .map((l) => ({ itemId: l.id, name: l.name, addedPriceKobo: l.addedPriceKobo, currentPriceKobo: l.currentPriceKobo })),
  };
}

module.exports = { getCart, addItem, updateQuantity, removeItem, removeItems, clear, prepareCheckout, MAX_LINES, MAX_QUANTITY };
