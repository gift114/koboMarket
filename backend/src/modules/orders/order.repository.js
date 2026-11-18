const { db } = require('../../config/postgres');

const itemFromRow = (r) => ({
  id: r.id,
  productId: r.product_id,
  variantId: r.variant_id,
  name: r.name,
  quantity: r.quantity,
  unitPriceKobo: r.unit_price_kobo,
  lineTotalKobo: r.line_total_kobo,
  stockDecremented: r.stock_decremented,
  stockRestored: r.stock_restored,
});

const subOrderFromRow = (r) => ({
  id: r.id,
  orderId: r.order_id,
  buyerId: r.buyer_id,
  vendorId: r.vendor_id,
  vendorUserId: r.vendor_user_id,
  status: r.status,
  subtotalKobo: r.subtotal_kobo,
  commissionRateBps: r.commission_rate_bps,
  escrowHeldKobo: r.escrow_held_kobo,
  shippedAt: r.shipped_at,
  deliveredAt: r.delivered_at,
  completedAt: r.completed_at,
  cancelledAt: r.cancelled_at,
  createdAt: r.created_at,
});

const orderFromRow = (r) => ({
  id: r.id,
  buyerId: r.buyer_id,
  idempotencyKey: r.idempotency_key,
  status: r.status,
  totalKobo: r.total_kobo,
  paymentTransactionId: r.payment_transaction_id,
  stockStatus: r.stock_status,
  cancelReason: r.cancel_reason,
  createdAt: r.created_at,
});

/**
 * Insert the parent order, its sub-orders and items, all in `trx`, and return the new ids.
 * `subOrders`: [{ vendorId, vendorUserId, subtotalKobo, commissionRateBps, items: [...] }]
 * The database re-checks every total at COMMIT.
 */
async function createOrderRows(trx, { buyerId, idempotencyKey, totalKobo, subOrders }) {
  const [order] = await trx('orders')
    .insert({ buyer_id: buyerId, idempotency_key: idempotencyKey, total_kobo: totalKobo })
    .returning('*');

  const created = [];
  for (const sub of subOrders) {
    const [subRow] = await trx('sub_orders')
      .insert({
        order_id: order.id,
        buyer_id: buyerId,
        vendor_id: sub.vendorId,
        vendor_user_id: sub.vendorUserId,
        subtotal_kobo: sub.subtotalKobo,
        commission_rate_bps: sub.commissionRateBps,
      })
      .returning('*');
    await trx('order_items').insert(
      sub.items.map((i) => ({
        sub_order_id: subRow.id,
        product_id: i.productId,
        variant_id: i.variantId,
        name: i.name,
        quantity: i.quantity,
        unit_price_kobo: i.unitPriceKobo,
        line_total_kobo: i.lineTotalKobo,
      })),
    );
    created.push(subRow.id);
  }
  return { orderId: order.id, subOrderIds: created };
}

/** PENDING_PAYMENT -> PAID for the order and every sub-order, with the escrow they now hold. */
async function markPaid(trx, orderId, paymentTransactionId) {
  await trx('orders').where({ id: orderId }).update({ status: 'PAID', payment_transaction_id: paymentTransactionId });
  await trx('sub_orders')
    .where({ order_id: orderId })
    .update({ status: 'PAID', escrow_held_kobo: trx.raw('subtotal_kobo') });
}

async function lockOrder(trx, orderId) {
  const row = await trx('orders').where({ id: orderId }).forUpdate().first();
  return row ? orderFromRow(row) : null;
}

/** Cancel an order whose checkout failed: order and sub-orders CANCELLED, escrow released from them. */
async function markCancelled(trx, orderId, reason) {
  await trx('orders').where({ id: orderId }).update({ status: 'CANCELLED', cancel_reason: reason, stock_status: 'RELEASED' });
  await trx('sub_orders')
    .where({ order_id: orderId })
    .update({ status: 'CANCELLED', escrow_held_kobo: 0, cancelled_at: trx.fn.now() });
}

/** PENDING -> RESERVED. False if the order is no longer PAID/PENDING (the recovery job got to it first). */
async function markStockReserved(orderId) {
  const updated = await db('orders').where({ id: orderId, status: 'PAID', stock_status: 'PENDING' }).update({ stock_status: 'RESERVED' });
  return updated > 0;
}

async function flagItemDecremented(itemId) {
  await db('order_items').where({ id: itemId }).update({ stock_decremented: true });
}

/** Claim an item's restock BEFORE touching MongoDB: a crash then loses stock rather than inventing it. */
async function claimItemRestore(itemId) {
  const rows = await db('order_items').where({ id: itemId, stock_decremented: true, stock_restored: false }).update({ stock_restored: true }).returning('id');
  return rows.length > 0;
}

async function findByBuyerAndKey(buyerId, idempotencyKey, trx = db) {
  const row = await trx('orders').where({ buyer_id: buyerId, idempotency_key: idempotencyKey }).first();
  return row ? orderFromRow(row) : null;
}

/** An order with its sub-orders and items. */
async function findById(orderId, trx = db) {
  const row = await trx('orders').where({ id: orderId }).first();
  if (!row) return null;
  const subs = await trx('sub_orders').where({ order_id: orderId }).orderBy('created_at').orderBy('id');
  const items = subs.length ? await trx('order_items').whereIn('sub_order_id', subs.map((s) => s.id)).orderBy('created_at').orderBy('id') : [];
  return {
    ...orderFromRow(row),
    subOrders: subs.map((s) => ({ ...subOrderFromRow(s), items: items.filter((i) => i.sub_order_id === s.id).map(itemFromRow) })),
  };
}

/** Newest first; cursor = (created_at, id) of the last order of the previous page. */
async function listByBuyer(buyerId, { limit, cursor }) {
  const query = db('orders').where({ buyer_id: buyerId });
  if (cursor) query.whereRaw('(created_at, id) < (?::timestamptz, ?::uuid)', [cursor.createdAt, cursor.id]);
  const rows = await query.orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(limit);
  return rows.map(orderFromRow);
}

/** PAID orders whose stock step never finished (the process died, or MongoDB was down). */
async function findStuckOrders(olderThanSeconds, limit = 20) {
  const rows = await db('orders')
    .where({ status: 'PAID', stock_status: 'PENDING' })
    .whereRaw("created_at < now() - (? || ' seconds')::interval", [String(olderThanSeconds)])
    .orderBy('created_at')
    .limit(limit);
  return rows.map(orderFromRow);
}

/** Lock one sub-order (call AFTER lockOrder on its parent: every path locks order first, then sub-order). */
async function lockSubOrder(trx, subOrderId) {
  const row = await trx('sub_orders').where({ id: subOrderId }).forUpdate().first();
  return row ? subOrderFromRow(row) : null;
}

async function findSubOrder(subOrderId, trx = db) {
  const row = await trx('sub_orders').where({ id: subOrderId }).first();
  if (!row) return null;
  const items = await trx('order_items').where({ sub_order_id: subOrderId }).orderBy('created_at').orderBy('id');
  return { ...subOrderFromRow(row), items: items.map(itemFromRow) };
}

async function markShipped(trx, subOrderId) {
  await trx('sub_orders').where({ id: subOrderId }).update({ status: 'SHIPPED', shipped_at: trx.fn.now() });
}

/** SHIPPED -> DELIVERED. */
async function markDelivered(trx, subOrderId) {
  await trx('sub_orders').where({ id: subOrderId }).update({ status: 'DELIVERED', delivered_at: trx.fn.now() });
}

/** SHIPPED|DELIVERED -> COMPLETED; the escrow has been paid out, so nothing is held any more. */
async function markCompleted(trx, subOrderId) {
  await trx('sub_orders').where({ id: subOrderId }).update({ status: 'COMPLETED', escrow_held_kobo: 0, completed_at: trx.fn.now() });
}

/** SHIPPED|DELIVERED -> DISPUTED. The escrow stays exactly where it is (frozen). */
async function markDisputed(trx, subOrderId) {
  await trx('sub_orders').where({ id: subOrderId }).update({ status: 'DISPUTED' });
}

/** DISPUTED -> REFUNDED; the whole escrow went back to the buyer. */
async function markRefunded(trx, subOrderId) {
  await trx('sub_orders').where({ id: subOrderId }).update({ status: 'REFUNDED', escrow_held_kobo: 0 });
}

/** PAID -> CANCELLED; the escrow has been refunded. */
async function markSubOrderCancelled(trx, subOrderId) {
  await trx('sub_orders').where({ id: subOrderId }).update({ status: 'CANCELLED', escrow_held_kobo: 0, cancelled_at: trx.fn.now() });
}

/**
 * Close the parent order once every sub-order is finished: all CANCELLED -> CANCELLED, otherwise
 * (some completed or refunded) -> COMPLETED. Returns the new parent status, or null if still open.
 * Call with the parent order already locked.
 */
async function syncParentStatus(trx, orderId, cancelReason = 'BUYER_CANCELLED') {
  const subs = await trx('sub_orders').where({ order_id: orderId }).select('status');
  const terminal = ['COMPLETED', 'CANCELLED', 'REFUNDED'];
  if (!subs.length || !subs.every((s) => terminal.includes(s.status))) return null;
  if (subs.every((s) => s.status === 'CANCELLED')) {
    await trx('orders').where({ id: orderId, status: 'PAID' }).update({ status: 'CANCELLED', cancel_reason: cancelReason, stock_status: 'RELEASED' });
    return 'CANCELLED';
  }
  await trx('orders').where({ id: orderId, status: 'PAID' }).update({ status: 'COMPLETED' });
  return 'COMPLETED';
}

/** A vendor's sales (sub-orders), newest first; cursor = (created_at, id). */
async function listSubOrdersByVendorUser(vendorUserId, { limit, cursor, status }) {
  const query = db('sub_orders').where({ vendor_user_id: vendorUserId });
  if (status) query.where({ status });
  if (cursor) query.whereRaw('(created_at, id) < (?::timestamptz, ?::uuid)', [cursor.createdAt, cursor.id]);
  const rows = await query.orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(limit);
  const items = rows.length ? await db('order_items').whereIn('sub_order_id', rows.map((r) => r.id)).orderBy('created_at').orderBy('id') : [];
  return rows.map((r) => ({ ...subOrderFromRow(r), items: items.filter((i) => i.sub_order_id === r.id).map(itemFromRow) }));
}

/** SHIPPED sub-orders the buyer has ignored for longer than `hours` (DISPUTED ones are never SHIPPED, so never listed). */
async function findOverdueShipped(hours, limit = 50) {
  const rows = await db('sub_orders')
    .where({ status: 'SHIPPED' })
    .whereRaw("shipped_at < now() - (? || ' hours')::interval", [String(hours)])
    .orderBy('shipped_at')
    .limit(limit);
  return rows.map(subOrderFromRow);
}

module.exports = {
  lockSubOrder,
  findSubOrder,
  markShipped,
  markDelivered,
  markCompleted,
  markDisputed,
  markRefunded,
  markSubOrderCancelled,
  syncParentStatus,
  listSubOrdersByVendorUser,
  findOverdueShipped,
  createOrderRows,
  markPaid,
  lockOrder,
  markCancelled,
  markStockReserved,
  flagItemDecremented,
  claimItemRestore,
  findByBuyerAndKey,
  findById,
  listByBuyer,
  findStuckOrders,
};
