const { randomUUID } = require('crypto');
const { db } = require('../../src/config/postgres');
const { OWNER_TYPE, SYSTEM_ACCOUNT, DIRECTION, TRANSACTION_STATUS, TRANSACTION_TYPE } = require('../../src/db/constants');

// Test-only helpers. The real ledger service is built on Day 5.

function newObjectId() {
  return require('crypto').randomBytes(12).toString('hex');
}

async function createUserAccount(trx = db) {
  const [account] = await trx('accounts')
    .insert({ owner_type: OWNER_TYPE.USER, owner_id: newObjectId() })
    .returning('*');
  return account;
}

async function systemAccountId(code, trx = db) {
  const row = await trx('accounts').where({ owner_type: OWNER_TYPE.SYSTEM, owner_id: code }).first('id');
  return row.id;
}

async function getAccount(id, trx = db) {
  return trx('accounts').where({ id }).first();
}

/** Insert a POSTED transaction and its entries. Entries: [{ account, direction, amount }]. */
async function post(trx, { type = TRANSACTION_TYPE.ADJUSTMENT, entries, reference, idempotencyKey, metadata = {} }) {
  const [tx] = await trx('transactions')
    .insert({
      reference: reference || `T-${randomUUID()}`,
      type,
      status: TRANSACTION_STATUS.POSTED,
      idempotency_key: idempotencyKey || null,
      metadata,
    })
    .returning('*');
  await trx('ledger_entries').insert(
    entries.map((e) => ({
      transaction_id: tx.id,
      account_id: e.account,
      direction: e.direction,
      amount_kobo: e.amount,
    })),
  );
  return tx;
}

/** Fund a user account from the outside world: debit EXTERNAL, credit the account. */
async function fund(accountId, amountKobo) {
  const external = await systemAccountId(SYSTEM_ACCOUNT.EXTERNAL);
  return db.transaction((trx) =>
    post(trx, {
      type: TRANSACTION_TYPE.WALLET_FUNDING,
      entries: [
        { account: external, direction: DIRECTION.DEBIT, amount: amountKobo },
        { account: accountId, direction: DIRECTION.CREDIT, amount: amountKobo },
      ],
    }),
  );
}

async function reconciliationFor(accountId) {
  return db('account_reconciliation').where({ account_id: accountId }).first();
}

module.exports = { db, newObjectId, createUserAccount, systemAccountId, getAccount, post, fund, reconciliationFor };
