const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const controller = require('./users.controller');
const { updateMeBody } = require('./users.validation');

const router = Router();

/**
 * @openapi
 * /users/me:
 *   get:
 *     tags: [Users]
 *     summary: The logged-in user's profile
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Profile }
 *       401: { description: Missing, invalid, expired or revoked access token }
 *   patch:
 *     tags: [Users]
 *     summary: Update name or phone (email, roles and status cannot be changed here)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fullName: { type: string }
 *               phone: { type: string }
 *     responses:
 *       200: { description: Updated profile }
 *       422: { description: Validation failed }
 */
router.get('/me', authenticate, controller.getMe);
router.patch('/me', authenticate, validate({ body: updateMeBody }), controller.updateMe);

module.exports = router;
