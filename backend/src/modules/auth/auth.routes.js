const { Router } = require('express');
const validate = require('../../middlewares/validate');
const { authLimiter } = require('../../middlewares/rateLimiters');
const controller = require('./auth.controller');
const v = require('./auth.validation');

const router = Router();

/**
 * @openapi
 * /auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Create an account (buyer). A verification email is sent.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, fullName]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 8, description: "8-72 bytes, at least one letter and one number" }
 *               fullName: { type: string }
 *               phone: { type: string, example: "+2348012345678" }
 *     responses:
 *       201: { description: Account created }
 *       409: { description: Email already registered }
 *       422: { description: Validation failed }
 */
router.post('/register', authLimiter, validate({ body: v.registerBody }), controller.register);

/**
 * @openapi
 * /auth/verify-email:
 *   post:
 *     tags: [Auth]
 *     summary: Verify an email address with the single-use token from the email confirmation link
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token: { type: string }
 *     responses:
 *       200: { description: Email verified }
 *       400: { description: Token invalid or expired }
 */
router.post('/verify-email', authLimiter, validate({ body: v.verifyEmailBody }), controller.verifyEmail);

/**
 * @openapi
 * /auth/resend-verification:
 *   post:
 *     tags: [Auth]
 *     summary: Send a new verification email (same response whether or not the account exists)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       200: { description: Accepted }
 */
router.post(
  '/resend-verification',
  authLimiter,
  validate({ body: v.resendVerificationBody }),
  controller.resendVerification,
);

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Log in. Returns a 15-minute access token and a 7-day refresh token.
 *     description: Max 5 failed attempts per 15 minutes per email + IP, then 429 with Retry-After.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string }
 *     responses:
 *       200: { description: Logged in }
 *       401: { description: Invalid credentials }
 *       403: { description: Email not verified }
 *       429: { description: Too many failed attempts }
 */
router.post('/login', validate({ body: v.loginBody }), controller.login);

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Exchange a refresh token for a new access + refresh token (rotation)
 *     description: Each refresh token works once. Re-using an old one logs the user out of ALL sessions.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200: { description: New token pair }
 *       401: { description: Invalid, expired or reused refresh token }
 */
router.post('/refresh', validate({ body: v.refreshBody }), controller.refresh);

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Invalidate a refresh token (this session only)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200: { description: Logged out }
 */
router.post('/logout', validate({ body: v.logoutBody }), controller.logout);

/**
 * @openapi
 * /auth/forgot-password:
 *   post:
 *     tags: [Auth]
 *     summary: Email a password reset token (same response whether or not the account exists)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       200: { description: Accepted }
 */
router.post('/forgot-password', authLimiter, validate({ body: v.forgotPasswordBody }), controller.forgotPassword);

/**
 * @openapi
 * /auth/reset-password:
 *   post:
 *     tags: [Auth]
 *     summary: Set a new password using a reset token. Logs the user out of all sessions.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, newPassword]
 *             properties:
 *               token: { type: string }
 *               newPassword: { type: string, minLength: 8 }
 *     responses:
 *       200: { description: Password updated }
 *       400: { description: Token invalid or expired }
 *       422: { description: Weak password }
 */
router.post('/reset-password', authLimiter, validate({ body: v.resetPasswordBody }), controller.resetPassword);

module.exports = router;
