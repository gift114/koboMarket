const { db } = require('../../config/postgres');

const fromRow = (r) =>
  r && {
    id: r.id,
    userId: r.user_id,
    key: r.key,
    requestHash: r.request_hash,
    status: r.status,
    responseStatus: r.response_status,
    responseBody: r.response_body,
  };

/**
 * Try to claim (user, key). Returns { claimed: true, record } if this request now owns the
 * key, or { claimed: false, record } with the record that already exists. The UNIQUE
 * constraint decides a tie between two simultaneous requests: exactly one insert wins.
 */
async function claim(userId, key, requestHash, { ttlHours }) {
  await db('idempotency_keys').where({ user_id: userId, key }).where('expires_at', '<', db.fn.now()).del();

  const inserted = await db.raw(
    `INSERT INTO idempotency_keys (user_id, key, request_hash, expires_at)
     VALUES (?, ?, ?, now() + (? || ' hours')::interval)
     ON CONFLICT (user_id, key) DO NOTHING
     RETURNING *`,
    [userId, key, requestHash, String(ttlHours)],
  );
  if (inserted.rows.length > 0) return { claimed: true, record: fromRow(inserted.rows[0]) };

  const existing = await db('idempotency_keys').where({ user_id: userId, key }).first();
  return { claimed: false, record: fromRow(existing) };
}

/**
 * An IN_PROGRESS request whose owner seems to have died (older than the lock time) can be
 * taken over. Atomic: of two simultaneous takeovers only one UPDATE matches.
 */
async function takeOver(id, { lockSeconds }) {
  const result = await db.raw(
    `UPDATE idempotency_keys SET locked_at = now()
      WHERE id = ? AND status = 'IN_PROGRESS' AND locked_at < now() - (? || ' seconds')::interval
      RETURNING id`,
    [id, String(lockSeconds)],
  );
  return result.rows.length > 0;
}

async function complete(id, responseStatus, responseBody) {
  await db('idempotency_keys')
    .where({ id })
    .update({ status: 'COMPLETED', response_status: responseStatus, response_body: JSON.stringify(responseBody) });
}

/** The request failed: forget the key so the client can retry it (only if still unfinished). */
async function release(id) {
  await db('idempotency_keys').where({ id, status: 'IN_PROGRESS' }).del();
}

module.exports = { claim, takeOver, complete, release };
