const backend = require('../helpers/backend'); // must come before the app (installs mocks)
const request = require('supertest');
const createApp = require('../../src/app');
const { db } = require('../../src/config/postgres');
const { runAudit } = require('../../src/modules/audit/ledgerAudit.service');
const payoutsService = require('../../src/modules/payouts/payouts.service');
const { getProvider } = require('../../src/modules/payments/providers');
const PaystackProvider = require('../../src/modules/payments/providers/paystack.provider');
const { createUserAndLogin, bearer } = require('../helpers/users');
const { createVendor } = require('../helpers/catalog');
const { fundWallet, walletBalance, newKey } = require('../helpers/orders');

const app = createApp();
const provider = getProvider();
let admin;

beforeAll(async () => {
  await backend.start();
  admin = await createUserAndLogin(app, { roles: ['buyer', 'admin'] });
});
afterEach(() => {
  provider.transferOutcome = 'success';
});
afterAll(async () => {
  await backend.stop();
  await db.destroy();
});

const clearingBalance = async () => (await db('accounts').where({ owner_type: 'SYSTEM', owner_id: 'PLATFORM_PAYOUT_CLEARING' }).first()).balance_kobo;
const externalBalance = async () => (await db('accounts').where({ owner_type: 'SYSTEM', owner_id: 'PLATFORM_EXTERNAL' }).first()).balance_kobo;

async function vendorWith(kobo) {
  const vendor = await createVendor(app, admin);
  if (kobo) await fundWallet(vendor.id, kobo);
  return vendor;
}
const requestPayout = (user, amountKobo, key = newKey()) =>
  request(app).post('/api/v1/payouts').set(bearer(user.token)).set('Idempotency-Key', key).send({ amountKobo });
const getPayoutRow = (id) => db('payouts').where({ id }).first();
const finishAll = () => payoutsService.processPending();
const expireClaims = () => db('payouts').where({ status: 'PENDING' }).update({ claimed_at: db.raw("now() - interval '1 hour'") });

describe('POST /payouts', () => {
  test('moves the money out of the wallet into PAYOUT_CLEARING at once and creates a PENDING payout', async () => {
    const vendor = await vendorWith(500_000);
    const clearing0 = await clearingBalance();
    const res = await requestPayout(vendor, 200_000).expect(201);

    const p = res.body.data.payout;
    expect(p).toMatchObject({ status: 'PENDING', amountKobo: 200_000, failureReason: null, processedAt: null });
    expect(p.bank).toEqual({ bankName: 'GTBank', accountNumberMasked: '******6789', accountName: 'Catalog Store' });
    expect(JSON.stringify(res.body)).not.toContain('0123456789'); // the full account number is never returned
    expect(await walletBalance(vendor.id)).toBe(300_000);
    expect(await clearingBalance()).toBe(clearing0 + 200_000);
    const tx = await db('transactions').where({ idempotency_key: `payout-request:${p.id}` }).first();
    expect(tx.type).toBe('PAYOUT_REQUEST');
    expect((await runAudit()).pass).toBe(true);
    await finishAll();
  });

  test('the minimum is N1,000 (100,000 kobo); amounts must be positive integers', async () => {
    const vendor = await vendorWith(1_000_000);
    const low = await requestPayout(vendor, 99_999);
    expect(low.status).toBe(422);
    expect(JSON.stringify(low.body)).toMatch(/minimum/i);
    for (const bad of [0, -5, 150_000.5, '150000', null]) {
      expect([bad, (await requestPayout(vendor, bad)).status]).toEqual([bad, 422]);
    }
    expect(await walletBalance(vendor.id)).toBe(1_000_000);
    await requestPayout(vendor, 100_000).expect(201); // exactly the minimum is fine
    await finishAll();
  });

  test('needs authentication, the vendor role, an approved store and an Idempotency-Key', async () => {
    const vendor = await vendorWith(500_000);
    const buyer = await createUserAndLogin(app);
    await fundWallet(buyer.id, 500_000);
    expect((await request(app).post('/api/v1/payouts').set('Idempotency-Key', newKey()).send({ amountKobo: 100_000 })).status).toBe(401);
    expect((await requestPayout(buyer, 100_000)).status).toBe(403);
    const noKey = await request(app).post('/api/v1/payouts').set(bearer(vendor.token)).send({ amountKobo: 100_000 });
    expect(noKey.status).toBe(400);
    expect(await walletBalance(buyer.id)).toBe(500_000);
    expect(await walletBalance(vendor.id)).toBe(500_000);
  });

  test('cannot withdraw more than the wallet holds: 409 and nothing is created', async () => {
    const vendor = await vendorWith(150_000);
    const clearing0 = await clearingBalance();
    const res = await requestPayout(vendor, 150_001);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await walletBalance(vendor.id)).toBe(150_000);
    expect(await clearingBalance()).toBe(clearing0);
    expect(await db('payouts').where({ user_id: vendor.id })).toHaveLength(0);
  });

  test('the whole balance can be withdrawn, leaving exactly zero', async () => {
    const vendor = await vendorWith(150_000);
    await requestPayout(vendor, 150_000).expect(201);
    expect(await walletBalance(vendor.id)).toBe(0);
    await finishAll();
  });

  test('a frozen wallet cannot withdraw', async () => {
    const vendor = await vendorWith(500_000);
    await db('accounts').where({ owner_type: 'USER', owner_id: vendor.id }).update({ status: 'FROZEN' });
    const res = await requestPayout(vendor, 100_000);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_ACTIVE');
    expect(await db('payouts').where({ user_id: vendor.id })).toHaveLength(0);
    await db('accounts').where({ owner_type: 'USER', owner_id: vendor.id }).update({ status: 'ACTIVE' });
  });

  test('a vendor can have only ONE pending payout', async () => {
    const vendor = await vendorWith(1_000_000);
    await requestPayout(vendor, 100_000).expect(201);
    const second = await requestPayout(vendor, 100_000);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('PAYOUT_PENDING_EXISTS');
    expect(await walletBalance(vendor.id)).toBe(900_000); // only the first was taken
    await finishAll();
    await requestPayout(vendor, 100_000).expect(201); // once the first is done, another is fine
    await finishAll();
  });

  test('the same Idempotency-Key returns the same payout and takes the money once', async () => {
    const vendor = await vendorWith(500_000);
    const key = newKey();
    const a = await requestPayout(vendor, 100_000, key).expect(201);
    const b = await requestPayout(vendor, 100_000, key).expect(201);
    expect(b.body.data.payout.id).toBe(a.body.data.payout.id);
    expect(await walletBalance(vendor.id)).toBe(400_000);
    expect(await db('payouts').where({ user_id: vendor.id })).toHaveLength(1);
    expect((await requestPayout(vendor, 200_000, key)).status).toBe(409); // same key, different amount
    await finishAll();
  });
});

describe('two requests at the same moment can never exceed the balance', () => {
  test('balance 150,000; two requests of 100,000 at once: exactly one succeeds', async () => {
    for (let round = 0; round < 3; round += 1) {
      const vendor = await vendorWith(150_000);
      const results = await Promise.all([requestPayout(vendor, 100_000), requestPayout(vendor, 100_000)]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(1);
      expect(await walletBalance(vendor.id)).toBe(50_000);
      expect(await db('payouts').where({ user_id: vendor.id })).toHaveLength(1);
    }
    expect((await runAudit()).pass).toBe(true);
    await finishAll();
  });

  test('ten at once: still exactly one, and the wallet never goes negative', async () => {
    const vendor = await vendorWith(1_000_000);
    const results = await Promise.all(Array.from({ length: 10 }, () => requestPayout(vendor, 100_000)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await walletBalance(vendor.id)).toBe(900_000);
    await finishAll();
  });

  test('even WITHOUT the one-pending rule the balance check alone stops an overdraft (ledger lock)', async () => {
    const vendor = await vendorWith(150_000);
    await db.raw('DROP INDEX payouts_one_pending_per_user');
    const realFind = require('../../src/modules/payouts/payout.repository').findPendingForUser;
    const repo = require('../../src/modules/payouts/payout.repository');
    repo.findPendingForUser = async () => null; // pretend the application-level check does not exist either
    try {
      const results = await Promise.all([requestPayout(vendor, 100_000), requestPayout(vendor, 100_000), requestPayout(vendor, 100_000)]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'INSUFFICIENT_FUNDS')).toBe(true);
      expect(await walletBalance(vendor.id)).toBe(50_000);
    } finally {
      repo.findPendingForUser = realFind;
      await finishAll();
      await db.raw("CREATE UNIQUE INDEX payouts_one_pending_per_user ON payouts (user_id) WHERE status = 'PENDING'");
    }
  });
});

describe('the payout job', () => {
  test('success: the provider is paid once, CLEARING -> EXTERNAL, payout SUCCESS', async () => {
    const vendor = await vendorWith(500_000);
    const p = (await requestPayout(vendor, 200_000).expect(201)).body.data.payout;
    const [clearing0, external0] = [await clearingBalance(), await externalBalance()];

    const summary = await finishAll();
    expect(summary.success).toBeGreaterThanOrEqual(1);
    const row = await getPayoutRow(p.id);
    expect(row.status).toBe('SUCCESS');
    expect(row.processed_at).toBeTruthy();
    expect(row.provider).toBe('mock');
    expect(provider.transfers.get(row.reference)).toMatchObject({ amountKobo: 200_000, bank: { accountNumber: '0123456789' } });
    expect(await clearingBalance()).toBe(clearing0 - 200_000);
    expect(await externalBalance()).toBe(external0 + 200_000); // EXTERNAL is "the bank": funding debits it, a payout credits it back
    expect(await walletBalance(vendor.id)).toBe(300_000);
    const tx = await db('transactions').where({ id: row.settlement_transaction_id }).first();
    expect(tx.type).toBe('PAYOUT_SETTLEMENT');
    expect((await runAudit()).pass).toBe(true);
    expect((await getPayoutRow(p.id)).attempts).toBeGreaterThanOrEqual(1);
  });

  test('failure: the money returns to the wallet, the payout is FAILED with a reason, and the vendor can retry', async () => {
    const vendor = await vendorWith(500_000);
    provider.transferOutcome = 'failed';
    const p = (await requestPayout(vendor, 200_000).expect(201)).body.data.payout;
    const clearing0 = await clearingBalance();

    await finishAll();
    const row = await getPayoutRow(p.id);
    expect(row.status).toBe('FAILED');
    expect(row.failure_reason).toMatch(/bank/i);
    expect(await walletBalance(vendor.id)).toBe(500_000); // all back
    expect(await clearingBalance()).toBe(clearing0 - 200_000);
    expect((await db('transactions').where({ id: row.reversal_transaction_id }).first()).type).toBe('PAYOUT_REVERSAL');
    expect((await runAudit()).pass).toBe(true);

    provider.transferOutcome = 'success';
    await requestPayout(vendor, 200_000).expect(201); // the failed one no longer blocks a new request
    await finishAll();
    expect(await walletBalance(vendor.id)).toBe(300_000);
  });

  test('a bank-rejected account number (mock rule) fails the payout the same way', async () => {
    const vendor = await vendorWith(300_000);
    const p = (await requestPayout(vendor, 100_000).expect(201)).body.data.payout;
    await db.transaction(async (trx) => {
      await trx.raw('ALTER TABLE payouts DISABLE TRIGGER USER');
      await trx('payouts').where({ id: p.id }).update({ account_number: '0000000000' });
      await trx.raw('ALTER TABLE payouts ENABLE TRIGGER USER');
    });
    await finishAll();
    expect((await getPayoutRow(p.id)).status).toBe('FAILED');
    expect(await walletBalance(vendor.id)).toBe(300_000);
  });

  test('provider unreachable (unknown outcome): stays PENDING with the money in clearing, retried later, sent once', async () => {
    const vendor = await vendorWith(300_000);
    provider.transferOutcome = 'error';
    const p = (await requestPayout(vendor, 100_000).expect(201)).body.data.payout;

    const first = await finishAll();
    expect(first.retry).toBeGreaterThanOrEqual(1);
    expect((await getPayoutRow(p.id)).status).toBe('PENDING');
    expect(await walletBalance(vendor.id)).toBe(200_000); // NOT refunded: we do not know it failed
    expect(provider.transfers.has(`payout-${p.id}`)).toBe(false);

    // within the claim lease nobody else touches it
    provider.transferOutcome = 'success';
    expect((await finishAll()).claimed).toBe(0);
    await expireClaims();
    await finishAll();
    expect((await getPayoutRow(p.id)).status).toBe('SUCCESS');
    expect([...provider.transfers.keys()].filter((k) => k === `payout-${p.id}`)).toHaveLength(1);
    expect((await runAudit()).pass).toBe(true);
  });

  test('still in flight at the bank: stays PENDING, is polled again, then settles', async () => {
    const vendor = await vendorWith(300_000);
    provider.transferOutcome = 'pending';
    const p = (await requestPayout(vendor, 100_000).expect(201)).body.data.payout;
    const ref = `payout-${p.id}`;

    expect((await finishAll()).pending).toBeGreaterThanOrEqual(1);
    expect((await getPayoutRow(p.id)).status).toBe('PENDING');
    await finishAll(); // polls again (claim was released), still pending
    expect((await getPayoutRow(p.id)).status).toBe('PENDING');
    provider.settleTransfer(ref, 'success');
    await finishAll();
    expect((await getPayoutRow(p.id)).status).toBe('SUCCESS');
    expect(provider.transfers.size).toBeGreaterThan(0);
    expect(await walletBalance(vendor.id)).toBe(200_000);
  });

  test('a pending transfer that the bank later rejects is reversed', async () => {
    const vendor = await vendorWith(300_000);
    provider.transferOutcome = 'pending';
    const p = (await requestPayout(vendor, 100_000).expect(201)).body.data.payout;
    await finishAll();
    provider.settleTransfer(`payout-${p.id}`, 'failed');
    await finishAll();
    expect((await getPayoutRow(p.id)).status).toBe('FAILED');
    expect(await walletBalance(vendor.id)).toBe(300_000);
  });

  test('crash after the provider accepted the transfer but before we recorded it: NOT sent a second time', async () => {
    const vendor = await vendorWith(300_000);
    const p = (await requestPayout(vendor, 100_000).expect(201)).body.data.payout;
    const ref = `payout-${p.id}`;
    await provider.transfer({ reference: ref, amountKobo: 100_000, bank: { accountNumber: '0123456789' } }); // sent, then "we crashed"
    const before = provider.transfers.size;
    const sendSpy = jest.spyOn(provider, 'transfer');
    await finishAll();
    expect(sendSpy).not.toHaveBeenCalled(); // it asked the provider first and saw the transfer was already there
    sendSpy.mockRestore();
    expect((await getPayoutRow(p.id)).status).toBe('SUCCESS');
    expect(provider.transfers.size).toBe(before); // no second transfer was created
  });

  test('two job runs at the same time process each payout once', async () => {
    const vendors = await Promise.all([vendorWith(300_000), vendorWith(300_000), vendorWith(300_000)]);
    const payouts = [];
    for (const v of vendors) payouts.push((await requestPayout(v, 100_000).expect(201)).body.data.payout);

    await Promise.all([finishAll(), finishAll(), finishAll()]);
    for (const p of payouts) {
      const row = await getPayoutRow(p.id);
      expect(row.status).toBe('SUCCESS');
      expect(await db('transactions').where({ idempotency_key: `payout-settle:${p.id}` })).toHaveLength(1);
      expect(provider.transfers.get(row.reference)).toBeTruthy();
    }
    expect((await runAudit()).pass).toBe(true);
  });

  test('a finished payout is never touched again', async () => {
    const vendor = await vendorWith(300_000);
    const p = (await requestPayout(vendor, 100_000).expect(201)).body.data.payout;
    await finishAll();
    const external1 = await externalBalance();
    await finishAll();
    await finishAll();
    expect(await externalBalance()).toBe(external1);
    expect(await db('transactions').where({ idempotency_key: `payout-settle:${p.id}` })).toHaveLength(1);
  });

  test('settling or failing a payout that is already finished does nothing (no second posting, no error)', async () => {
    const vendor = await vendorWith(300_000);
    const p = (await requestPayout(vendor, 100_000).expect(201)).body.data.payout;
    await finishAll();
    const [wallet1, external1] = [await walletBalance(vendor.id), await externalBalance()];
    expect(await payoutsService.settle(p.id, 'mock')).toBe(false);
    expect(await payoutsService.fail(p.id, 'mock', 'late failure report')).toBe(false); // must NOT refund a payout that was paid
    expect(await walletBalance(vendor.id)).toBe(wallet1);
    expect(await externalBalance()).toBe(external1);
    expect((await getPayoutRow(p.id)).status).toBe('SUCCESS');
  });

  test('the job is registered with the scheduler', () => {
    expect(require('../../src/jobs/payouts.job').name).toBe('payouts');
    expect(require('fs').readFileSync(require.resolve('../../src/jobs/scheduler'), 'utf8')).toContain('payoutsJob');
  });
});

describe('reading payouts', () => {
  test('owner and admin can read one; others get 404; lists are mine only, filterable and paginated', async () => {
    const vendor = await vendorWith(2_000_000);
    const other = await vendorWith(500_000);
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push((await requestPayout(vendor, 100_000 + i).expect(201)).body.data.payout.id);
      if (i === 1) provider.transferOutcome = 'failed';
      await finishAll();
      provider.transferOutcome = 'success';
    }
    await requestPayout(other, 100_000).expect(201);
    await finishAll();

    for (const u of [vendor, admin]) {
      expect((await request(app).get(`/api/v1/payouts/${ids[0]}`).set(bearer(u.token))).status).toBe(200);
    }
    expect((await request(app).get(`/api/v1/payouts/${ids[0]}`).set(bearer(other.token))).status).toBe(404);
    expect((await request(app).get(`/api/v1/payouts/${ids[0]}`)).status).toBe(401);
    expect((await request(app).get('/api/v1/payouts/nope').set(bearer(vendor.token))).status).toBe(422);

    const page1 = await request(app).get('/api/v1/payouts?limit=2').set(bearer(vendor.token)).expect(200);
    expect(page1.body.data.payouts.map((p) => p.id)).toEqual([ids[2], ids[1]]);
    const page2 = await request(app).get(`/api/v1/payouts?limit=2&cursor=${page1.body.data.nextCursor}`).set(bearer(vendor.token)).expect(200);
    expect(page2.body.data.payouts.map((p) => p.id)).toEqual([ids[0]]);
    const failed = await request(app).get('/api/v1/payouts?status=FAILED').set(bearer(vendor.token)).expect(200);
    expect(failed.body.data.payouts.map((p) => p.id)).toEqual([ids[1]]);
    expect(JSON.stringify(page1.body)).not.toContain('0123456789');
  });
});

describe('the database and the audit enforce the rules too', () => {
  test('one PENDING payout per user, immutable fields, final once finished, no deletes, valid shapes', async () => {
    const vendor = await vendorWith(500_000);
    const p = (await requestPayout(vendor, 100_000).expect(201)).body.data.payout;
    const row = await getPayoutRow(p.id);

    // a second PENDING row for the same user is refused by the index even if inserted directly
    await expect(
      db('payouts').insert({ user_id: row.user_id, vendor_id: row.vendor_id, reference: 'payout-dup', amount_kobo: 1, bank_name: 'x', account_number: '0123456789', account_name: 'x', request_transaction_id: row.request_transaction_id }),
    ).rejects.toThrow(/payouts_one_pending_per_user|payouts_request_tx_unique/);

    await expect(db('payouts').where({ id: p.id }).update({ amount_kobo: 1 })).rejects.toThrow(/PAYOUT_IMMUTABLE/);
    await expect(db('payouts').where({ id: p.id }).update({ account_number: '1111111111' })).rejects.toThrow(/PAYOUT_IMMUTABLE/);
    await expect(db('payouts').where({ id: p.id }).delete()).rejects.toThrow(/PAYOUT_NO_DELETE/);
    await expect(db('payouts').where({ id: p.id }).update({ status: 'SUCCESS' })).rejects.toThrow(/payouts_success_shape_chk/); // no settlement transaction
    await expect(db('payouts').where({ id: p.id }).update({ status: 'FAILED', failure_reason: 'x', processed_at: db.fn.now() })).rejects.toThrow(/payouts_failed_shape_chk/);

    await finishAll();
    await expect(db('payouts').where({ id: p.id }).update({ failure_reason: 'rewrite' })).rejects.toThrow(/PAYOUT_FINAL/);
    await expect(db('payouts').where({ id: p.id }).update({ status: 'PENDING' })).rejects.toThrow(/PAYOUT_FINAL/);
  });

  test('the audit catches clearing money that no PENDING payout explains, and a SUCCESS payout whose settlement is missing', async () => {
    const vendor = await vendorWith(300_000);
    const p = (await requestPayout(vendor, 100_000).expect(201)).body.data.payout;
    let tampered;
    await db
      .transaction(async (trx) => {
        await trx.raw('ALTER TABLE payouts DISABLE TRIGGER USER');
        await trx.raw("ALTER TABLE payouts DISABLE TRIGGER payouts_guard_update");
        await trx('payouts').where({ id: p.id }).update({ amount_kobo: 90_000 }); // pending sum no longer matches clearing
        tampered = await runAudit(trx);
        throw new Error('ROLLBACK_ON_PURPOSE');
      })
      .catch((e) => {
        if (e.message !== 'ROLLBACK_ON_PURPOSE') throw e;
      });
    expect(tampered.pass).toBe(false);
    const failing = tampered.checks.filter((c) => !c.pass).map((c) => c.name);
    expect(failing).toEqual(expect.arrayContaining(['PLATFORM_PAYOUT_CLEARING holds exactly the money of PENDING payouts', 'Every payout is backed by ledger transactions of the right type and amount']));
    await finishAll();
    expect((await runAudit()).pass).toBe(true);
  });
});

describe('Paystack transfers (fake HTTP)', () => {
  const bank = { bankName: 'Guaranty Trust Bank', accountNumber: '0123456789', accountName: 'Ade Stores' };
  const reply = (status, json) => ({ status, json: async () => json });
  const make = (handler) => new PaystackProvider({ secretKey: 'sk_test_x', baseUrl: 'https://api.paystack.test', fetchImpl: async (url, opts) => handler(url.replace('https://api.paystack.test', ''), opts && opts.method, opts && opts.body ? JSON.parse(opts.body) : null) });
  const banks = reply(200, { status: true, data: [{ name: 'Guaranty Trust Bank', code: '058' }, { name: 'Access Bank', code: '044' }] });

  test('creates a recipient then a transfer, in integer kobo, with our reference', async () => {
    const calls = [];
    const p = make((path, method, body) => {
      calls.push({ path, method, body });
      if (path.startsWith('/bank')) return banks;
      if (path === '/transferrecipient') return reply(201, { status: true, data: { recipient_code: 'RCP_1' } });
      if (path === '/transfer') return reply(200, { status: true, data: { status: 'pending', transfer_code: 'TRF_1' } });
      throw new Error(`unexpected ${path}`);
    });
    const out = await p.transfer({ reference: 'payout-abc', amountKobo: 250_000, bank });
    expect(out).toEqual({ status: 'pending', providerReference: 'TRF_1', reason: null });
    expect(calls.find((c) => c.path === '/transferrecipient').body).toMatchObject({ type: 'nuban', account_number: '0123456789', bank_code: '058', currency: 'NGN' });
    expect(calls.find((c) => c.path === '/transfer').body).toEqual({ source: 'balance', amount: 250_000, recipient: 'RCP_1', reason: 'KoboMarket payout', reference: 'payout-abc' });
  });

  test('a definite refusal is "failed" (reversible); a 5xx or network error THROWS (must be retried, not reversed)', async () => {
    const refused = make((path) => (path.startsWith('/bank') ? banks : path === '/transferrecipient' ? reply(422, { status: false, message: 'Could not resolve account name' }) : null));
    expect(await refused.transfer({ reference: 'payout-1', amountKobo: 100_000, bank })).toEqual({ status: 'failed', reason: 'Could not resolve account name' });

    const unknownBank = make((path) => banks);
    expect((await unknownBank.transfer({ reference: 'payout-2', amountKobo: 100_000, bank: { ...bank, bankName: 'Nowhere Bank' } })).status).toBe('failed');

    const down = make((path) => (path.startsWith('/bank') ? banks : path === '/transferrecipient' ? reply(201, { status: true, data: { recipient_code: 'R' } }) : reply(503, { message: 'down' })));
    await expect(down.transfer({ reference: 'payout-3', amountKobo: 100_000, bank })).rejects.toMatchObject({ statusCode: 502 });

    const network = new PaystackProvider({ secretKey: 'sk', baseUrl: 'https://api.paystack.test', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    await expect(network.verifyTransfer('payout-4')).rejects.toMatchObject({ statusCode: 502 });
  });

  test('verifyTransfer maps Paystack states to success / failed / pending / not_found', async () => {
    const states = { success: 'success', failed: 'failed', reversed: 'failed', pending: 'pending', otp: 'pending', received: 'pending' };
    for (const [paystack, ours] of Object.entries(states)) {
      const p = make(() => reply(200, { status: true, data: { status: paystack, transfer_code: 'TRF' } }));
      expect((await p.verifyTransfer('payout-x')).status).toBe(ours);
    }
    const missing = make(() => reply(404, { status: false, message: 'Transfer not found' }));
    expect(await missing.verifyTransfer('payout-x')).toEqual({ status: 'not_found' });
  });
});
