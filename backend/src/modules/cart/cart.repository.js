const Cart = require('./cart.model');

function toDomain(doc) {
  if (!doc) return null;
  return {
    userId: String(doc.userId),
    rev: doc.rev,
    items: doc.items.map((i) => ({
      id: String(i._id),
      productId: String(i.productId),
      variantId: i.variantId ? String(i.variantId) : null,
      quantity: i.quantity,
      priceKobo: i.priceKobo,
      addedAt: i.addedAt,
    })),
  };
}

const itemsToDb = (items) =>
  items.map(({ id, ...rest }) => ({ _id: id, ...rest }));

async function findByUserId(userId) {
  return toDomain(await Cart.findOne({ userId }).lean());
}

/**
 * Replace the cart's items, but only if its `rev` is still `expectedRev` (null = the cart does
 * not exist yet). Returns the saved cart, or null if somebody else changed it first, in which
 * case the caller re-reads and tries again. This is optimistic concurrency: no lost updates
 * and no locks.
 */
async function save(userId, items, expectedRev) {
  if (expectedRev === null) {
    try {
      const doc = await Cart.create({ userId, items: itemsToDb(items), rev: 0 });
      return toDomain(doc.toObject());
    } catch (err) {
      if (err.code === 11000) return null; // another request created it first
      throw err;
    }
  }
  const doc = await Cart.findOneAndUpdate(
    { userId, rev: expectedRev },
    { $set: { items: itemsToDb(items) }, $inc: { rev: 1 } },
    { returnDocument: 'after', runValidators: true },
  ).lean();
  return toDomain(doc);
}

module.exports = { findByUserId, save };
