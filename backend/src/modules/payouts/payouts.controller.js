const asyncHandler = require('../../utils/asyncHandler');
const service = require('./payouts.service');

const request = asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: { payout: await service.request(req.user, req.body) } });
});
const getOne = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { payout: await service.getOne(req.user, req.params.id) } });
});
const list = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service.listMine(req.user, req.query) });
});

module.exports = { request, getOne, list };
