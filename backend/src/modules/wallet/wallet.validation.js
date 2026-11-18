const { z } = require('zod');
const { DIRECTION, TRANSACTION_TYPE } = require('../../db/constants');

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Cursor = the id of the last entry of the previous page (ids are bigint identities).
  cursor: z.coerce.number().int().positive().optional(),
  type: z.enum(Object.values(TRANSACTION_TYPE)).optional(),
  direction: z.enum(Object.values(DIRECTION)).optional(),
});

module.exports = { listQuery };
