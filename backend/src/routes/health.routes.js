const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { pingMongo } = require('../config/mongo');
const { pingPostgres } = require('../config/postgres');
const AppError = require('../utils/AppError');

const router = Router();

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Liveness check (does not touch the databases)
 *     responses:
 *       200:
 *         description: API process is up
 */
router.get('/', (req, res) => {
  res.json({ success: true, data: { status: 'ok', uptimeSeconds: Math.round(process.uptime()) } });
});

/**
 * @openapi
 * /health/ready:
 *   get:
 *     tags: [Health]
 *     summary: Readiness check (MongoDB and PostgreSQL must both respond)
 *     responses:
 *       200:
 *         description: Both databases reachable
 *       503:
 *         description: A database is unreachable
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get(
  '/ready',
  asyncHandler(async (req, res) => {
    const checks = await Promise.allSettled([pingMongo(), pingPostgres()]);
    const [mongo, postgres] = checks.map((c) => (c.status === 'fulfilled' ? 'up' : 'down'));
    if (mongo !== 'up' || postgres !== 'up') {
      throw new AppError(503, 'NOT_READY', 'A dependency is unavailable', { mongo, postgres });
    }
    res.json({ success: true, data: { status: 'ready', mongo, postgres } });
  }),
);

module.exports = router;
