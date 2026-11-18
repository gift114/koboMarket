const AppError = require('../../utils/AppError');
const logger = require('../../utils/logger');
const productRepository = require('../products/product.repository');
const reviewRepository = require('./review.repository');
const purchaseVerifier = require('./purchaseVerifier');

const toReviewView = (r) => ({
  id: r.id,
  productId: r.productId,
  buyerName: r.buyerName,
  rating: r.rating,
  title: r.title,
  comment: r.comment,
  createdAt: r.createdAt,
});

const alreadyReviewed = () => AppError.conflict('You have already reviewed this product', 'ALREADY_REVIEWED');

/**
 * Rules: the product must exist; the buyer must have a COMPLETED order containing it; one
 * review per buyer per product (unique index); the product's average rating is updated.
 *
 * Two MongoDB writes (the review, then the product's rating aggregate) cannot share a
 * transaction here, so the order is chosen to fail safe: the review is inserted first (the
 * unique index is the gate), then the aggregate is bumped atomically. If the bump fails the
 * review is removed again, so a review is never stored without being counted.
 */
async function addReview(user, productId, { rating, title, comment }) {
  const product = await productRepository.findById(productId);
  if (!product) throw AppError.notFound('Product not found', 'PRODUCT_NOT_FOUND');

  if (!(await purchaseVerifier.hasCompletedPurchase(user.id, productId))) {
    throw AppError.forbidden(
      'You can only review products from a completed order of yours',
      'PURCHASE_REQUIRED',
    );
  }

  let review;
  try {
    review = await reviewRepository.create({
      productId,
      buyerId: user.id,
      buyerName: user.fullName,
      rating,
      title,
      comment,
    });
  } catch (err) {
    if (err.code === 11000) throw alreadyReviewed();
    throw err;
  }

  let updated;
  try {
    updated = await productRepository.addRating(productId, rating);
    if (!updated) throw new Error('product disappeared while rating it');
  } catch (err) {
    logger.error({ err, productId }, 'Updating the product rating failed, removing the review again');
    await reviewRepository.remove(review.id).catch((e) => logger.error({ err: e }, 'Could not remove the review'));
    throw err;
  }

  return { review: toReviewView(review), rating: { average: updated.ratingAvg, count: updated.ratingCount } };
}

async function listReviews(productId, { limit, cursor }) {
  const product = await productRepository.findById(productId);
  if (!product) throw AppError.notFound('Product not found', 'PRODUCT_NOT_FOUND');
  const rows = await reviewRepository.listByProduct(productId, { limit: limit + 1, cursor });
  const page = rows.slice(0, limit);
  return {
    reviews: page.map(toReviewView),
    rating: { average: product.ratingAvg, count: product.ratingCount },
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
  };
}

module.exports = { addReview, listReviews };
