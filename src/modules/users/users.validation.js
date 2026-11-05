const { z } = require('zod');

// Only profile fields. .strict() rejects attempts to send email, roles or status.
const updateMeBody = z
  .object({
    fullName: z.string().trim().min(2).max(100).optional(),
    phone: z.string().trim().regex(/^\+?[0-9]{7,15}$/, 'must be 7-15 digits, optional leading +').optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Provide at least one field to update' });

module.exports = { updateMeBody };
