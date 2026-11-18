/**
 * Raw PostgreSQL access for the ledger. Every function takes the knex transaction (`trx`) it
 * must run in, so a service can combine several of them (and rows from other modules, like
 * orders) in ONE database transaction.
 */

function accountFromRow(row) {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    currency: row.currency,
    balanceKobo: row.balance_kobo,
    status: row.status,
  };
}

function transactionFromRow(row) {
  return {
    id: row.id,
    reference: row.reference,
    type: row.type,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    reversesTransactionId: row.reverses_transaction_id,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

function entryFromRow(row) {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    accountId: row.account_id,
    direction: row.direction,
    amountKobo: row.amount_kobo,
    createdAt: row.created_at,
  };
}

/**
 * SELECT ... FOR UPDATE the given accounts, always in ascending id order. Two transactions
 * that touch the same accounts therefore queue up instead of deadlocking, and the balance
 * read after this call cannot change until the transaction ends.
 */
async function lockAccounts(trx, accountIds) {
  const rows = await trx('accounts').whereIn('id', accountIds).orderBy('id').forUpdate();
  return rows.map(accountFromRow);
}

async function findTransactionByIdempotencyKey(trx, idempotencyKey) {
  const row = await trx('transactions').where({ idempotency_key: idempotencyKey }).first();
  return row ? transactionFromRow(row) : null;
}

/** Lock one transaction row, so concurrent reversals of it are serialised. */
async function lockTransaction(trx, transactionId) {
  const row = await trx('transactions').where({ id: transactionId }).forUpdate().first();
  return row ? transactionFromRow(row) : null;
}

/**
 * Insert a POSTED transaction header. Returns null when the idempotency key already exists
 * (someone else posted it first), which the service treats as a replay.
 */
async function insertTransaction(trx, { reference, type, idempotencyKey, reversesTransactionId, metadata }) {
  const rows = await trx('transactions')
    .insert({
      reference,
      type,
      status: 'POSTED',
      idempotency_key: idempotencyKey || null,
      reverses_transaction_id: reversesTransactionId || null,
      metadata,
    })
    .onConflict('idempotency_key')
    .ignore()
    .returning('*');
  return rows.length > 0 ? transactionFromRow(rows[0]) : null;
}

async function insertEntries(trx, transactionId, entries) {
  const rows = await trx('ledger_entries')
    .insert(
      entries.map((e) => ({
        transaction_id: transactionId,
        account_id: e.accountId,
        direction: e.direction,
        amount_kobo: e.amountKobo,
      })),
    )
    .returning('*');
  return rows.map(entryFromRow);
}

async function findEntries(trx, transactionId) {
  const rows = await trx('ledger_entries').where({ transaction_id: transactionId }).orderBy('id');
  return rows.map(entryFromRow);
}

// POSTED -> REVERSED. The only status change a posted transaction may make.
async function markReversed(trx, transactionId) {
  await trx('transactions').where({ id: transactionId }).update({ status: 'REVERSED' });
}

/**
 * Ledger history of one account, newest first, with the balance after each entry.
 *
 * The running balance is a window function over the account's WHOLE history, and the type /
 * direction / cursor filters are applied afterwards, so filtering never distorts it. Computed
 * in SQL, never in a JavaScript loop.
 */
async function listEntriesForAccount(trx, accountId, { limit, cursor, type, direction }) {
  const history = trx('ledger_entries as e')
    .join('transactions as t', 't.id', 'e.transaction_id')
    .where('e.account_id', accountId)
    .select(
      'e.id',
      'e.transaction_id',
      'e.direction',
      'e.amount_kobo',
      'e.created_at',
      't.reference',
      't.type',
      't.status',
      trx.raw("t.metadata->>'description' as description"),
      trx.raw(
        "(SUM(CASE e.direction WHEN 'credit' THEN e.amount_kobo ELSE -e.amount_kobo END) OVER (ORDER BY e.id))::bigint as balance_after_kobo",
      ),
    );

  const query = trx.select('*').from(history.as('h'));
  if (cursor) query.where('h.id', '<', cursor);
  if (type) query.where('h.type', type);
  if (direction) query.where('h.direction', direction);

  const rows = await query.orderBy('h.id', 'desc').limit(limit);
  return rows.map((row) => ({
    id: row.id,
    transactionId: row.transaction_id,
    reference: row.reference,
    type: row.type,
    status: row.status,
    direction: row.direction,
    amountKobo: row.amount_kobo,
    balanceAfterKobo: row.balance_after_kobo,
    description: row.description,
    createdAt: row.created_at,
  }));
}

module.exports = {
  lockAccounts,
  lockTransaction,
  findTransactionByIdempotencyKey,
  insertTransaction,
  insertEntries,
  findEntries,
  markReversed,
  listEntriesForAccount,
};
