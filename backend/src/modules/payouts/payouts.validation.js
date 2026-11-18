const { z } = require('zod');

const requestBody = z.object({ amountKobo: z.number().int().min(1).max(100_000_000_000) }).strict();
const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  status: z.enum(['PENDING', 'SUCCESS', 'FAILED']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(300).optional(),
});

module.exports = { requestBody, idParams, listQuery };
