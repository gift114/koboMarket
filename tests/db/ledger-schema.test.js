const { randomUUID } = require('crypto');
const {
  db, newObjectId, createUserAccount, systemAccountId, getAccount, post, fund, reconciliationFor,
} = require('../helpers/ledger');
const { SYSTEM_ACCOUNT, DIRECTION, TRANSACTION_TYPE, TRANSACTION_STATUS } = require('../../src/db/constants');

const { DEBIT, CREDIT } = DIRECTION;

afterAll(async () => {
  await db.destroy();
});

describe('System accounts', () => {
  test('the three required system accounts plus the external account exist after migrating', async () => {
    const rows = await db('accounts').where({ owner_type: 'SYSTEM' }).pluck('owner_id');
    expect(rows.sort()).toEqual(
      ['PLATFORM_ESCROW', 'PLATFORM_EXTERNAL', 'PLATFORM_PAYOUT_CLEARING', 'PLATFORM_REVENUE'].sort(),
    );
  });

  test('an unknown system account cannot be created', async () => {
    await expect(
      db('accounts').insert({ owner_type: 'SYSTEM', owner_id: 'PLATFORM_SECRET_STASH' }),
    ).rejects.toThrow(/accounts_system_owner_id_chk/);
  });

  test('system accounts cannot be deleted', async () => {
    await expect(db('accounts').where({ owner_id: SYSTEM_ACCOUNT.ESCROW }).del()).rejects.toThrow(
      /ACCOUNT_UNDELETABLE/,
    );
  });
});

describe('accounts constraints', () => {
  test('a user account needs a MongoDB ObjectId as owner_id', async () => {
    await expect(db('accounts').insert({ owner_type: 'USER', owner_id: 'not-an-object-id' })).rejects.toThrow(
      /accounts_user_owner_id_chk/,
    );
  });

  test('the same owner cannot have two accounts in one currency', async () => {
    const ownerId = newObjectId();
    await db('accounts').insert({ owner_type: 'USER', owner_id: ownerId });
    await expect(db('accounts').insert({ owner_type: 'USER', owner_id: ownerId })).rejects.toThrow(
      /accounts_owner_unique/,
    );
  });

  test('balance_kobo cannot be edited directly, only through the ledger', async () => {
    const account = await createUserAccount();
    await expect(db('accounts').where({ id: account.id }).update({ balance_kobo: 999999 })).rejects.toThrow(
      /ACCOUNT_BALANCE_PROTECTED/,
    );
    expect((await getAccount(account.id)).balance_kobo).toBe(0);
  });

  test('a user account cannot be created with a negative balance', async () => {
    await expect(
      db('accounts').insert({ owner_type: 'USER', owner_id: newObjectId(), balance_kobo: -1 }),
    ).rejects.toThrow(/accounts_balance_nonneg_chk/);
  });

  test('owner and currency cannot be changed, and status can', async () => {
    const account = await createUserAccount();
    await expect(db('accounts').where({ id: account.id }).update({ currency: 'USD' })).rejects.toThrow(
      /ACCOUNT_IMMUTABLE/,
    );
    await db('accounts').where({ id: account.id }).update({ status: 'FROZEN' });
    expect((await getAccount(account.id)).status).toBe('FROZEN');
  });
});

describe('ledger_entries constraints', () => {
  test('amount_kobo must be greater than zero', async () => {
    const a = await createUserAccount();
    const b = await createUserAccount();
    for (const amount of [0, -500]) {
      await expect(
        db.transaction((trx) =>
          post(trx, {
            entries: [
              { account: a.id, direction: DEBIT, amount },
              { account: b.id, direction: CREDIT, amount },
            ],
          }),
        ),
      ).rejects.toThrow(/ledger_entries_amount_positive_chk/);
    }
  });

  test('direction must be debit or credit', async () => {
    const a = await createUserAccount();
    const b = await createUserAccount();
    await expect(
      db.transaction((trx) =>
        post(trx, {
          entries: [
            { account: a.id, direction: 'sideways', amount: 100 },
            { account: b.id, direction: CREDIT, amount: 100 },
          ],
        }),
      ),
    ).rejects.toThrow(/ledger_entries_direction_chk/);
  });

  test('foreign keys are enforced for account and transaction', async () => {
    const a = await createUserAccount();
    await fund(a.id, 100); // so the debit is valid and only the missing account can fail
    await expect(
      db.transaction((trx) =>
        post(trx, {
          entries: [
            { account: a.id, direction: DEBIT, amount: 100 },
            { account: randomUUID(), direction: CREDIT, amount: 100 },
          ],
        }),
      ),
    ).rejects.toThrow(/foreign key constraint/);

    await expect(
      db('ledger_entries').insert({ transaction_id: randomUUID(), account_id: a.id, direction: DEBIT, amount_kobo: 1 }),
    ).rejects.toThrow(/foreign key constraint/);
  });
});

describe('Double entry is enforced by the database', () => {
  test('an unbalanced transaction is rejected at commit and leaves nothing behind', async () => {
    const external = await systemAccountId(SYSTEM_ACCOUNT.EXTERNAL);
    const account = await createUserAccount();
    const reference = `T-${randomUUID()}`;

    await expect(
      db.transaction((trx) =>
        post(trx, {
          reference,
          entries: [
            { account: external, direction: DEBIT, amount: 1000 },
            { account: account.id, direction: CREDIT, amount: 900 },
          ],
        }),
      ),
    ).rejects.toThrow(/LEDGER_UNBALANCED/);

    expect(await db('transactions').where({ reference }).first()).toBeUndefined();
    expect((await getAccount(account.id)).balance_kobo).toBe(0);
  });

  test('a transaction with a single entry is rejected', async () => {
    const account = await createUserAccount();
    await expect(
      db.transaction((trx) =>
        post(trx, { entries: [{ account: account.id, direction: CREDIT, amount: 500 }] }),
      ),
    ).rejects.toThrow(/LEDGER_TOO_FEW_ENTRIES/);
  });

  test('entries cannot be attached to a PENDING transaction', async () => {
    const external = await systemAccountId(SYSTEM_ACCOUNT.EXTERNAL);
    const account = await createUserAccount();
    await expect(
      db.transaction(async (trx) => {
        const [tx] = await trx('transactions')
          .insert({ reference: `T-${randomUUID()}`, type: TRANSACTION_TYPE.WALLET_FUNDING })
          .returning('*');
        await trx('ledger_entries').insert([
          { transaction_id: tx.id, account_id: external, direction: DEBIT, amount_kobo: 100 },
          { transaction_id: tx.id, account_id: account.id, direction: CREDIT, amount_kobo: 100 },
        ]);
      }),
    ).rejects.toThrow(/LEDGER_TRANSACTION_NOT_POSTED/);
  });

  test('a pending transaction can be posted in the same database transaction as its entries', async () => {
    const external = await systemAccountId(SYSTEM_ACCOUNT.EXTERNAL);
    const account = await createUserAccount();
    await db.transaction(async (trx) => {
      const [tx] = await trx('transactions')
        .insert({ reference: `T-${randomUUID()}`, type: TRANSACTION_TYPE.WALLET_FUNDING })
        .returning('*');
      await trx('ledger_entries').insert([
        { transaction_id: tx.id, account_id: external, direction: DEBIT, amount_kobo: 2500 },
        { transaction_id: tx.id, account_id: account.id, direction: CREDIT, amount_kobo: 2500 },
      ]);
      await trx('transactions').where({ id: tx.id }).update({ status: TRANSACTION_STATUS.POSTED });
    });
    expect((await getAccount(account.id)).balance_kobo).toBe(2500);
  });

  test('a transaction cannot mix currencies', async () => {
    const ngn = await createUserAccount();
    await fund(ngn.id, 100); // so the debit itself is valid and only the currency mix can fail
    const usd = (
      await db('accounts').insert({ owner_type: 'USER', owner_id: newObjectId(), currency: 'USD' }).returning('*')
    )[0];
    await expect(
      db.transaction((trx) =>
        post(trx, {
          entries: [
            { account: ngn.id, direction: DEBIT, amount: 100 },
            { account: usd.id, direction: CREDIT, amount: 100 },
          ],
        }),
      ),
    ).rejects.toThrow(/LEDGER_MIXED_CURRENCY/);
  });
});

describe('Balances', () => {
  test('a balanced movement updates the cached balances and they equal the ledger sums', async () => {
    const account = await createUserAccount();
    const escrow = await systemAccountId(SYSTEM_ACCOUNT.ESCROW);
    await fund(account.id, 500000);

    const escrowBefore = (await getAccount(escrow)).balance_kobo;
    await db.transaction((trx) =>
      post(trx, {
        type: TRANSACTION_TYPE.ORDER_PAYMENT,
        entries: [
          { account: account.id, direction: DEBIT, amount: 120000 },
          { account: escrow, direction: CREDIT, amount: 120000 },
        ],
      }),
    );

    expect((await getAccount(account.id)).balance_kobo).toBe(380000);
    expect((await getAccount(escrow)).balance_kobo).toBe(escrowBefore + 120000);

    const recon = await reconciliationFor(account.id);
    expect(recon.cached_balance_kobo).toBe(380000);
    expect(recon.ledger_balance_kobo).toBe(380000);
  });

  test('a user wallet cannot be overdrawn, and the failed movement leaves no trace', async () => {
    const account = await createUserAccount();
    const escrow = await systemAccountId(SYSTEM_ACCOUNT.ESCROW);
    await fund(account.id, 10000);
    const reference = `T-${randomUUID()}`;

    await expect(
      db.transaction((trx) =>
        post(trx, {
          reference,
          type: TRANSACTION_TYPE.ORDER_PAYMENT,
          entries: [
            { account: account.id, direction: DEBIT, amount: 10001 },
            { account: escrow, direction: CREDIT, amount: 10001 },
          ],
        }),
      ),
    ).rejects.toThrow(/accounts_balance_nonneg_chk/);

    expect((await getAccount(account.id)).balance_kobo).toBe(10000);
    expect(await db('transactions').where({ reference }).first()).toBeUndefined();
    const entries = await db('ledger_entries').where({ account_id: account.id });
    expect(entries).toHaveLength(1); // only the original funding entry
  });

  test('system accounts other than the external account cannot go negative either', async () => {
    const clearing = await systemAccountId(SYSTEM_ACCOUNT.PAYOUT_CLEARING);
    const revenue = await systemAccountId(SYSTEM_ACCOUNT.REVENUE);
    const current = (await getAccount(clearing)).balance_kobo;
    await expect(
      db.transaction((trx) =>
        post(trx, {
          entries: [
            { account: clearing, direction: DEBIT, amount: current + 1 },
            { account: revenue, direction: CREDIT, amount: current + 1 },
          ],
        }),
      ),
    ).rejects.toThrow(/accounts_balance_nonneg_chk/);
  });

  test('the external account goes negative by exactly what was funded in', async () => {
    const external = await systemAccountId(SYSTEM_ACCOUNT.EXTERNAL);
    const account = await createUserAccount();
    const before = (await getAccount(external)).balance_kobo;
    await fund(account.id, 77700);
    expect((await getAccount(external)).balance_kobo).toBe(before - 77700);
  });
});

describe('Ledger is append-only', () => {
  let entryId;

  beforeAll(async () => {
    const account = await createUserAccount();
    await fund(account.id, 1000);
    entryId = (await db('ledger_entries').where({ account_id: account.id }).first()).id;
  });

  test('UPDATE is rejected', async () => {
    await expect(db('ledger_entries').where({ id: entryId }).update({ amount_kobo: 1 })).rejects.toThrow(
      /LEDGER_APPEND_ONLY/,
    );
  });

  test('DELETE is rejected', async () => {
    await expect(db('ledger_entries').where({ id: entryId }).del()).rejects.toThrow(/LEDGER_APPEND_ONLY/);
  });

  test('TRUNCATE is rejected', async () => {
    await expect(db.raw('TRUNCATE ledger_entries')).rejects.toThrow(/LEDGER_APPEND_ONLY/);
  });

  test('a mistake is fixed with a reversing transaction, which keeps the ledger balanced', async () => {
    const account = await createUserAccount();
    const external = await systemAccountId(SYSTEM_ACCOUNT.EXTERNAL);
    const original = await fund(account.id, 4000);

    await db.transaction(async (trx) => {
      const [reversal] = await trx('transactions')
        .insert({
          reference: `T-${randomUUID()}`,
          type: TRANSACTION_TYPE.REVERSAL,
          status: TRANSACTION_STATUS.POSTED,
          reverses_transaction_id: original.id,
        })
        .returning('*');
      await trx('ledger_entries').insert([
        { transaction_id: reversal.id, account_id: account.id, direction: DEBIT, amount_kobo: 4000 },
        { transaction_id: reversal.id, account_id: external, direction: CREDIT, amount_kobo: 4000 },
      ]);
      await trx('transactions').where({ id: original.id }).update({ status: TRANSACTION_STATUS.REVERSED });
    });

    const recon = await reconciliationFor(account.id);
    expect(recon.cached_balance_kobo).toBe(0);
    expect(recon.ledger_balance_kobo).toBe(0);
  });
});

describe('transactions constraints', () => {
  test('reference must be unique', async () => {
    const reference = `T-${randomUUID()}`;
    await db('transactions').insert({ reference, type: TRANSACTION_TYPE.ADJUSTMENT });
    await expect(db('transactions').insert({ reference, type: TRANSACTION_TYPE.ADJUSTMENT })).rejects.toThrow(
      /transactions_reference_unique/,
    );
  });

  test('idempotency_key must be unique', async () => {
    const key = `idem-${randomUUID()}`;
    await db('transactions').insert({ reference: `T-${randomUUID()}`, type: TRANSACTION_TYPE.ADJUSTMENT, idempotency_key: key });
    await expect(
      db('transactions').insert({ reference: `T-${randomUUID()}`, type: TRANSACTION_TYPE.ADJUSTMENT, idempotency_key: key }),
    ).rejects.toThrow(/transactions_idempotency_key_unique/);
  });

  test('type and status must be known values', async () => {
    await expect(
      db('transactions').insert({ reference: `T-${randomUUID()}`, type: 'MAGIC_MONEY' }),
    ).rejects.toThrow(/transactions_type_chk/);
    await expect(
      db('transactions').insert({ reference: `T-${randomUUID()}`, type: TRANSACTION_TYPE.ADJUSTMENT, status: 'DONE' }),
    ).rejects.toThrow(/transactions_status_chk/);
  });

  test('identifying fields are immutable and statuses follow the lifecycle', async () => {
    const [tx] = await db('transactions')
      .insert({ reference: `T-${randomUUID()}`, type: TRANSACTION_TYPE.ADJUSTMENT })
      .returning('*');

    await expect(db('transactions').where({ id: tx.id }).update({ reference: 'changed' })).rejects.toThrow(
      /TRANSACTION_IMMUTABLE/,
    );
    await expect(db('transactions').where({ id: tx.id }).update({ status: 'REVERSED' })).rejects.toThrow(
      /TRANSACTION_INVALID_STATUS/,
    );

    await db('transactions').where({ id: tx.id }).update({ status: 'FAILED' });
    await expect(db('transactions').where({ id: tx.id }).update({ status: 'POSTED' })).rejects.toThrow(
      /TRANSACTION_INVALID_STATUS/,
    );
  });

  test('transactions cannot be deleted', async () => {
    const [tx] = await db('transactions')
      .insert({ reference: `T-${randomUUID()}`, type: TRANSACTION_TYPE.ADJUSTMENT })
      .returning('*');
    await expect(db('transactions').where({ id: tx.id }).del()).rejects.toThrow(/TRANSACTION_UNDELETABLE/);
  });
});

describe('Whole-ledger invariants (run last in this file)', () => {
  test('every account balance equals the sum of its ledger entries', async () => {
    const mismatches = await db('account_reconciliation').whereRaw('cached_balance_kobo <> ledger_balance_kobo');
    expect(mismatches).toEqual([]);
  });

  test('all balances in the system sum to zero (double entry)', async () => {
    const { total } = await db('accounts').sum({ total: 'balance_kobo' }).first();
    expect(Number(total)).toBe(0);
  });

  test('wallets + escrow + revenue + clearing equals total funded minus total paid out', async () => {
    const { held } = await db('accounts')
      .whereNot({ owner_id: SYSTEM_ACCOUNT.EXTERNAL })
      .sum({ held: 'balance_kobo' })
      .first();
    const external = await systemAccountId(SYSTEM_ACCOUNT.EXTERNAL);
    const { balance_kobo: externalBalance } = await getAccount(external);
    expect(Number(held)).toBe(-externalBalance);
  });
});
