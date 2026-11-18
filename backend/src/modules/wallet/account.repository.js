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

// System accounts are created by a migration and never change id, so cache the lookup.
const systemAccountIds = new Map();

/** Id of PLATFORM_ESCROW / PLATFORM_REVENUE / PLATFORM_PAYOUT_CLEARING / PLATFORM_EXTERNAL. */
async function getSystemAccountId(code, trx = db) {
  if (!systemAccountIds.has(code)) {
    const row = await trx('accounts').where({ owner_type: OWNER_TYPE.SYSTEM, owner_id: code }).first('id');
    if (!row) throw new Error(`System account ${code} is missing: run the database migrations`);
    systemAccountIds.set(code, row.id);
  }
  return systemAccountIds.get(code);
}

module.exports = { createUserAccountIfMissing, findUserAccount, getSystemAccountId };
