const bus = require('../../events/bus');
const EVENTS = require('../../events/events');
const { formatNaira } = require('../../utils/money');
const userRepository = require('../users/user.repository');
const notificationRepository = require('./notification.repository');

/**
 * Turns domain events into in-app notifications. Each notification carries a dedupeKey
 * (type + entity + recipient), so an event delivered twice still produces one notification.
 */
const notify = (userId, type, entityKey, title, message, data = {}) =>
  notificationRepository.create({ userId, type, title, message, data, dedupeKey: `${type}:${entityKey}` });

let registered = false;

/** Safe to call many times (every createApp does): listeners are attached once per process. */
function registerListeners() {
  if (registered) return;
  registered = true;
  bus.on(EVENTS.ORDER_PLACED, async (e) => {
    await notify(e.buyerId, 'ORDER_PLACED', e.orderId, 'Order placed', `Your order for ${formatNaira(e.totalKobo)} was placed. The money is held safely until you confirm delivery.`, { orderId: e.orderId });
    for (const s of e.subOrders) {
      await notify(s.vendorUserId, 'NEW_ORDER', s.id, 'New order', `You have a new order worth ${formatNaira(s.subtotalKobo)}. Please ship it.`, { orderId: e.orderId, subOrderId: s.id });
    }
  });

  bus.on(EVENTS.ORDER_SHIPPED, (e) =>
    notify(e.buyerId, 'ORDER_SHIPPED', e.subOrderId, 'Your order has shipped', 'The seller has shipped your item. Confirm delivery when it arrives; otherwise payment is released automatically after 72 hours.', { orderId: e.orderId, subOrderId: e.subOrderId }));

  bus.on(EVENTS.FUNDS_RELEASED, (e) =>
    notify(e.vendorUserId, 'FUNDS_RELEASED', e.subOrderId, 'Funds released', `${formatNaira(e.vendorKobo)} was added to your wallet (after ${formatNaira(e.commissionKobo)} commission).`, { orderId: e.orderId, subOrderId: e.subOrderId, reason: e.reason }));

  bus.on(EVENTS.DISPUTE_OPENED, async (e) => {
    await notify(e.vendorUserId, 'DISPUTE_OPENED', e.disputeId, 'A buyer opened a dispute', 'The payment for this order is on hold until an admin reviews the dispute.', { disputeId: e.disputeId, subOrderId: e.subOrderId });
    const adminIds = await userRepository.listIdsByRole('admin');
    for (const adminId of adminIds) {
      await notify(adminId, 'DISPUTE_NEEDS_REVIEW', e.disputeId, 'Dispute needs review', 'A buyer opened a dispute that needs a decision.', { disputeId: e.disputeId, subOrderId: e.subOrderId });
    }
  });

  bus.on(EVENTS.DISPUTE_RESOLVED, async (e) => {
    const outcome = { FULL_REFUND: 'full refund', PARTIAL_REFUND: `partial refund of ${formatNaira(e.refundKobo)}`, REJECTED: 'rejected (the seller was paid)' }[e.resolution];
    const data = { disputeId: e.disputeId, subOrderId: e.subOrderId, resolution: e.resolution };
    await notify(e.buyerId, 'DISPUTE_RESOLVED', `${e.disputeId}:buyer`, 'Dispute resolved', `Your dispute was resolved: ${outcome}.`, data);
    await notify(e.vendorUserId, 'DISPUTE_RESOLVED', `${e.disputeId}:vendor`, 'Dispute resolved', `The dispute was resolved: ${outcome}.`, data);
  });

  bus.on(EVENTS.PAYOUT_SUCCESS, (e) =>
    notify(e.userId, 'PAYOUT_SUCCESS', e.payoutId, 'Payout sent', `${formatNaira(e.amountKobo)} was sent to your bank account.`, { payoutId: e.payoutId }));

  bus.on(EVENTS.PAYOUT_FAILED, (e) =>
    notify(e.userId, 'PAYOUT_FAILED', e.payoutId, 'Payout failed', `Your payout of ${formatNaira(e.amountKobo)} failed and the money is back in your wallet. Reason: ${e.reason || 'the bank rejected it'}.`, { payoutId: e.payoutId }));
}

module.exports = { registerListeners };
