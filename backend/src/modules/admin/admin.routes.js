const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const vendorsController = require('../vendors/vendors.controller');
const vendorsValidation = require('../vendors/vendors.validation');
const adminController = require('./admin.controller');
const v = require('./admin.validation');

const router = Router();

// Every route below this line is admin-only. Roles are enforced here, once, by middleware.
router.use(authenticate, authorize('admin'));

/**
 * @openapi
 * /admin/vendors:
 *   get:
 *     tags: [Admin]
 *     summary: List vendor applications (newest first, cursor pagination)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: status, in: query, schema: { type: string, enum: [pending, approved, rejected] } }
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *       - { name: cursor, in: query, description: "nextCursor from the previous page", schema: { type: string } }
 *     responses:
 *       200: { description: Page of applications plus nextCursor (null on the last page) }
 *       403: { description: Not an admin }
 */
router.get('/vendors', validate({ query: vendorsValidation.adminListQuery }), vendorsController.adminList);

/**
 * @openapi
 * /admin/vendors/{id}/approve:
 *   patch:
 *     tags: [Admin]
 *     summary: Approve a vendor application and grant the vendor role
 *     description: Idempotent. Approving an already-approved vendor re-applies the role.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Approved }
 *       403: { description: Not an admin }
 *       404: { description: Application not found }
 *       409: { description: Application is not pending }
 */
router.patch('/vendors/:id/approve', validate({ params: vendorsValidation.idParams }), vendorsController.approve);

/**
 * @openapi
 * /admin/vendors/{id}/reject:
 *   patch:
 *     tags: [Admin]
 *     summary: Reject a pending vendor application (a reason is required)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason: { type: string }
 *     responses:
 *       200: { description: Rejected }
 *       403: { description: Not an admin }
 *       409: { description: Application is not pending }
 */
router.patch(
  '/vendors/:id/reject',
  validate({ params: vendorsValidation.idParams, body: vendorsValidation.rejectBody }),
  vendorsController.reject,
);

/**
 * @openapi
 * /admin/users:
 *   get:
 *     tags: [Admin]
 *     summary: List and search users (newest first, cursor pagination)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: q, in: query, description: "Text in the email or name (case-insensitive)", schema: { type: string } }
 *       - { name: role, in: query, schema: { type: string, enum: [buyer, vendor, admin] } }
 *       - { name: status, in: query, schema: { type: string, enum: [active, frozen] } }
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *       - { name: cursor, in: query, schema: { type: string } }
 *     responses:
 *       200: { description: "{ users, nextCursor }" }
 *       403: { description: Not an admin }
 */
router.get('/users', validate({ query: v.usersQuery }), adminController.listUsers);

/**
 * @openapi
 * /admin/users/{id}/freeze:
 *   patch:
 *     tags: [Admin]
 *     summary: Freeze a user (cannot place orders or request payouts; can still log in)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The user (idempotent) }
 *       404: { description: User not found }
 *       409: { description: "CANNOT_FREEZE_SELF or CANNOT_FREEZE_ADMIN" }
 */
router.patch('/users/:id/freeze', validate({ params: v.userIdParams }), adminController.freeze);

/**
 * @openapi
 * /admin/users/{id}/unfreeze:
 *   patch:
 *     tags: [Admin]
 *     summary: Unfreeze a user
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The user }
 *       404: { description: User not found }
 */
router.patch('/users/:id/unfreeze', validate({ params: v.userIdParams }), adminController.unfreeze);

/**
 * @openapi
 * /admin/wallets/{userId}:
 *   get:
 *     tags: [Admin]
 *     summary: Any user's wallet balance and status
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: userId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Wallet }
 *       404: { description: User not found }
 */
router.get('/wallets/:id', validate({ params: v.userIdParams }), adminController.getWallet);

/**
 * @openapi
 * /admin/wallets/{userId}/ledger:
 *   get:
 *     tags: [Admin]
 *     summary: Any user's ledger history with the running balance after each entry
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: userId, in: path, required: true, schema: { type: string } }
 *       - { name: type, in: query, schema: { type: string } }
 *       - { name: direction, in: query, schema: { type: string, enum: [debit, credit] } }
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
 *       - { name: cursor, in: query, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ transactions, nextCursor }" }
 *       404: { description: User not found }
 */
router.get('/wallets/:id/ledger', validate({ params: v.userIdParams, query: v.ledgerQuery }), adminController.getLedger);

/**
 * @openapi
 * /admin/settings/commission:
 *   get:
 *     tags: [Admin]
 *     summary: The commission rate that applies to new orders
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ commission: { rateBps, ratePercent, source: admin|default, updatedBy, updatedAt } }" }
 *   put:
 *     tags: [Admin]
 *     summary: Set the commission rate for NEW orders (basis points, 0 to 5000; 500 = 5%)
 *     description: Orders already placed keep the rate they were placed with. Every change is recorded in an append-only history.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rateBps]
 *             properties:
 *               rateBps: { type: integer, minimum: 0, maximum: 5000, example: 750 }
 *     responses:
 *       200: { description: The new setting }
 *       422: { description: Not an integer between 0 and 5000 }
 */
router.get('/settings/commission', adminController.getCommission);
router.put('/settings/commission', validate({ body: v.commissionBody }), adminController.setCommission);

router.use('/reports', require('../reports/reports.routes'));

module.exports = router;
