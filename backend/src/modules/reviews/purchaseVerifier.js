const { db } = require('../../config/postgres');

/**
 * "Has this buyer received (a COMPLETED order for) this product?" is a question about money
 * and orders, so the answer lives in PostgreSQL, not in MongoDB.
 *
 * The orders tables are created on Days 9-10. They will contain:
 *     sub_orders (id, buyer_id text, status, ...)   and   order_items (sub_order_id, product_id text, ...)
 * A review is allowed only when a sub-order with status 'COMPLETED' contains the product.
 * Until those tables exist nobody has a completed order, so the answer is simply "no".
 */
async function hasCompletedPurchase(buyerId, productId, trx = db) {
  const { rows } = await trx.raw("SELECT to_regclass('sub_orders') AS s, to_regclass('order_items') AS i");
  if (!rows[0].s || !rows[0].i) return false;

  const result = await trx.raw(
    `SELECT 1
       FROM sub_orders so
       JOIN order_items oi ON oi.sub_order_id = so.id
      WHERE so.buyer_id = ? AND so.status = 'COMPLETED' AND oi.product_id = ?
      LIMIT 1`,
    [buyerId, productId],
  );
  return result.rows.length > 0;
}

module.exports = { hasCompletedPurchase };
