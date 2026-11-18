const asyncHandler = require('../../utils/asyncHandler');
const walletService = require('./wallet.service');

const getWallet = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { wallet: await walletService.getWallet(req.user.id) } });
});

const listTransactions = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await walletService.listTransactions(req.user.id, req.query) });
});

module.exports = { getWallet, listTransactions };
