const { randomUUID } = require('crypto');
const { db } = require('../../config/postgres');
const AppError = require('../../utils/AppError');
const { assertKobo } = require('../../utils/money');
const { ACCOUNT_STATUS, DIRECTION, SYSTEM_ACCOUNT, OWNER_TYPE, TRANSACTION_STATUS, TRANSACTION_TYPE } = require('../../db/constants');
const ledgerRepository = require('./ledger.repository');

/**
 * The ONLY code that writes to the ledger. Everything that moves money (funding, escrow,
 * refunds, payouts) calls postTransaction / transfer / reverseTransaction, so the rules live
 * in one place:

 * Pass `trx` to make the posting part of a bigger transaction (e.g. order + escrow), otherwise
 * a transaction is opened here.
 */

const DIRECTIONS = Object.values(DIRECTION);
const TYPES = Object.values(TRANSACTION_TYPE);

function insufficientFunds(accountId, available, needed) {
  return AppError.conflict('Insufficient funds', 'INSUFFICIENT_FUNDS', {
    accountId,
    availableKobo: available,
    requiredKobo: needed,
  });
}

/** Throws a 422 for anything that is not a well-formed, balanced set of entries. */
function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length < 2) {
    throw AppError.validation([{ message: 'A transaction needs at least two ledger entries' }], 'Invalid transaction');
  }
  let debits = 0;
  let credits = 0;
  for (const entry of entries) {
    if (!entry || !entry.accountId) throw AppError.validation([{ message: 'Every entry needs an accountId' }]);
    if (!DIRECTIONS.includes(entry.direction)) {
      throw AppError.validation([{ message: `direction must be one of ${DIRECTIONS.join(', ')}` }]);
    }
    assertKobo(entry.amountKobo, 'amountKobo');
    if (entry.amountKobo <= 0) throw AppError.validation([{ message: 'amountKobo must be greater than zero' }]);
    if (entry.direction === DIRECTION.DEBIT) debits += entry.amountKobo;
    else credits += entry.amountKobo;
    if (!Number.isSafeInteger(debits) || !Number.isSafeInteger(credits)) {
      throw AppError.validation([{ message: 'Transaction total is too large' }]);
    }
  }
  if (debits !== credits) {
    throw AppError.validation(
      [{ message: 'Debits must equal credits', debitsKobo: debits, creditsKobo: credits }],
      'Unbalanced transaction',
    );
  }
}

/** A canonical string for a set of entries, to tell a true replay from a key reused for something else. */
function fingerprint(entries) {
  return entries
    .map((e) => `${e.accountId}:${e.direction}:${e.amountKobo}`)
    .sort()
    .join('|');
}

async function replay(trx, existing, entries, type) {
  const stored = await ledgerRepository.findEntries(trx, existing.id);
  if (existing.type !== type || fingerprint(stored) !== fingerprint(entries)) {
    throw AppError.conflict(
      'This idempotency key was already used for a different transaction',
      'IDEMPOTENCY_KEY_REUSED',
    );
  }
  return { transaction: existing, entries: stored, replayed: true };
}

async function postInside(trx, { type, entries, idempotencyKey, reference, reversesTransactionId, metadata = {} }) {
  if (!TYPES.includes(type)) throw AppError.validation([{ message: `Unknown transaction type ${type}` }]);
  validateEntries(entries);

  // Cheap replay check first: a retry of something already done never needs any locks.
  if (idempotencyKey) {
    const existing = await ledgerRepository.findTransactionByIdempotencyKey(trx, idempotencyKey);
    if (existing) return replay(trx, existing, entries, type);
  }

  // Lock every account involved, sorted by id. From here until COMMIT the balances are ours.
  const accountIds = [...new Set(entries.map((e) => e.accountId))];
  const accounts = await ledgerRepository.lockAccounts(trx, accountIds);
  if (accounts.length !== accountIds.length) throw AppError.notFound('Account not found', 'ACCOUNT_NOT_FOUND');

  const byId = new Map(accounts.map((a) => [a.id, a]));
  const net = new Map(); // account id -> signed change (credit +, debit -)
  for (const e of entries) {
    const delta = e.direction === DIRECTION.CREDIT ? e.amountKobo : -e.amountKobo;
    net.set(e.accountId, (net.get(e.accountId) || 0) + delta);
  }

  for (const account of accounts) {
    if (account.status !== ACCOUNT_STATUS.ACTIVE) {
      throw AppError.conflict(`Account is ${account.status.toLowerCase()}`, 'ACCOUNT_NOT_ACTIVE', {
        accountId: account.id,
        status: account.status,
      });
    }
  }
  const currencies = new Set(accounts.map((a) => a.currency));
  if (currencies.size > 1) throw AppError.validation([{ message: 'All accounts must share one currency' }]);

  for (const [accountId, delta] of net) {
    const account = byId.get(accountId);
    const mayGoNegative = account.ownerType === OWNER_TYPE.SYSTEM && account.ownerId === SYSTEM_ACCOUNT.EXTERNAL;
    if (!mayGoNegative && account.balanceKobo + delta < 0) {
      throw insufficientFunds(accountId, account.balanceKobo, -delta);
    }
  }

  const transaction = await ledgerRepository.insertTransaction(trx, {
    reference: reference || `${type}-${randomUUID()}`,
    type,
    idempotencyKey,
    reversesTransactionId,
    metadata,
  });
  if (!transaction) {
    // Another request inserted the same idempotency key between our check and our insert.
    const existing = await ledgerRepository.findTransactionByIdempotencyKey(trx, idempotencyKey);
    return replay(trx, existing, entries, type);
  }

  const stored = await ledgerRepository.insertEntries(trx, transaction.id, entries);
  return { transaction, entries: stored, replayed: false };
}

/** Run `work` inside the caller's transaction, or open one. */
function inTransaction(trx, work) {
  return trx ? work(trx) : db.transaction(work);
}

/** Translate low-level database errors into API errors. */
function translateDbError(err) {
  if (err.code === '23514' && err.constraint === 'accounts_balance_nonneg_chk') {
    return AppError.conflict('Insufficient funds', 'INSUFFICIENT_FUNDS');
  }
  if (err.code === '23505' && err.constraint === 'transactions_reference_unique') {
    return AppError.conflict('That transaction reference is already used', 'REFERENCE_TAKEN');
  }
  if (err.code === '23505' && err.constraint === 'transactions_one_reversal_per_transaction') {
    return AppError.conflict('This transaction has already been reversed', 'ALREADY_REVERSED');
  }
  return err;
}

/**
 * Post a balanced set of entries.
 * @param {object} p
 * @param {string} p.type one of TRANSACTION_TYPE
 * @param {{accountId:string, direction:'debit'|'credit', amountKobo:number}[]} p.entries
 * @param {string} [p.idempotencyKey] same key + same entries => the original result, no new posting
 * @param {string} [p.reference] unique human-readable reference (generated if omitted)
 * @param {object} [p.metadata]
 * @param {object} [p.trx] join an existing knex transaction
 * @returns {Promise<{transaction, entries, replayed:boolean}>}
 */
async function postTransaction({ trx, ...spec }) {
  try {
    return await inTransaction(trx, (t) => postInside(t, spec));
  } catch (err) {
    throw translateDbError(err);
  }
}

/** Move `amountKobo` from one account to another (two-leg transaction). */
async function transfer({ fromAccountId, toAccountId, amountKobo, type = TRANSACTION_TYPE.ADJUSTMENT, ...rest }) {
  if (fromAccountId === toAccountId) {
    throw AppError.validation([{ message: 'Cannot transfer to the same account' }]);
  }
  return postTransaction({
    type,
    ...rest,
    entries: [
      { accountId: fromAccountId, direction: DIRECTION.DEBIT, amountKobo },
      { accountId: toAccountId, direction: DIRECTION.CREDIT, amountKobo },
    ],
  });
}

/**
 * Undo a posted transaction by posting a NEW one with every direction flipped. The original
 * is never edited (apart from its status becoming REVERSED). Rules:
 *   - only POSTED transactions can be reversed, and each one only once (DB unique index too);
 *   - a reversal cannot itself be reversed;
 *   - it fails with INSUFFICIENT_FUNDS if the money has already been spent.
 */
async function reverseTransaction({ transactionId, reason, idempotencyKey, trx }) {
  try {
    return await inTransaction(trx, async (t) => {
      const original = await ledgerRepository.lockTransaction(t, transactionId);
      if (!original) throw AppError.notFound('Transaction not found', 'TRANSACTION_NOT_FOUND');

      if (idempotencyKey) {
        const existing = await ledgerRepository.findTransactionByIdempotencyKey(t, idempotencyKey);
        if (existing && existing.reversesTransactionId === original.id) {
          return { transaction: existing, entries: await ledgerRepository.findEntries(t, existing.id), replayed: true };
        }
      }

      if (original.type === TRANSACTION_TYPE.REVERSAL) {
        throw AppError.conflict('A reversal cannot be reversed', 'CANNOT_REVERSE_A_REVERSAL');
      }
      if (original.status === TRANSACTION_STATUS.REVERSED) {
        throw AppError.conflict('This transaction has already been reversed', 'ALREADY_REVERSED');
      }
      if (original.status !== TRANSACTION_STATUS.POSTED) {
        throw AppError.conflict(`Only posted transactions can be reversed (this one is ${original.status})`, 'INVALID_STATE');
      }

      const originalEntries = await ledgerRepository.findEntries(t, original.id);
      const result = await postInside(t, {
        type: TRANSACTION_TYPE.REVERSAL,
        reference: `REV-${original.reference}`,
        idempotencyKey,
        reversesTransactionId: original.id,
        entries: originalEntries.map((e) => ({
          accountId: e.accountId,
          direction: e.direction === DIRECTION.DEBIT ? DIRECTION.CREDIT : DIRECTION.DEBIT,
          amountKobo: e.amountKobo,
        })),
        metadata: { reason: reason || null, description: `Reversal of ${original.reference}` },
      });
      await ledgerRepository.markReversed(t, original.id);
      return result;
    });
  } catch (err) {
    throw translateDbError(err);
  }
}

module.exports = { postTransaction, transfer, reverseTransaction, validateEntries };
