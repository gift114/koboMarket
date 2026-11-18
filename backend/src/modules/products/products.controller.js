const asyncHandler = require('../../utils/asyncHandler');
const productsService = require('./products.service');
const reviewsService = require('../reviews/reviews.service');

const list = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await productsService.list(req.query) });
});
const getBySlug = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { product: await productsService.getBySlug(req.params.slug) } });
});
const create = asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: { product: await productsService.create(req.user.id, req.body) } });
});
const update = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { product: await productsService.update(req.user.id, req.params.id, req.body) } });
});
const remove = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await productsService.remove(req.user.id, req.params.id) });
});

const addReview = asyncHandler(async (req, res) => {
  const result = await reviewsService.addReview(req.user, req.params.id, req.body);
  res.status(201).json({ success: true, data: result });
});
const listReviews = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await reviewsService.listReviews(req.params.id, req.query) });
});

const listMine = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await productsService.listMine(req.user.id, req.query) });
});

module.exports = { list, getBySlug, create, update, remove, addReview, listReviews, listMine };
