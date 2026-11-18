const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const controller = require('./wallet.controller');
const v = require('./wallet.validation');

const router = Router();

// Every wallet route is about the logged-in user's OWN wallet: there is no id in the URL, so
// one user can never ask for another user's balance.
router.use(authenticate);

/**
 * @openapi
 * /wallet:
 *   get:
 *     tags: [Wallet]
 *     summary: My wallet balance (integer kobo)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ wallet: { id, currency, balanceKobo, balanceDisplay, status } }" }
 *       401: { description: Not authenticated }
 */
router.get('/', controller.getWallet);

/**
 * @openapi
 * /wallet/transactions:
 *   get:
 *     tags: [Wallet]
 *     summary: My ledger history, newest first, with the balance after each entry
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *       - { name: cursor, in: query, description: "nextCursor from the previous page", schema: { type: integer } }
 *       - { name: type, in: query, schema: { type: string, example: WALLET_FUNDING } }
 *       - { name: direction, in: query, schema: { type: string, enum: [debit, credit] } }
 *     responses:
 *       200: { description: "{ transactions: [...], nextCursor }" }
 *       422: { description: Invalid query }
 */
router.get('/transactions', validate({ query: v.listQuery }), controller.listTransactions);

module.exports = router;
