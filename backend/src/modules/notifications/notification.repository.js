const Notification = require('./notification.model');

const toDomain = (d) =>
  d && {
    id: String(d._id),
    userId: String(d.userId),
    type: d.type,
    title: d.title,
    message: d.message,
    data: d.data || {},
    readAt: d.readAt || null,
    createdAt: d.createdAt,
  };

/** Create unless this dedupeKey exists for the user. Returns the notification, or null if it was a duplicate. */
async function create({ userId, type, title, message, data, dedupeKey }) {
  try {
    return toDomain((await Notification.create({ userId, type, title, message, data, dedupeKey })).toObject());
  } catch (err) {
    if (err.code === 11000) return null;
    throw err;
  }
}

/** Newest first; cursor = the id of the last notification of the previous page. */
async function listByUser(userId, { limit, cursor, unreadOnly }) {
  const filter = { userId };
  if (unreadOnly) filter.readAt = null;
  if (cursor) filter._id = { $lt: cursor };
  return (await Notification.find(filter).sort({ _id: -1 }).limit(limit).lean()).map(toDomain);
}

const countUnread = (userId) => Notification.countDocuments({ userId, readAt: null });

/** Mark one of MY notifications read. Returns the notification, or null if it is not mine / does not exist. Idempotent. */
async function markRead(userId, id) {
  await Notification.updateOne({ _id: id, userId, readAt: null }, { $set: { readAt: new Date() } });
  return toDomain(await Notification.findOne({ _id: id, userId }).lean());
}

/** Returns how many were unread. */
async function markAllRead(userId) {
  const res = await Notification.updateMany({ userId, readAt: null }, { $set: { readAt: new Date() } });
  return res.modifiedCount;
}

module.exports = { create, listByUser, countUnread, markRead, markAllRead };
