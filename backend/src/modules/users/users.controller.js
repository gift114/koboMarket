const asyncHandler = require('../../utils/asyncHandler');
const usersService = require('./users.service');

const getMe = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { user: await usersService.getMe(req.user.id) } });
});

const updateMe = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { user: await usersService.updateMe(req.user.id, req.body) } });
});

module.exports = { getMe, updateMe };
