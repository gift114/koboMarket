const AppError = require('../../utils/AppError');
const notificationRepository = require('./notification.repository');

const toView = (n) => ({ id: n.id, type: n.type, title: n.title, message: n.message, data: n.data, read: Boolean(n.readAt), readAt: n.readAt, createdAt: n.createdAt });

async function list(userId, { limit, cursor, unread }) {
  const rows = await notificationRepository.listByUser(userId, { limit: limit + 1, cursor, unreadOnly: unread === true });
  const page = rows.slice(0, limit);
  return {
    notifications: page.map(toView),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    unreadCount: await notificationRepository.countUnread(userId),
  };
}

const unreadCount = async (userId) => ({ unreadCount: await notificationRepository.countUnread(userId) });

async function markRead(userId, id) {
  const n = await notificationRepository.markRead(userId, id);
  if (!n) throw AppError.notFound('Notification not found', 'NOTIFICATION_NOT_FOUND'); // also for somebody else's
  return toView(n);
}

async function markAllRead(userId) {
  return { updated: await notificationRepository.markAllRead(userId) };
}

module.exports = { list, unreadCount, markRead, markAllRead };
