const { z } = require('zod');

const objectId = z.string().regex(/^[a-f0-9]{24}$/, 'Invalid id');
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: objectId.optional(),
  unread: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
const idParams = z.object({ id: objectId });

module.exports = { listQuery, idParams };
