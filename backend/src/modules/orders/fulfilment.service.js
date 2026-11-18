const { db } = require('../../config/postgres');
const AppError = require('../../utils/AppError');
const logger = require('../../utils/logger');
const config = require('../../config');
const productRepository = require('../products/product.repository');
const orderRepository = require('./order.repository');
const escrowService = require('./escrow.service');
const { toSubOrderView } = require('./order.mapper');
const bus = require('../../events/bus');
const EVENTS = require('../../events/events');

/**
 * Everything that happens to a sub-order after it is paid: ship, confirm delivery, complete
 * (release escrow), auto-complete, cancel.
 *
 * Concurrency: every action runs in ONE PostgreSQL transaction that locks the parent order (the lock that serialises racing actions; the sub-order lock is belt and braces) and
 * then the sub-order (always in that order, like checkout's compensation, so no deadlocks), then
 * re-reads the status under the lock. Two racing actions (double confirm, ship vs cancel,
 * buyer confirm vs auto-complete) therefore queue up and the loser sees the new status and
 * gets 409. The ledger posting is also idempotent (`release:<id>`, `refund:<id>`), and the
 * database state machine rejects any other transition.
 */

const notFound = () => AppError.notFound('Order not found', 'SUB_ORDER_NOT_FOUND');
const invalidState = (sub, action) =>
  AppError.conflict(`Cannot ${action} a sub-order that is ${sub.status}`, 'INVALID_STATE', { status: sub.status });

/**
 * Lock the parent order, then the sub-order, and return both. `isParty` decides who may act;
 * anyone else gets 404 so the existence of other people's orders is not revealed.
 */
async function lockBoth(trx, subOrderId, isParty) {
  const peek = await orderRepository.findSubOrder(subOrderId, trx);
  if (!peek) throw notFound();
  const order = await orderRepository.lockOrder(trx, peek.orderId);
  const sub = await orderRepository.lockSubOrder(trx, subOrderId);
  if (!sub || !isParty(sub)) throw notFound();
  return { order, sub };
}

/** Money is only moved for orders whose stock step finished; while checkout is still in flight it may yet be compensated. */
function assertSettled(order) {
  if (order.stockStatus !== 'RESERVED') {
    throw AppError.conflict('This order is still being processed, try again in a moment', 'ORDER_NOT_READY');
  }
}

/**
 * Pay the vendor and close the sub-order (and the parent, if this was the last one). Caller holds
 * the locks. Returns the FUNDS_RELEASED event; the caller publishes it AFTER the transaction commits.
 */
async function completeLocked(trx, sub, { markDelivered, reason }) {
  const released = await escrowService.releaseToVendor(trx, sub);
  if (markDelivered) await orderRepository.markDelivered(trx, sub.id);
  await orderRepository.markCompleted(trx, sub.id);
  await orderRepository.syncParentStatus(trx, sub.orderId);
  return {
    event: EVENTS.FUNDS_RELEASED,
    payload: { orderId: sub.orderId, subOrderId: sub.id, vendorUserId: sub.vendorUserId, vendorKobo: released.vendorKobo, commissionKobo: released.commissionKobo, reason },
  };
}

const view = async (subOrderId) => toSubOrderView(await orderRepository.findSubOrder(subOrderId));

/** Vendor: PAID -> SHIPPED. */
async function ship(user, subOrderId) {
  const shipped = await db.transaction(async (trx) => {
    const { order, sub } = await lockBoth(trx, subOrderId, (s) => s.vendorUserId === user.id);
    if (sub.status !== 'PAID') throw invalidState(sub, 'ship');
    assertSettled(order);
    await orderRepository.markShipped(trx, sub.id);
    return sub;
  });
  bus.publish(EVENTS.ORDER_SHIPPED, { orderId: shipped.orderId, subOrderId: shipped.id, buyerId: shipped.buyerId, vendorUserId: shipped.vendorUserId });
  return view(subOrderId);
}

/**
 * Buyer: confirm the goods arrived. SHIPPED -> DELIVERED -> COMPLETED in one transaction: the
 * confirmation IS the trigger for releasing the money, so the vendor is paid immediately.
 */
async function confirmDelivery(user, subOrderId) {
  const released = await db.transaction(async (trx) => {
    const { sub } = await lockBoth(trx, subOrderId, (s) => s.buyerId === user.id);
    if (sub.status !== 'SHIPPED') throw invalidState(sub, 'confirm delivery of');
    return completeLocked(trx, sub, { markDelivered: true, reason: 'DELIVERY_CONFIRMED' });
  });
  bus.publish(released.event, released.payload);
  return view(subOrderId);
}

/** Buyer: cancel before it ships. Refunds the escrow, puts the stock back. */
async function cancel(user, subOrderId) {
  await db.transaction(async (trx) => {
    const { order, sub } = await lockBoth(trx, subOrderId, (s) => s.buyerId === user.id);
    if (sub.status !== 'PAID') {
      throw AppError.conflict(
        `A sub-order can only be cancelled before it ships (this one is ${sub.status})`,
        'CANNOT_CANCEL',
        { status: sub.status },
      );
    }
    assertSettled(order);
    await escrowService.refundToBuyer(trx, sub);
    await orderRepository.markSubOrderCancelled(trx, sub.id);
    await orderRepository.syncParentStatus(trx, sub.orderId);
  });
  await restock(subOrderId);
  return view(subOrderId);
}

/**
 * Put the cancelled items back on sale. The claim is made in PostgreSQL BEFORE MongoDB is
 * touched (same rule as checkout compensation), so a crash can lose a unit of stock but can
 * never create one; and each item is restocked at most once.
 */
async function restock(subOrderId) {
  const sub = await orderRepository.findSubOrder(subOrderId);
  for (const item of sub.items) {
    if (!(await orderRepository.claimItemRestore(item.id))) continue;
    try {
      await productRepository.restoreStock(item.productId, item.variantId, item.quantity);
    } catch (err) {
      logger.error({ err, subOrderId, itemId: item.id }, 'Could not restore stock after a cancellation');
    }
  }
}

/**
 * Background job: complete every SHIPPED sub-order the buyer has ignored for
 * ESCROW_AUTO_COMPLETE_HOURS (72). The candidates are only a hint; each one is re-checked
 * under its lock, so a sub-order that was confirmed, cancelled or DISPUTED meanwhile is skipped.
 * DISPUTED sub-orders are never SHIPPED, so they are never even candidates.
 */
async function autoCompleteOverdue(hours = config.business.escrowAutoCompleteHours) {
  const candidates = await orderRepository.findOverdueShipped(hours);
  let completed = 0;
  for (const candidate of candidates) {
    try {
      const released = await db.transaction(async (trx) => {
        const { sub } = await lockBoth(trx, candidate.id, () => true);
        const stillOverdue = sub.status === 'SHIPPED' && sub.shippedAt && Date.now() - new Date(sub.shippedAt).getTime() >= hours * 3600 * 1000;
        if (!stillOverdue) return null;
        return completeLocked(trx, sub, { markDelivered: false, reason: 'AUTO_COMPLETED' });
      });
      if (released) {
        completed += 1;
        bus.publish(released.event, released.payload);
      }
    } catch (err) {
      logger.error({ err, subOrderId: candidate.id }, 'Auto-complete failed for a sub-order, will retry');
    }
  }
  return { found: candidates.length, completed };
}

/** Vendor: my sales (sub-orders), newest first. */
async function listSales(user, { limit, cursor, status }, decodeCursor, encodeCursor) {
  const rows = await orderRepository.listSubOrdersByVendorUser(user.id, { limit: limit + 1, cursor: cursor ? decodeCursor(cursor) : null, status });
  const page = rows.slice(0, limit);
  return { subOrders: page.map(toSubOrderView), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null };
}

module.exports = { ship, confirmDelivery, cancel, autoCompleteOverdue, listSales };
