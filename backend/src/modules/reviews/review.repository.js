const Review = require('./review.model');

function toDomain(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    productId: String(doc.productId),
    buyerId: String(doc.buyerId),
    buyerName: doc.buyerName,
    rating: doc.rating,
    title: doc.title || '',
    comment: doc.comment || '',
    createdAt: doc.createdAt,
  };
}

/** Throws a duplicate-key error (code 11000) if this buyer already reviewed this product. */
async function create(data) {
  const doc = await Review.create(data);
  return toDomain(doc.toObject());
}

async function remove(id) {
  await Review.deleteOne({ _id: id });
}

/** Newest first. Cursor = id of the last review of the previous page. */
async function listByProduct(productId, { limit, cursor }) {
  const query = { productId };
  if (cursor) query._id = { $lt: cursor };
  return (await Review.find(query).sort({ _id: -1 }).limit(limit).lean()).map(toDomain);
}

module.exports = { create, remove, listByProduct };
