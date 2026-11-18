const AppError = require('../../utils/AppError');
const orderRepository = require('./order.repository');
const { toOrderView } = require('./order.mapper');

const encodeCursor = (o) => Buffer.from(JSON.stringify({ t: new Date(o.createdAt).toISOString(), id: o.id })).toString('base64url');

function decodeCursor(cursor) {
  const bad = () => AppError.validation([{ path: 'cursor', message: 'Invalid cursor' }], 'Invalid cursor');
  try {
    const { t, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof t !== 'string' || Number.isNaN(Date.parse(t)) || !/^[0-9a-f-]{36}$/.test(id)) throw bad();
    return { createdAt: t, id };
  } catch {
    throw bad();
  }
}

/** My orders (as a buyer), newest first. */
async function listMine(userId, { limit, cursor }) {
  const rows = await orderRepository.listByBuyer(userId, { limit: limit + 1, cursor: cursor ? decodeCursor(cursor) : null });
  const page = rows.slice(0, limit);
  const orders = await Promise.all(page.map((o) => orderRepository.findById(o.id)));
  return { orders: orders.map(toOrderView), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null };
}

/** One order. Visible to its buyer and to admins; anyone else gets 404 (the order's existence is not revealed). */
async function getOne(user, orderId) {
  const order = await orderRepository.findById(orderId);
  const allowed = order && (order.buyerId === user.id || user.roles.includes('admin'));
  if (!allowed) throw AppError.notFound('Order not found', 'ORDER_NOT_FOUND');
  return toOrderView(order);
}

module.exports = { listMine, getOne, encodeCursor, decodeCursor };
