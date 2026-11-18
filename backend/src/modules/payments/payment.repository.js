const { db } = require('../../config/postgres');

const paymentFromRow = (r) =>
  r && {
    id: r.id,
    userId: r.user_id,
    reference: r.reference,
    provider: r.provider,
    amountKobo: r.amount_kobo,
    currency: r.currency,
    status: r.status,
    authorizationUrl: r.authorization_url,
    failureReason: r.failure_reason,
    ledgerTransactionId: r.ledger_transaction_id,
    paidAt: r.paid_at,
    createdAt: r.created_at,
  };

async function insert(data, trx = db) {
  const [row] = await trx('payments')
    .insert({
      user_id: data.userId,
      reference: data.reference,
      provider: data.provider,
      amount_kobo: data.amountKobo,
    })
    .returning('*');
  return paymentFromRow(row);
}

async function findByReference(reference, trx = db) {
  return paymentFromRow(await trx('payments').where({ reference }).first());
}

/** Lock the payment row: two simultaneous settlements of one payment queue up here. */
async function lockByReference(trx, reference) {
  return paymentFromRow(await trx('payments').where({ reference }).forUpdate().first());
}

async function setAuthorizationUrl(reference, authorizationUrl) {
  await db('payments').where({ reference, status: 'PENDING' }).update({ authorization_url: authorizationUrl });
}

async function markFailed(reference, reason) {
  await db('payments').where({ reference, status: 'PENDING' }).update({ status: 'FAILED', failure_reason: reason });
}

async function markSucceeded(trx, id, ledgerTransactionId) {
  await trx('payments')
    .where({ id, status: 'PENDING' })
    .update({ status: 'SUCCEEDED', ledger_transaction_id: ledgerTransactionId, paid_at: trx.fn.now() });
}

// ---- webhook events ----

const eventFromRow = (r) =>
  r && { id: r.id, provider: r.provider, eventKey: r.event_key, eventType: r.event_type, processedAt: r.processed_at, outcome: r.outcome };

/** Record an incoming event once. `inserted` is false when we have seen this event before. */
async function recordWebhookEvent({ provider, eventKey, eventType, payload }) {
  const inserted = await db.raw(
    `INSERT INTO webhook_events (provider, event_key, event_type, payload)
     VALUES (?, ?, ?, ?::jsonb) ON CONFLICT (provider, event_key) DO NOTHING RETURNING *`,
    [provider, eventKey, eventType, JSON.stringify(payload)],
  );
  if (inserted.rows.length > 0) return { inserted: true, event: eventFromRow(inserted.rows[0]) };
  const existing = await db('webhook_events').where({ provider, event_key: eventKey }).first();
  return { inserted: false, event: eventFromRow(existing) };
}

async function markWebhookProcessed(id, outcome) {
  await db('webhook_events').where({ id }).update({ processed_at: db.fn.now(), outcome });
}

module.exports = {
  insert,
  findByReference,
  lockByReference,
  setAuthorizationUrl,
  markFailed,
  markSucceeded,
  recordWebhookEvent,
  markWebhookProcessed,
};
