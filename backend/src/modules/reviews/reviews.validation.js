const { z } = require('zod');

const createBody = z
  .object({
    rating: z.number().int().min(1).max(5),
    title: z.string().trim().max(100).default(''),
    comment: z.string().trim().max(1000).default(''),
  })
  .strict();

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().regex(/^[a-fA-F0-9]{24}$/, 'must be a valid cursor').transform((v) => v.toLowerCase()).optional(),
});

module.exports = { createBody, listQuery };
