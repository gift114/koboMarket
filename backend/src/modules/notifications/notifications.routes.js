const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const controller = require('./notifications.controller');
const v = require('./notifications.validation');

const router = Router();
router.use(authenticate);

/**
 * @openapi
 * /notifications:
 *   get:
 *     tags: [Notifications]
 *     summary: My notifications, newest first (paginated)
 *     description: Created asynchronously after an order is placed or shipped, funds are released, a dispute is opened or resolved, and a payout succeeds or fails.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: unread, in: query, schema: { type: boolean } }
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
 *       - { name: cursor, in: query, schema: { type: string } }
 *     responses:
 *       200: { description: "{ notifications, nextCursor, unreadCount }" }
 */
router.get('/', validate({ query: v.listQuery }), controller.list);

/**
 * @openapi
 * /notifications/unread-count:
 *   get:
 *     tags: [Notifications]
 *     summary: How many unread notifications I have
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ unreadCount }" }
 */
router.get('/unread-count', controller.unreadCount);

/**
 * @openapi
 * /notifications/read-all:
 *   patch:
 *     tags: [Notifications]
 *     summary: Mark all my notifications as read
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ updated } (how many were unread)" }
 */
router.patch('/read-all', controller.markAllRead);

/**
 * @openapi
 * /notifications/{id}/read:
 *   patch:
 *     tags: [Notifications]
 *     summary: Mark one of my notifications as read (idempotent)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: The notification }
 *       404: { description: Not found, or not yours }
 */
router.patch('/:id/read', validate({ params: v.idParams }), controller.markRead);

module.exports = router;
