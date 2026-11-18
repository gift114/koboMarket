const { db } = require('../../config/postgres');

const fromRow = (r) => ({
  id: r.id,
  userId: r.user_id,
  vendorId: r.vendor_id,
  reference: r.reference,
  amountKobo: Number(r.amount_kobo),
  bank: { bankName: r.bank_name, accountNumber: r.account_number, accountName: r.account_name },
  status: r.status,
  provider: r.provider,
  failureReason: r.failure_reason,
  requestTransactionId: r.request_transaction_id,
  settlementTransactionId: r.settlement_transaction_id,
  reversalTransactionId: r.reversal_transaction_id,
  attempts: r.attempts,
  claimedAt: r.claimed_at,
  processedAt: r.processed_at,
  createdAt: r.created_at,
});

async function insert(trx, p) {
  const [row] = await trx('payouts')
    .insert({
      id: p.id,
      user_id: p.userId,
      vendor_id: p.vendorId,
      reference: p.reference,
      amount_kobo: p.amountKobo,
      bank_name: p.bank.bankName,
      account_number: p.bank.accountNumber,
      account_name: p.bank.accountName,
      request_transaction_id: p.requestTransactionId,
    })
    .returning('*');
  return fromRow(row);
}

async function findPendingForUser(trx, userId) {
  const row = await trx('payouts').where({ user_id: userId, status: 'PENDING' }).first();
  return row ? fromRow(row) : null;
}

async function findById(id, trx = db) {
  const row = await trx('payouts').where({ id }).first();
  return row ? fromRow(row) : null;
}

async function lockById(trx, id) {
  const row = await trx('payouts').where({ id }).forUpdate().first();
  return row ? fromRow(row) : null;
}

/**
 * Claim up to `limit` PENDING payouts for this run. FOR UPDATE SKIP LOCKED means two job runs
 * (or two API instances) never take the same row; a claim older than `leaseSeconds` is considered
 * abandoned (the process died) and may be taken again.
 */
async function claimBatch(limit, leaseSeconds) {
  const { rows } = await db.raw(
    `UPDATE payouts SET claimed_at = now(), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM payouts
         WHERE status = 'PENDING' AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => ?))
         ORDER BY created_at
         LIMIT ?
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [leaseSeconds, limit],
  );
  return rows.map(fromRow);
}

/** Give a still-pending payout back so the next run polls it again. */
async function releaseClaim(id) {
  await db('payouts').where({ id, status: 'PENDING' }).update({ claimed_at: null });
}

async function markSuccess(trx, id, { settlementTransactionId, provider }) {
  await trx('payouts').where({ id }).update({ status: 'SUCCESS', settlement_transaction_id: settlementTransactionId, provider, processed_at: trx.fn.now() });
}

async function markFailed(trx, id, { reversalTransactionId, provider, reason }) {
  await trx('payouts').where({ id }).update({ status: 'FAILED', reversal_transaction_id: reversalTransactionId, provider, failure_reason: reason, processed_at: trx.fn.now() });
}

/** Newest first; cursor = (created_at, id). */
async function listByUser(userId, { limit, cursor, status }) {
  const query = db('payouts').where({ user_id: userId });
  if (status) query.where({ status });
  if (cursor) query.whereRaw('(created_at, id) < (?::timestamptz, ?::uuid)', [cursor.createdAt, cursor.id]);
  const rows = await query.orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(limit);
  return rows.map(fromRow);
}

module.exports = { insert, findPendingForUser, findById, lockById, claimBatch, releaseClaim, markSuccess, markFailed, listByUser };
