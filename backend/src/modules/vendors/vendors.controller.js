const asyncHandler = require('../../utils/asyncHandler');
const vendorsService = require('./vendors.service');

const apply = asyncHandler(async (req, res) => {
  const vendor = await vendorsService.apply(req.user.id, req.body);
  res.status(201).json({ success: true, data: { vendor } });
});

const getMine = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { vendor: await vendorsService.getMine(req.user.id) } });
});

const getPublicStore = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { vendor: await vendorsService.getPublicStore(req.params.id) } });
});

const adminList = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await vendorsService.adminList(req.query) });
});

const approve = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { vendor: await vendorsService.approve(req.user.id, req.params.id) } });
});

const reject = asyncHandler(async (req, res) => {
  const vendor = await vendorsService.reject(req.user.id, req.params.id, req.body.reason);
  res.json({ success: true, data: { vendor } });
});

module.exports = { apply, getMine, getPublicStore, adminList, approve, reject };
