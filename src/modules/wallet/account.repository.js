const { db } = require('../../config/postgres');
const { OWNER_TYPE } = require('../../db/constants');

const DEFAULT_CURRENCY = 'NGN';

function toDomain(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    currency: row.currency,
    balanceKobo: row.balance_kobo,
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * Create the user's wallet account unless it already exists, and return it. Safe to call any
 * number of times and from several processes at once: the UNIQUE (owner_type, owner_id,
 * currency) constraint plus ON CONFLICT DO NOTHING guarantees exactly one account per user.
 * `trx` lets a caller run this inside its own PostgreSQL transaction.
 */
async function createUserAccountIfMissing(userId, trx = db) {
  await trx.raw(
    `INSERT INTO accounts (owner_type, owner_id, currency)
     VALUES (?, ?, ?)
     ON CONFLICT (owner_type, owner_id, currency) DO NOTHING`,
    [OWNER_TYPE.USER, userId, DEFAULT_CURRENCY],
  );
  return findUserAccount(userId, trx);
}

async function findUserAccount(userId, trx = db) {
  const row = await trx('accounts')
    .where({ owner_type: OWNER_TYPE.USER, owner_id: userId, currency: DEFAULT_CURRENCY })
    .first();
  return toDomain(row);
}

module.exports = { createUserAccountIfMissing, findUserAccount };
