const { z } = require('zod');

const objectId = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/, 'must be a valid id')
  .transform((v) => v.toLowerCase());

const idParams = z.object({ id: objectId });

const applyBody = z
  .object({
    storeName: z.string().trim().min(3).max(80),
    description: z.string().trim().max(1000).default(''),
    bankDetails: z
      .object({
        bankName: z.string().trim().min(2).max(60),
        accountNumber: z.string().regex(/^\d{10}$/, 'must be a 10-digit account number'),
        accountName: z.string().trim().min(2).max(100),
      })
      .strict(),
  })
  .strict();

const rejectBody = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

const adminListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: objectId.optional(),
});

module.exports = { idParams, applyBody, rejectBody, adminListQuery };
