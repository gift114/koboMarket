const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const idempotent = require('../idempotency/idempotency.middleware');
const controller = require('./orders.controller');
const v = require('./orders.validation');

const router = Router();
router.use(authenticate);

/**
 * @openapi
 * /orders/checkout:
 *   post:
 *     tags: [Orders]
 *     summary: Check out my cart (pays from my wallet into escrow)
 *     description: |
 *       Requires an `Idempotency-Key` header: the same key never creates two orders (replay returns
 *       the original response). The cart is re-validated against current stock and prices. In one
 *       PostgreSQL transaction the order is created (one parent order, one sub-order per vendor)
 *       and the buyer's wallet is debited into PLATFORM_ESCROW. Stock is then decremented in
 *       MongoDB; if that fails the payment is reversed and the order cancelled.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: Idempotency-Key, in: header, required: true, schema: { type: string, minLength: 8, maxLength: 128 } }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               expectedTotalKobo: { type: integer, description: "If set and the live total differs: 409 PRICE_CHANGED" }
 *     responses:
 *       201: { description: Order created, status PAID }
 *       400: { description: Missing or malformed Idempotency-Key }
 *       409: { description: "CART_EMPTY, CART_INVALID, PRICE_CHANGED, INSUFFICIENT_FUNDS, STOCK_UNAVAILABLE, IDEMPOTENCY_KEY_REUSED, REQUEST_IN_PROGRESS" }
 */
router.post('/checkout', validate({ body: v.checkoutBody }), idempotent(), controller.checkout);

/**
 * @openapi
 * /orders:
 *   get:
 *     tags: [Orders]
 *     summary: My orders, newest first (cursor pagination)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
 *       - { name: cursor, in: query, schema: { type: string } }
 *     responses:
 *       200: { description: "{ orders: [...], nextCursor }" }
 */
router.get('/', validate({ query: v.listQuery }), controller.list);

/**
 * @openapi
 * /orders/sales:
 *   get:
 *     tags: [Fulfilment]
 *     summary: My sales as a vendor (sub-orders), newest first
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: status, in: query, schema: { type: string, enum: [PAID, SHIPPED, DELIVERED, COMPLETED, CANCELLED, DISPUTED, REFUNDED] } }
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
 *       - { name: cursor, in: query, schema: { type: string } }
 *     responses:
 *       200: { description: "{ subOrders: [...], nextCursor }" }
 *       403: { description: Not a vendor }
 */
router.get('/sales', authorize('vendor'), validate({ query: v.salesQuery }), controller.sales);

/**
 * @openapi
 * /orders/sub-orders/{id}/ship:
 *   post:
 *     tags: [Fulfilment]
 *     summary: Vendor marks a PAID sub-order as SHIPPED
 *     description: Only the vendor who owns the sub-order (others get 404). Starts the buyer's 72-hour confirmation window.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: The sub-order, now SHIPPED }
 *       404: { description: Not found, or not yours }
 *       409: { description: "INVALID_STATE (not PAID) or ORDER_NOT_READY" }
 */
router.post('/sub-orders/:id/ship', authorize('vendor'), validate({ params: v.idParams }), controller.ship);

/**
 * @openapi
 * /orders/sub-orders/{id}/confirm-delivery:
 *   post:
 *     tags: [Fulfilment]
 *     summary: Buyer confirms delivery; the sub-order completes and escrow is released
 *     description: |
 *       SHIPPED -> DELIVERED -> COMPLETED in one transaction. One ledger transaction moves the
 *       escrow: subtotal minus commission to the vendor's wallet, the commission (the rate
 *       recorded on the sub-order at checkout, default 5%) to PLATFORM_REVENUE.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: The sub-order, now COMPLETED }
 *       404: { description: Not found, or not yours }
 *       409: { description: "INVALID_STATE (not SHIPPED; includes a second confirmation)" }
 */
router.post('/sub-orders/:id/confirm-delivery', validate({ params: v.idParams }), controller.confirmDelivery);

/**
 * @openapi
 * /orders/sub-orders/{id}/cancel:
 *   post:
 *     tags: [Fulfilment]
 *     summary: Buyer cancels a sub-order that has not shipped yet (escrow refunded, stock restored)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: The sub-order, now CANCELLED }
 *       404: { description: Not found, or not yours }
 *       409: { description: "CANNOT_CANCEL (already shipped or finished) or ORDER_NOT_READY" }
 */
router.post('/sub-orders/:id/cancel', validate({ params: v.idParams }), controller.cancel);

/**
 * @openapi
 * /orders/sub-orders/{id}/dispute:
 *   post:
 *     tags: [Disputes]
 *     summary: Buyer opens a dispute on a shipped sub-order (freezes its escrow)
 *     description: |
 *       Allowed while the sub-order is SHIPPED (or DELIVERED). It becomes DISPUTED: the vendor is not
 *       paid, the buyer cannot cancel or confirm, and the auto-complete job skips it until an admin
 *       resolves the dispute. Evidence is a list of text notes and image URLs (max 10).
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason: { type: string, minLength: 10, maxLength: 2000 }
 *               evidence:
 *                 type: array
 *                 maxItems: 10
 *                 items:
 *                   type: object
 *                   required: [type, value]
 *                   properties:
 *                     type: { type: string, enum: [text, image] }
 *                     value: { type: string, description: "Text, or an http(s) image URL" }
 *     responses:
 *       201: { description: The dispute }
 *       404: { description: Not found, or not yours }
 *       409: { description: "CANNOT_DISPUTE (not shipped) or DISPUTE_EXISTS" }
 */
router.post('/sub-orders/:id/dispute', validate({ params: v.idParams, body: v.disputeBody }), controller.openDispute);

/**
 * @openapi
 * /orders/{id}:
 *   get:
 *     tags: [Orders]
 *     summary: One order with its sub-orders and items (the buyer, or an admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Order }
 *       404: { description: Not found, or not yours }
 */
router.get('/:id', validate({ params: v.idParams }), controller.getOne);

module.exports = router;
