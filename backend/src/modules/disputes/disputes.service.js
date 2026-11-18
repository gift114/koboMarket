const { db } = require('../../config/postgres');
const AppError = require('../../utils/AppError');
const { TRANSACTION_TYPE } = require('../../db/constants');
const orderRepository = require('../orders/order.repository');
const escrowService = require('../orders/escrow.service');
const { encodeCursor, decodeCursor } = require('../orders/orders.service');
const disputeRepository = require('./dispute.repository');
const bus = require('../../events/bus');
const EVENTS = require('../../events/events');

/**
 * Disputes (Module G).
 *
 * Opening one moves the sub-order SHIPPED|DELIVERED -> DISPUTED. That freezes its escrow: ship,
 * confirm, cancel and the auto-complete job all require another status, and the DB state machine
 * allows only an admin resolution to leave DISPUTED.
 *
 * Resolving (admin) settles the frozen escrow in ONE ledger transaction (DISPUTE_RESOLUTION):
 *   FULL_REFUND     escrow -> buyer                      sub-order REFUNDED
 *   PARTIAL_REFUND  escrow -> buyer (refund) and vendor  sub-order COMPLETED
 *                   (rest, minus commission on THAT part only) and PLATFORM_REVENUE
 *   REJECT          escrow -> vendor minus commission, as a normal release; sub-order COMPLETED
 * The dispute records the admin's id and note; the DB rejects a resolution without them, or one
 * whose parts do not add up to the frozen amount.
 *
 * Every step locks the parent order, then the sub-order, then the dispute (same order as
 * fulfilment, so no deadlocks), and re-reads the status under the lock.
 */

const notFound = () => AppError.notFound('Dispute not found', 'DISPUTE_NOT_FOUND');

const toView = (d) => ({
  id: d.id,
  subOrderId: d.subOrderId,
  orderId: d.orderId,
  buyerId: d.buyerId,
  vendorUserId: d.vendorUserId,
  reason: d.reason,
  evidence: d.evidence,
  escrowKobo: d.escrowKobo,
  status: d.status,
  resolution: d.resolution,
  refundKobo: d.refundKobo,
  vendorGrossKobo: d.vendorGrossKobo,
  commissionKobo: d.commissionKobo,
  resolvedBy: d.resolvedBy,
  resolutionNote: d.resolutionNote,
  resolvedAt: d.resolvedAt,
  createdAt: d.createdAt,
});

const isAdmin = (user) => user.roles.includes('admin');
const canSee = (user, d) => isAdmin(user) || d.buyerId === user.id || d.vendorUserId === user.id;

/** Buyer: dispute a sub-order that has shipped. Freezes its escrow. */
async function open(user, subOrderId, { reason, evidence }) {
  try {
    const created = await db.transaction(async (trx) => {
        const peek = await orderRepository.findSubOrder(subOrderId, trx);
        if (!peek) throw AppError.notFound('Order not found', 'SUB_ORDER_NOT_FOUND');
        await orderRepository.lockOrder(trx, peek.orderId);
        const sub = await orderRepository.lockSubOrder(trx, subOrderId);
        if (!sub || sub.buyerId !== user.id) throw AppError.notFound('Order not found', 'SUB_ORDER_NOT_FOUND');
        if (!['SHIPPED', 'DELIVERED'].includes(sub.status)) {
          throw AppError.conflict(`Only a shipped order can be disputed (this one is ${sub.status})`, 'CANNOT_DISPUTE', { status: sub.status });
        }
        const dispute = await disputeRepository.insert(trx, { subOrder: sub, reason, evidence });
        await orderRepository.markDisputed(trx, sub.id);
        return dispute;
      });
    bus.publish(EVENTS.DISPUTE_OPENED, { disputeId: created.id, subOrderId: created.subOrderId, buyerId: created.buyerId, vendorUserId: created.vendorUserId });
    return toView(created);
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'disputes_sub_order_unique') {
      throw AppError.conflict('This order already has a dispute', 'DISPUTE_EXISTS');
    }
    throw err;
  }
}

/** Admin: settle a dispute. */
async function resolve(admin, disputeId, { resolution, refundKobo, note }) {
  const peek = await disputeRepository.findById(disputeId);
  if (!peek) throw notFound();

  const resolved = await db.transaction(async (trx) => {
    await orderRepository.lockOrder(trx, peek.orderId);
    const sub = await orderRepository.lockSubOrder(trx, peek.subOrderId);
    const dispute = await disputeRepository.lockById(trx, disputeId);
    if (dispute.status !== 'OPEN' || sub.status !== 'DISPUTED') {
      throw AppError.conflict('This dispute has already been resolved', 'DISPUTE_ALREADY_RESOLVED');
    }

    const escrow = dispute.escrowKobo;
    let refund;
    if (resolution === 'FULL_REFUND') refund = escrow;
    else if (resolution === 'REJECT') refund = 0;
    else {
      if (refundKobo >= escrow) {
        throw AppError.validation(
          [{ path: 'refundKobo', message: `A partial refund must be less than the ${escrow} kobo in dispute (use FULL_REFUND to refund everything)` }],
          'Invalid refund amount',
        );
      }
      refund = refundKobo;
    }

    const settled = await escrowService.settleEscrow(trx, sub, {
      refundKobo: refund,
      vendorGrossKobo: escrow - refund,
      type: TRANSACTION_TYPE.DISPUTE_RESOLUTION,
      idempotencyKey: `dispute:${dispute.id}`,
      reference: `DISPUTE-${dispute.id}`,
      metadata: { description: `Dispute resolved: ${resolution}`, disputeId: dispute.id, resolvedBy: admin.id },
    });

    if (resolution === 'FULL_REFUND') await orderRepository.markRefunded(trx, sub.id);
    else await orderRepository.markCompleted(trx, sub.id);
    await orderRepository.syncParentStatus(trx, sub.orderId);

    await disputeRepository.markResolved(trx, dispute.id, {
      resolution: resolution === 'REJECT' ? 'REJECTED' : resolution,
      refundKobo: refund,
      vendorGrossKobo: escrow - refund,
      commissionKobo: settled.commissionKobo,
      resolvedBy: admin.id,
      note,
      transactionId: settled.transactionId,
    });
    return { dispute: await disputeRepository.findById(dispute.id, trx), sub, settled };
  });
  const d = resolved.dispute;
  bus.publish(EVENTS.DISPUTE_RESOLVED, { disputeId: d.id, subOrderId: d.subOrderId, resolution: d.resolution, refundKobo: d.refundKobo, buyerId: d.buyerId, vendorUserId: d.vendorUserId });
  if (d.vendorGrossKobo > 0) {
    bus.publish(EVENTS.FUNDS_RELEASED, {
      orderId: d.orderId, subOrderId: d.subOrderId, vendorUserId: d.vendorUserId,
      vendorKobo: resolved.settled.vendorKobo, commissionKobo: resolved.settled.commissionKobo, reason: 'DISPUTE_RESOLVED',
    });
  }
  return toView(d);
}

/** One dispute: its buyer, its vendor, or an admin. Anyone else gets 404. */
async function getOne(user, disputeId) {
  const dispute = await disputeRepository.findById(disputeId);
  if (!dispute || !canSee(user, dispute)) throw notFound();
  return toView(dispute);
}

async function list(user, { status, limit, cursor }) {
  const rows = await disputeRepository.list({
    userId: user.id,
    isAdmin: isAdmin(user),
    status,
    limit: limit + 1,
    cursor: cursor ? decodeCursor(cursor) : null,
  });
  const page = rows.slice(0, limit);
  return { disputes: page.map(toView), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null };
}

module.exports = { open, resolve, getOne, list };
