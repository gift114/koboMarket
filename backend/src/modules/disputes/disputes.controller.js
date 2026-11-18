const asyncHandler = require('../../utils/asyncHandler');
const service = require('./disputes.service');

const open = asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: { dispute: await service.open(req.user, req.params.id, req.body) } });
});
const resolve = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { dispute: await service.resolve(req.user, req.params.id, req.body) } });
});
const getOne = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { dispute: await service.getOne(req.user, req.params.id) } });
});
const list = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await service.list(req.user, req.query) });
});

module.exports = { open, resolve, getOne, list };
