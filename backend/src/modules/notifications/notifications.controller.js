const asyncHandler = require('../../utils/asyncHandler');
const service = require('./notifications.service');

const list = asyncHandler(async (req, res) => res.json({ success: true, data: await service.list(req.user.id, req.query) }));
const unreadCount = asyncHandler(async (req, res) => res.json({ success: true, data: await service.unreadCount(req.user.id) }));
const markRead = asyncHandler(async (req, res) => res.json({ success: true, data: { notification: await service.markRead(req.user.id, req.params.id) } }));
const markAllRead = asyncHandler(async (req, res) => res.json({ success: true, data: await service.markAllRead(req.user.id) }));

module.exports = { list, unreadCount, markRead, markAllRead };
