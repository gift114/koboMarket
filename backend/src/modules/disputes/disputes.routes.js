const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const controller = require('./disputes.controller');
const v = require('./disputes.validation');

const router = Router();
router.use(authenticate);

/**
 * @openapi
 * /disputes:
 *   get:
 *     tags: [Disputes]
 *     summary: Disputes I am part of (as buyer or vendor); an admin sees all
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: status, in: query, schema: { type: string, enum: [OPEN, RESOLVED] } }
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
 *       - { name: cursor, in: query, schema: { type: string } }
 *     responses:
 *       200: { description: "{ disputes: [...], nextCursor }" }
 */
router.get('/', validate({ query: v.listQuery }), controller.list);

/**
 * @openapi
 * /disputes/{id}:
 *   get:
 *     tags: [Disputes]
 *     summary: One dispute (its buyer, its vendor, or an admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Dispute with evidence and, once resolved, the resolution }
 *       404: { description: Not found, or not yours }
 */
router.get('/:id', validate({ params: v.idParams }), controller.getOne);

/**
 * @openapi
 * /disputes/{id}/resolve:
 *   post:
 *     tags: [Disputes]
 *     summary: Admin resolves a dispute (full refund, partial refund or reject)
 *     description: |
 *       Settles the frozen escrow in one ledger transaction and records the admin and the note.
 *       FULL_REFUND returns everything to the buyer (sub-order REFUNDED). PARTIAL_REFUND returns
 *       `refundKobo` to the buyer and pays the rest to the vendor, with commission on the vendor's
 *       part only. REJECT releases everything to the vendor as a normal completion.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [resolution, note]
 *             properties:
 *               resolution: { type: string, enum: [FULL_REFUND, PARTIAL_REFUND, REJECT] }
 *               refundKobo: { type: integer, description: "Required for PARTIAL_REFUND: must be less than the escrow in dispute" }
 *               note: { type: string }
 *     responses:
 *       200: { description: The resolved dispute }
 *       403: { description: Not an admin }
 *       409: { description: DISPUTE_ALREADY_RESOLVED }
 */
router.post('/:id/resolve', authorize('admin'), validate({ params: v.idParams, body: v.resolveBody }), controller.resolve);

module.exports = router;
