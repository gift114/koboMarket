const { z } = require('zod');

const evidenceItem = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal('image'), value: z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL') }).strict(),
]);

const openBody = z
  .object({
    reason: z.string().trim().min(10).max(2000),
    evidence: z.array(evidenceItem).max(10).default([]),
  })
  .strict();

const resolveBody = z
  .object({
    resolution: z.enum(['FULL_REFUND', 'PARTIAL_REFUND', 'REJECT']),
    // Kobo returned to the buyer. Required (and only allowed) for PARTIAL_REFUND.
    refundKobo: z.number().int().min(1).max(100_000_000_000).optional(),
    note: z.string().trim().min(3).max(2000),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.resolution === 'PARTIAL_REFUND' && b.refundKobo === undefined) {
      ctx.addIssue({ code: 'custom', path: ['refundKobo'], message: 'refundKobo is required for a partial refund' });
    }
    if (b.resolution !== 'PARTIAL_REFUND' && b.refundKobo !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['refundKobo'], message: 'refundKobo is only allowed for a partial refund' });
    }
  });

const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  status: z.enum(['OPEN', 'RESOLVED']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(300).optional(),
});

module.exports = { openBody, resolveBody, idParams, listQuery };
