/** Names of the domain events. Payloads are plain data (ids and amounts), never documents. */
module.exports = Object.freeze({
  ORDER_PLACED: 'order.placed',
  ORDER_SHIPPED: 'order.shipped',
  FUNDS_RELEASED: 'funds.released',
  DISPUTE_OPENED: 'dispute.opened',
  DISPUTE_RESOLVED: 'dispute.resolved',
  PAYOUT_SUCCESS: 'payout.success',
  PAYOUT_FAILED: 'payout.failed',
});
