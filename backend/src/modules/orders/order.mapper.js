const { formatNaira } = require('../../utils/money');

/** What the API shows about an order. Internal columns (idempotency key, ledger link, stock flags) stay hidden. */
function toOrderView(order) {
  return {
    id: order.id,
    status: order.status,
    totalKobo: order.totalKobo,
    totalDisplay: formatNaira(order.totalKobo),
    cancelReason: order.cancelReason,
    createdAt: order.createdAt,
    subOrders: order.subOrders.map(toSubOrderView),
  };
}

function toSubOrderView(s) {
  return {
      id: s.id,
      orderId: s.orderId,
      vendorId: s.vendorId,
      status: s.status,
      subtotalKobo: s.subtotalKobo,
      escrowHeldKobo: s.escrowHeldKobo,
      shippedAt: s.shippedAt,
      deliveredAt: s.deliveredAt,
      completedAt: s.completedAt,
      cancelledAt: s.cancelledAt,
      items: s.items.map((i) => ({
        id: i.id,
        productId: i.productId,
        variantId: i.variantId,
        name: i.name,
        quantity: i.quantity,
        unitPriceKobo: i.unitPriceKobo,
        lineTotalKobo: i.lineTotalKobo,
      })),
  };
}

module.exports = { toOrderView, toSubOrderView };
