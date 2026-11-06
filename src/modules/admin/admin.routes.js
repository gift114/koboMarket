const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const vendorsController = require('../vendors/vendors.controller');
const vendorsValidation = require('../vendors/vendors.validation');

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

module.exports = router;
