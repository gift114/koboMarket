const asyncHandler = require('../../utils/asyncHandler');
const checkoutService = require('./checkout.service');
const ordersService = require('./orders.service');
const fulfilmentService = require('./fulfilment.service');
const disputesService = require('../disputes/disputes.service');

const checkout = asyncHandler(async (req, res) => {
  const order = await checkoutService.checkout(req.user, {
    idempotencyKey: req.get('Idempotency-Key'),
    expectedTotalKobo: req.body.expectedTotalKobo,
  });
  res.status(201).json({ success: true, data: { order } });
});
const list = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await ordersService.listMine(req.user.id, req.query) });
});
const getOne = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { order: await ordersService.getOne(req.user, req.params.id) } });
});

const ship = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { subOrder: await fulfilmentService.ship(req.user, req.params.id) } });
});
const confirmDelivery = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { subOrder: await fulfilmentService.confirmDelivery(req.user, req.params.id) } });
});
const cancel = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { subOrder: await fulfilmentService.cancel(req.user, req.params.id) } });
});
const sales = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await fulfilmentService.listSales(req.user, req.query, ordersService.decodeCursor, ordersService.encodeCursor) });
});

const openDispute = asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: { dispute: await disputesService.open(req.user, req.params.id, req.body) } });
});

module.exports = { openDispute, checkout, list, getOne, ship, confirmDelivery, cancel, sales };
