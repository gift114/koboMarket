const { Router } = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const validate = require('../../middlewares/validate');
const v = require('../admin/admin.validation');
const reports = require('./reports.service');

/** Mounted inside the admin router (already authenticated and admin-only). */
const router = Router();

/**
 * @openapi
 * /admin/reports/revenue-by-day:
 *   get:
 *     tags: [Reports]
 *     summary: Platform revenue (commission) per day, last N days (UTC), zero-filled
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: days, in: query, schema: { type: integer, minimum: 1, maximum: 366, default: 30 } }
 *     responses:
 *       200: { description: "{ days, totalKobo, byDay: [{ day, revenueKobo, transactions }] }" }
 */
router.get('/revenue-by-day', validate({ query: v.revenueQuery }), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await reports.revenueByDay(req.query.days) });
}));

/**
 * @openapi
 * /admin/reports/top-vendors:
 *   get:
 *     tags: [Reports]
 *     summary: "Top 10 vendors by earnings in a month (default this month, UTC)"
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: month, in: query, description: "YYYY-MM", schema: { type: string, example: "2026-11" } }
 *     responses:
 *       200: { description: "{ month, vendors: [{ rank, vendorId, storeName, earnedKobo, commissionKobo, subOrders }] }" }
 */
router.get('/top-vendors', validate({ query: v.reportMonthQuery }), asyncHandler(async (req, res) => {
  res.json({ success: true, data: await reports.topVendors(req.query.month) });
}));

/**
 * @openapi
 * /admin/reports/escrow:
 *   get:
 *     tags: [Reports]
 *     summary: Money currently held in escrow, by sub-order status, and whether it matches the escrow account
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ escrowAccountKobo, heldBySubOrdersKobo, inDisputeKobo, inSync, byStatus }" }
 */
router.get('/escrow', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await reports.escrowTotal() });
}));

/**
 * @openapi
 * /admin/reports/reconciliation:
 *   get:
 *     tags: [Reports]
 *     summary: "Reconciliation report: every ledger, order, payout and dispute inconsistency (empty when healthy)"
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ ok, checksRun, discrepancies: [] }" }
 */
router.get('/reconciliation', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await reports.reconciliation() });
}));

module.exports = router;
