const { z } = require('zod');
const { listQuery: ledgerQuery } = require('../wallet/wallet.validation');

const objectId = z.string().regex(/^[a-f0-9]{24}$/, 'Invalid id');

const usersQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  role: z.enum(['buyer', 'vendor', 'admin']).optional(),
  status: z.enum(['active', 'frozen']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: objectId.optional(),
});
const userIdParams = z.object({ id: objectId });
const commissionBody = z.object({ rateBps: z.number().int().min(0).max(5000) }).strict(); // 0% .. 50%
const reportMonthQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM').optional() });
const revenueQuery = z.object({ days: z.coerce.number().int().min(1).max(366).default(30) });

module.exports = { usersQuery, userIdParams, commissionBody, ledgerQuery, reportMonthQuery, revenueQuery };
