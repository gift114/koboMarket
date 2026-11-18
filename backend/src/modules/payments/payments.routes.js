const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const idempotent = require('../idempotency/idempotency.middleware');
const controller = require('./payments.controller');
const v = require('./payments.validation');

/** Mounted under /wallet (see routes/index.js), after the wallet router. */
const walletFunding = Router();
walletFunding.use(authenticate);

/**
 * @openapi
 * /wallet/fund:
 *   post:
 *     tags: [Wallet]
 *     summary: Start a wallet top-up (returns a checkout URL; no money moves yet)
 *     description: |
 *       Requires an `Idempotency-Key` header. The same key with the same body returns the original
 *       response; the same key with a different body is 409. The wallet is credited only after the
 *       provider confirms the payment (webhook) and we re-verify it.
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
 *               amountKobo: { type: integer, example: 500000, description: "integer kobo (500000 = N5,000)" }
 *     responses:
 *       201: { description: "{ payment: { reference, status: PENDING, authorizationUrl, ... } }" }
 *       400: { description: Missing or malformed Idempotency-Key }
 *       409: { description: Key reused for a different request, or still in progress }
 *       422: { description: Invalid amount }
 *       502: { description: Payment provider error }
 */
walletFunding.post('/fund', validate({ body: v.fundBody }), idempotent(), controller.fund);

/**
 * @openapi
 * /wallet/fund/{reference}:
 *   get:
 *     tags: [Wallet]
 *     summary: Status of one of my top-ups (also the Paystack callback URL)
 *     description: If the payment is still PENDING this asks the provider and credits the wallet if it was paid (a fallback for a missed webhook). Crediting is idempotent.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: reference, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Payment }
 *       404: { description: Not found (or not yours) }
 */
walletFunding.get('/fund/:reference', validate({ params: v.referenceParams }), controller.getFunding);

const webhooks = Router();
/**
 * @openapi
 * /webhooks/paystack:
 *   post:
 *     tags: [Webhooks]
 *     summary: Paystack webhook (signature required)
 *     description: |
 *       Verifies `x-paystack-signature` = HMAC SHA512 of the raw body with the secret key; anything
 *       unsigned or wrongly signed is 401. Duplicate deliveries are acknowledged and ignored. On
 *       `charge.success` the transaction is re-verified with Paystack before the wallet is credited.
 *     responses:
 *       200: { description: Acknowledged }
 *       401: { description: Invalid signature }
 */
webhooks.post('/paystack', controller.paystackWebhook);

/** Mock gateway "pay" page, mounted only for PAYMENT_PROVIDER=mock outside production. */
const mockGateway = Router();
/**
 * @openapi
 * /dev/mock-payments/{reference}/pay:
 *   post:
 *     tags: [Webhooks]
 *     summary: "DEV ONLY - simulate the customer paying (or failing) a mock top-up"
 *     description: |
 *       Exists only when PAYMENT_PROVIDER=mock and NODE_ENV is not production. Marks the mock payment
 *       paid or failed, then delivers the signed webhook (plus `duplicates` extra copies) to the real
 *       webhook endpoint, so the whole funding flow can be demoed without Paystack.
 *     parameters:
 *       - { name: reference, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               outcome: { type: string, enum: [success, failed], default: success }
 *               duplicates: { type: integer, minimum: 0, maximum: 10, default: 2 }
 *               amountKobo: { type: integer, description: "pay a different amount to see mismatch handling" }
 *     responses:
 *       200: { description: Webhook deliveries and their results }
 *       404: { description: Unknown mock payment }
 */
mockGateway.post('/mock-payments/:reference/pay', validate({ params: v.referenceParams, body: v.mockPayBody }), controller.mockPay);

module.exports = { walletFunding, webhooks, mockGateway };
