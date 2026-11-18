const { db, createUserAccount, systemAccountId, getAccount, reconciliationFor } = require('../helpers/ledger');
const ledger = require('../../src/modules/wallet/ledger.service');
const { runAudit } = require('../../src/modules/audit/ledgerAudit.service');
const { DIRECTION, SYSTEM_ACCOUNT, TRANSACTION_TYPE } = require('../../src/db/constants');

const { DEBIT, CREDIT } = DIRECTION;
let external;

beforeAll(async () => {
  external = await systemAccountId(SYSTEM_ACCOUNT.EXTERNAL);
});
afterAll(() => db.destroy());

const balanceOf = async (id) => (await getAccount(id)).balance_kobo;
const countTransactions = async (where) => Number((await db('transactions').where(where).count('* as n').first()).n);

/** A fresh user account holding `kobo`, funded through the real service. */
async function fundedAccount(kobo) {
  const account = await createUserAccount();
  if (kobo > 0) {
    await ledger.transfer({
      fromAccountId: external,
      toAccountId: account.id,
      amountKobo: kobo,
      type: TRANSACTION_TYPE.WALLET_FUNDING,
    });
  }
  return account;
}

async function expectError(promise, code) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('postTransaction: basics', () => {
  test('posts a balanced transaction and updates both balances', async () => {
    const a = await fundedAccount(10_000);
    const b = await createUserAccount();

    const result = await ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amountKobo: 2_500 });

    expect(result.replayed).toBe(false);
    expect(result.transaction.status).toBe('POSTED');
    expect(result.entries).toHaveLength(2);
    expect(await balanceOf(a.id)).toBe(7_500);
    expect(await balanceOf(b.id)).toBe(2_500);
    for (const id of [a.id, b.id]) {
      const r = await reconciliationFor(id);
      expect(r.cached_balance_kobo).toBe(r.ledger_balance_kobo);
    }
  });

  test('supports a 3-leg posting (buyer -> vendor + platform commission)', async () => {
    const buyer = await fundedAccount(100_000);
    const vendor = await createUserAccount();
    const revenue = await systemAccountId(SYSTEM_ACCOUNT.REVENUE);
    const revenueBefore = await balanceOf(revenue);

    await ledger.postTransaction({
      type: TRANSACTION_TYPE.ESCROW_RELEASE,
      entries: [
        { accountId: buyer.id, direction: DEBIT, amountKobo: 100_000 },
        { accountId: vendor.id, direction: CREDIT, amountKobo: 95_000 },
        { accountId: revenue, direction: CREDIT, amountKobo: 5_000 },
      ],
    });

    expect(await balanceOf(buyer.id)).toBe(0);
    expect(await balanceOf(vendor.id)).toBe(95_000);
    expect(await balanceOf(revenue)).toBe(revenueBefore + 5_000);
  });

  test.each([
    ['unbalanced entries', [{ d: DEBIT, k: 100 }, { d: CREDIT, k: 99 }], 'VALIDATION_ERROR'],
    ['a single entry', [{ d: CREDIT, k: 100 }], 'VALIDATION_ERROR'],
    ['a zero amount', [{ d: DEBIT, k: 0 }, { d: CREDIT, k: 0 }], 'VALIDATION_ERROR'],
    ['a negative amount', [{ d: DEBIT, k: -100 }, { d: CREDIT, k: -100 }], 'VALIDATION_ERROR'],
    ['a fractional amount', [{ d: DEBIT, k: 10.5 }, { d: CREDIT, k: 10.5 }], 'BAD_REQUEST'],
    ['an unknown direction', [{ d: 'sideways', k: 100 }, { d: CREDIT, k: 100 }], 'VALIDATION_ERROR'],
  ])('rejects %s and writes nothing', async (_name, legs, code) => {
    const a = await fundedAccount(1_000);
    const b = await createUserAccount();
    const before = await countTransactions({});
    const ids = [a.id, b.id];

    await expectError(
      ledger.postTransaction({
        type: TRANSACTION_TYPE.ADJUSTMENT,
        entries: legs.map((l, i) => ({ accountId: ids[i % 2], direction: l.d, amountKobo: l.k })),
      }),
      code,
    );
    expect(await countTransactions({})).toBe(before);
    expect(await balanceOf(a.id)).toBe(1_000);
  });

  test('refuses to transfer to the same account', async () => {
    const a = await fundedAccount(1_000);
    await expectError(ledger.transfer({ fromAccountId: a.id, toAccountId: a.id, amountKobo: 10 }), 'VALIDATION_ERROR');
  });

  test('refuses an unknown account', async () => {
    const a = await fundedAccount(1_000);
    await expectError(
      ledger.transfer({ fromAccountId: a.id, toAccountId: '00000000-0000-0000-0000-000000000000', amountKobo: 10 }),
      'ACCOUNT_NOT_FOUND',
    );
    expect(await balanceOf(a.id)).toBe(1_000);
  });
});

describe('overdraft protection', () => {
  test('a spend larger than the balance fails with INSUFFICIENT_FUNDS and changes nothing', async () => {
    const a = await fundedAccount(1_000);
    const b = await createUserAccount();

    await expect(ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amountKobo: 1_001 })).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      statusCode: 409,
    });
    expect(await balanceOf(a.id)).toBe(1_000);
    expect(await balanceOf(b.id)).toBe(0);
  });

  test('spending exactly the whole balance is allowed', async () => {
    const a = await fundedAccount(1_000);
    const b = await createUserAccount();
    await ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amountKobo: 1_000 });
    expect(await balanceOf(a.id)).toBe(0);
  });

  test('only PLATFORM_EXTERNAL may go negative (funding does it by design)', async () => {
    const before = await balanceOf(external);
    await fundedAccount(5_000);
    expect(await balanceOf(external)).toBe(before - 5_000);
  });
});

describe('concurrency', () => {
  test('10 simultaneous spends against a balance that affords only 3: exactly 3 succeed', async () => {
    const a = await fundedAccount(3_000);
    const b = await createUserAccount();

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amountKobo: 1_000 })),
    );

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(3);
    expect(failed).toHaveLength(7);
    failed.forEach((f) => expect(f.reason.code).toBe('INSUFFICIENT_FUNDS'));
    expect(await balanceOf(a.id)).toBe(0);
    expect(await balanceOf(b.id)).toBe(3_000);
  });

  test('20 transfers A->B racing 20 transfers B->A never deadlock and conserve money', async () => {
    const a = await fundedAccount(100_000);
    const b = await fundedAccount(100_000);

    const jobs = [];
    for (let i = 0; i < 20; i += 1) {
      jobs.push(ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amountKobo: 100 + i }));
      jobs.push(ledger.transfer({ fromAccountId: b.id, toAccountId: a.id, amountKobo: 50 + i }));
    }
    const results = await Promise.allSettled(jobs);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const sentAB = Array.from({ length: 20 }, (_, i) => 100 + i).reduce((x, y) => x + y, 0);
    const sentBA = Array.from({ length: 20 }, (_, i) => 50 + i).reduce((x, y) => x + y, 0);
    expect(await balanceOf(a.id)).toBe(100_000 - sentAB + sentBA);
    expect(await balanceOf(b.id)).toBe(100_000 + sentAB - sentBA);
  });
});

describe('idempotency', () => {
  test('the same key twice posts once and returns the original transaction', async () => {
    const a = await fundedAccount(5_000);
    const b = await createUserAccount();
    const args = { fromAccountId: a.id, toAccountId: b.id, amountKobo: 700, idempotencyKey: `idem-${Date.now()}-seq` };

    const first = await ledger.transfer(args);
    const second = await ledger.transfer(args);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(await balanceOf(b.id)).toBe(700);
    expect(await countTransactions({ idempotency_key: args.idempotencyKey })).toBe(1);
  });

  test('10 simultaneous requests with one key create exactly one transaction', async () => {
    const a = await fundedAccount(5_000);
    const b = await createUserAccount();
    const key = `idem-${Date.now()}-race`;

    const results = await Promise.all(
      Array.from({ length: 10 }, () => ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amountKobo: 400, idempotencyKey: key })),
    );

    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await balanceOf(a.id)).toBe(4_600);
    expect(await balanceOf(b.id)).toBe(400);
    expect(await countTransactions({ idempotency_key: key })).toBe(1);
  });

  test('reusing a key for a DIFFERENT amount is rejected, not silently replayed', async () => {
    const a = await fundedAccount(5_000);
    const b = await createUserAccount();
    const key = `idem-${Date.now()}-diff`;
    await ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amountKobo: 100, idempotencyKey: key });

    await expectError(
      ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amountKobo: 999, idempotencyKey: key }),
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(await balanceOf(b.id)).toBe(100);
  });
});

describe('atomicity', () => {
  test('postings made inside a caller transaction are all undone when the caller fails', async () => {
    const a = await fundedAccount(5_000);
    const b = await createUserAccount();
    const refBefore = await countTransactions({});

    await expect(
      db.transaction(async (trx) => {
        await ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amountKobo: 1_000, trx });
        await ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amountKobo: 1_000, trx });
        throw new Error('something later in the business operation failed');
      }),
    ).rejects.toThrow('something later');

    expect(await balanceOf(a.id)).toBe(5_000);
    expect(await balanceOf(b.id)).toBe(0);
    expect(await countTransactions({})).toBe(refBefore);
  });

  test('a failing second posting rolls back the first one in the same transaction', async () => {
    const a = await fundedAccount(1_500);
    const b = await createUserAccount();

    await expectError(
      db.transaction(async (trx) => {
        await ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amountKobo: 1_000, trx });
        await ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amountKobo: 1_000, trx }); // only 500 left
      }),
      'INSUFFICIENT_FUNDS',
    );
    expect(await balanceOf(a.id)).toBe(1_500);
    expect(await balanceOf(b.id)).toBe(0);
  });
});

describe('account status', () => {
  test.each(['FROZEN', 'CLOSED'])('a %s account refuses debits and credits', async (status) => {
    const a = await fundedAccount(2_000);
    const b = await createUserAccount();
    await db('accounts').where({ id: a.id }).update({ status });

    await expectError(ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amountKobo: 10 }), 'ACCOUNT_NOT_ACTIVE');
    await expectError(ledger.transfer({ fromAccountId: b.id, toAccountId: a.id, amountKobo: 0 + 1 }), 'ACCOUNT_NOT_ACTIVE');
    expect(await balanceOf(a.id)).toBe(2_000);
  });
});

describe('reversals', () => {
  test('flips every entry, restores balances and marks the original REVERSED', async () => {
    const a = await fundedAccount(5_000);
    const b = await createUserAccount();
    const { transaction } = await ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amountKobo: 2_000 });

    const reversal = await ledger.reverseTransaction({ transactionId: transaction.id, reason: 'customer error' });

    expect(reversal.transaction.type).toBe('REVERSAL');
    expect(reversal.transaction.reversesTransactionId).toBe(transaction.id);
    expect(await balanceOf(a.id)).toBe(5_000);
    expect(await balanceOf(b.id)).toBe(0);
    const original = await db('transactions').where({ id: transaction.id }).first();
    expect(original.status).toBe('REVERSED');
    // the original ledger rows are untouched
    expect(await db('ledger_entries').where({ transaction_id: transaction.id })).toHaveLength(2);
  });

  test('a transaction cannot be reversed twice', async () => {
    const a = await fundedAccount(5_000);
    const b = await createUserAccount();
    const { transaction } = await ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amountKobo: 1_000 });
    await ledger.reverseTransaction({ transactionId: transaction.id });

    await expectError(ledger.reverseTransaction({ transactionId: transaction.id }), 'ALREADY_REVERSED');
    expect(await balanceOf(a.id)).toBe(5_000);
  });

  test('a reversal cannot itself be reversed', async () => {
    const a = await fundedAccount(5_000);
    const b = await createUserAccount();
    const { transaction } = await ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amountKobo: 1_000 });
    const reversal = await ledger.reverseTransaction({ transactionId: transaction.id });

    await expectError(ledger.reverseTransaction({ transactionId: reversal.transaction.id }), 'CANNOT_REVERSE_A_REVERSAL');
  });

  test('5 simultaneous reversals of one transaction: exactly one wins', async () => {
    const a = await fundedAccount(5_000);
    const b = await createUserAccount();
    const { transaction } = await ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amountKobo: 1_000 });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => ledger.reverseTransaction({ transactionId: transaction.id })),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    results.filter((r) => r.status === 'rejected').forEach((r) => expect(r.reason.code).toBe('ALREADY_REVERSED'));
    expect(await balanceOf(a.id)).toBe(5_000); // refunded once, not five times
    expect(await balanceOf(b.id)).toBe(0);
  });

  test('retrying a reversal with the same idempotency key returns the same reversal', async () => {
    const a = await fundedAccount(5_000);
    const b = await createUserAccount();
    const { transaction } = await ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amountKobo: 1_000 });
    const key = `rev-${Date.now()}`;

    const first = await ledger.reverseTransaction({ transactionId: transaction.id, idempotencyKey: key });
    const second = await ledger.reverseTransaction({ transactionId: transaction.id, idempotencyKey: key });

    expect(second.replayed).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
  });

  test('fails if the money has already been spent, leaving the original POSTED', async () => {
    const a = await fundedAccount(5_000);
    const b = await createUserAccount();
    const c = await createUserAccount();
    const { transaction } = await ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amountKobo: 1_000 });
    await ledger.transfer({ fromAccountId: b.id, toAccountId: c.id, amountKobo: 1_000 }); // b spends it

    await expectError(ledger.reverseTransaction({ transactionId: transaction.id }), 'INSUFFICIENT_FUNDS');
    const original = await db('transactions').where({ id: transaction.id }).first();
    expect(original.status).toBe('POSTED');
  });

  test('an unknown transaction is a 404', async () => {
    await expectError(
      ledger.reverseTransaction({ transactionId: '00000000-0000-0000-0000-000000000000' }),
      'TRANSACTION_NOT_FOUND',
    );
  });
});

describe('ledger audit', () => {
  test('passes on the ledger the tests above built', async () => {
    const result = await runAudit();
    expect(result.checks.filter((c) => !c.pass)).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.totals.heldKobo).toBe(result.totals.fundedKobo - result.totals.paidOutKobo);
  });

  // Tampering happens inside a transaction that is ALWAYS rolled back, so the shared test
  // database (and the end-of-run audit) stays clean.
  async function tamper(mutate) {
    let result;
    await db
      .transaction(async (trx) => {
        await trx.raw('ALTER TABLE ledger_entries DISABLE TRIGGER USER');
        await trx.raw('ALTER TABLE accounts DISABLE TRIGGER USER');
        await mutate(trx);
        result = await runAudit(trx);
        throw new Error('ROLLBACK_ON_PURPOSE');
      })
      .catch((err) => {
        if (err.message !== 'ROLLBACK_ON_PURPOSE') throw err;
      });
    return result;
  }
  const failedNames = (result) => result.checks.filter((c) => !c.pass).map((c) => c.name);

  test('FAILS when money is created from nothing (a lone credit entry)', async () => {
    const victim = await createUserAccount();
    const result = await tamper(async (trx) => {
      const [t] = await trx('transactions')
        .insert({ reference: `FORGED-${Date.now()}`, type: 'ADJUSTMENT', status: 'POSTED' })
        .returning('id');
      await trx('ledger_entries').insert({ transaction_id: t.id, account_id: victim.id, direction: CREDIT, amount_kobo: 1_000_000 });
    });

    expect(result.pass).toBe(false);
    expect(failedNames(result).join('|')).toMatch(/funded - paid out/);
    expect(failedNames(result).join('|')).toMatch(/debits = credits/);
  });

  test('FAILS when a cached balance is edited behind the ledger\'s back', async () => {
    const victim = await fundedAccount(1_000);
    const result = await tamper((trx) => trx('accounts').where({ id: victim.id }).update({ balance_kobo: 999_999 }));

    expect(result.pass).toBe(false);
    expect(failedNames(result)).toContain('Every account balance matches the sum of its ledger entries');
  });

  test('the tampering above was rolled back: the real ledger still passes', async () => {
    expect((await runAudit()).pass).toBe(true);
  });
});
