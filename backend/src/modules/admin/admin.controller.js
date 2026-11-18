const asyncHandler = require('../../utils/asyncHandler');
const adminService = require('./admin.service');

const listUsers = asyncHandler(async (req, res) => res.json({ success: true, data: await adminService.listUsers(req.query) }));
const freeze = asyncHandler(async (req, res) => res.json({ success: true, data: { user: await adminService.setFrozen(req.user, req.params.id, true) } }));
const unfreeze = asyncHandler(async (req, res) => res.json({ success: true, data: { user: await adminService.setFrozen(req.user, req.params.id, false) } }));
const getWallet = asyncHandler(async (req, res) => res.json({ success: true, data: { wallet: await adminService.getWallet(req.params.id) } }));
const getLedger = asyncHandler(async (req, res) => res.json({ success: true, data: await adminService.getLedger(req.params.id, req.query) }));
const getCommission = asyncHandler(async (req, res) => res.json({ success: true, data: { commission: await adminService.getCommission() } }));
const setCommission = asyncHandler(async (req, res) =>
  res.json({ success: true, data: { commission: await adminService.setCommission(req.user, req.body.rateBps) } }));

module.exports = { listUsers, freeze, unfreeze, getWallet, getLedger, getCommission, setCommission };
