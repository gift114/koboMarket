const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const idempotent = require('../idempotency/idempotency.middleware');
const controller = require('./payouts.controller');
const v = require('./payouts.validation');

const router = Router();
router.use(authenticate);

/**
 * @openapi
 * /payouts:
 *   post:
 *     tags: [Payouts]
 *     summary: Vendor requests a payout to their bank account
 *     description: |
 *       Requires an `Idempotency-Key` header. The amount (integer kobo, at least the minimum, N1,000
 *       by default) leaves the wallet immediately for PLATFORM_PAYOUT_CLEARING; a background job
 *       then sends it. A vendor may have only one PENDING payout at a time. If the transfer fails
 *       the money returns to the wallet.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: Idempotency-Key, in: header, required: true, schema: { type: string, minLength: 8, maxLength: 128 } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amountKobo]
 *             properties:
 *               amountKobo: { type: integer, example: 500000 }
 *     responses:
 *       201: { description: "The payout, status PENDING" }
 *       403: { description: "Not an approved vendor" }
 *       409: { description: "INSUFFICIENT_FUNDS, PAYOUT_PENDING_EXISTS, ACCOUNT_NOT_ACTIVE, or an idempotency conflict" }
 *       422: { description: "Below the minimum, or not an integer" }
 */
router.post('/', authorize('vendor'), validate({ body: v.requestBody }), idempotent(), controller.request);

/**
 * @openapi
 * /payouts:
 *   get:
 *     tags: [Payouts]
 *     summary: My payouts, newest first
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: status, in: query, schema: { type: string, enum: [PENDING, SUCCESS, FAILED] } }
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
 *       - { name: cursor, in: query, schema: { type: string } }
 *     responses:
 *       200: { description: "{ payouts: [...], nextCursor }" }
 */
router.get('/', validate({ query: v.listQuery }), controller.list);

/**
 * @openapi
 * /payouts/{id}:
 *   get:
 *     tags: [Payouts]
 *     summary: One payout (its owner, or an admin). The bank account number is masked.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Payout }
 *       404: { description: Not found, or not yours }
 */
router.get('/:id', validate({ params: v.idParams }), controller.getOne);

module.exports = router;
