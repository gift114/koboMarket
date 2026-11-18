const { z } = require('zod');
const config = require('../../config');

const fundBody = z
  .object({
    amountKobo: z
      .number({ invalid_type_error: 'amountKobo must be a number' })
      .int('amountKobo must be a whole number of kobo')
      .min(config.payments.fundMinKobo, `The minimum top-up is ${config.payments.fundMinKobo} kobo`)
      .max(config.payments.fundMaxKobo, `The maximum top-up is ${config.payments.fundMaxKobo} kobo`),
  })
  .strict();

const referenceParams = z.object({ reference: z.string().regex(/^[A-Za-z0-9._=-]{8,100}$/, 'invalid reference') });

const mockPayBody = z
  .object({
    outcome: z.enum(['success', 'failed']).default('success'),
    // how many EXTRA times the same webhook is delivered (providers do resend)
    duplicates: z.number().int().min(0).max(10).default(2),
    amountKobo: z.number().int().min(1).optional(), // pay a different amount (to see mismatch handling)
  })
  .strict()
  .default({});

module.exports = { fundBody, referenceParams, mockPayBody };
