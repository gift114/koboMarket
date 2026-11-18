const asyncHandler = require('../../utils/asyncHandler');
const cartService = require('./cart.service');

const get = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { cart: await cartService.getCart(req.user.id) } });
});
const add = asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: { cart: await cartService.addItem(req.user, req.body) } });
});
const update = asyncHandler(async (req, res) => {
  const cart = await cartService.updateQuantity(req.user.id, req.params.itemId, req.body.quantity);
  res.json({ success: true, data: { cart } });
});
const remove = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { cart: await cartService.removeItem(req.user.id, req.params.itemId) } });
});

module.exports = { get, add, update, remove };
