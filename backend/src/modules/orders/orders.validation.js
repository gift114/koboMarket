const { z } = require('zod');

const checkoutBody = z
  .object({
    // Optional safety check: "I agreed to pay this much". If the live total differs, checkout stops with 409 PRICE_CHANGED.
    expectedTotalKobo: z.number().int().min(1).optional(),
  })
  .strict();

const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(300).optional(),
});

const salesQuery = listQuery.extend({
  status: z.enum(['PAID', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'DISPUTED', 'REFUNDED']).optional(),
});

const { openBody: disputeBody } = require('../disputes/disputes.validation');

module.exports = { disputeBody, checkoutBody, idParams, listQuery, salesQuery };
