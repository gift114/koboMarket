const backend = require('../helpers/backend'); // must come before the app (installs mocks)
const request = require('supertest');
const createApp = require('../../src/app');
const config = require('../../src/config');
const AppError = require('../../src/utils/AppError');
const { db } = require('../../src/config/postgres');
const { getProvider } = require('../../src/modules/payments/providers');
const { sign } = require('../../src/modules/payments/signature');
const { runAudit } = require('../../src/modules/audit/ledgerAudit.service');
const { createUserAndLogin, bearer } = require('../helpers/users');
const { getAccount } = require('../helpers/ledger');

const app = createApp();
const provider = getProvider();
let keySeq = 0;
const newKey = () => `test-key-${Date.now()}-${(keySeq += 1)}`;

beforeAll(() => backend.start());
afterAll(async () => {
  await backend.stop();
  await db.destroy();
});

const fund = (token, body = { amountKobo: 500_000 }, key = newKey()) =>
  request(app).post('/api/v1/wallet/fund').set(bearer(token)).set('Idempotency-Key', key).send(body);

const postWebhook = (rawBody, signature) => {
  const req = request(app).post('/api/v1/webhooks/paystack').set('Content-Type', 'application/json');
  if (signature !== undefined) req.set('x-paystack-signature', signature);
  return req.send(rawBody.toString('utf8')); // a string is sent byte-for-byte (a Buffer would be JSON-encoded)
};
const deliver = (reference, event = 'charge.success') => {
  const { rawBody, signature } = provider.buildWebhook(reference, event);
  return postWebhook(rawBody, signature);
};

const balanceOf = async (userId) => {
  const row = await db('accounts').where({ owner_type: 'USER', owner_id: userId }).first();
  return row ? row.balance_kobo : 0;
};
const fundingTransactions = async (reference) =>
  db('transactions').where({ type: 'WALLET_FUNDING', idempotency_key: `fund:${reference}` });

/** A user with a PENDING payment of `amountKobo`. */
async function pendingPayment(amountKobo = 500_000) {
  const user = await createUserAndLogin(app);
  const res = await fund(user.token, { amountKobo }).expect(201);
  return { user, payment: res.body.data.payment };
}
/** ...whose customer has paid at the gateway. */
async function paidPayment(amountKobo = 500_000) {
  const ctx = await pendingPayment(amountKobo);
  provider.markPaid(ctx.payment.reference);
  return ctx;
}

describe('POST /wallet/fund', () => {
  test('requires authentication', async () => {
    const res = await request(app).post('/api/v1/wallet/fund').set('Idempotency-Key', newKey()).send({ amountKobo: 500_000 });
    expect(res.status).toBe(401);
  });

  test('creates a PENDING payment with a checkout URL and moves NO money', async () => {
    const { user, payment } = await pendingPayment(750_000);
    expect(payment).toMatchObject({ status: 'PENDING', amountKobo: 750_000, amountDisplay: 'N7,500.00', currency: 'NGN' });
    expect(payment.reference).toMatch(/^KM-/);
    expect(payment.authorizationUrl).toContain(payment.reference);
    expect(await balanceOf(user.id)).toBe(0);
  });

  test.each([
    ['a float amount', { amountKobo: 5000.5 }],
    ['a string amount', { amountKobo: '500000' }],
    ['an amount below the minimum', { amountKobo: config.payments.fundMinKobo - 1 }],
    ['an amount above the maximum', { amountKobo: config.payments.fundMaxKobo + 1 }],
    ['a negative amount', { amountKobo: -100000 }],
    ['no amount', {}],
    ['an unknown field', { amountKobo: 500_000, userId: 'x' }],
  ])('rejects %s with 422', async (_n, body) => {
    const user = await createUserAndLogin(app);
    const res = await fund(user.token, body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('webhook signature', () => {
  test('an unsigned webhook is rejected (401) and credits nothing', async () => {
    const { user, payment } = await paidPayment();
    const { rawBody } = provider.buildWebhook(payment.reference);
    const res = await postWebhook(rawBody);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect(await balanceOf(user.id)).toBe(0);
  });

  test.each([
    ['garbage', 'not-a-signature'],
    ['the right length but wrong', 'a'.repeat(128)],
    ['empty', ''],
  ])('a %s signature is rejected', async (_n, signature) => {
    const { user, payment } = await paidPayment();
    const { rawBody } = provider.buildWebhook(payment.reference);
    expect((await postWebhook(rawBody, signature)).status).toBe(401);
    expect(await balanceOf(user.id)).toBe(0);
  });

  test('a signature made with the WRONG secret is rejected', async () => {
    const { user, payment } = await paidPayment();
    const { rawBody } = provider.buildWebhook(payment.reference);
    expect((await postWebhook(rawBody, sign(rawBody, 'some-other-secret-entirely'))).status).toBe(401);
    expect(await balanceOf(user.id)).toBe(0);
  });

  test('a body changed after signing (inflated amount) is rejected', async () => {
    const { user, payment } = await paidPayment();
    const { rawBody, signature } = provider.buildWebhook(payment.reference);
    const tampered = Buffer.from(rawBody.toString().replace(/"amount":\d+/, '"amount":99999999'));
    expect((await postWebhook(tampered, signature)).status).toBe(401);
    expect(await balanceOf(user.id)).toBe(0);
  });

  test('a validly signed but malformed body is 400, not a crash', async () => {
    const raw = Buffer.from('this is not json');
    expect((await postWebhook(raw, sign(raw, provider.secret))).status).toBe(400);
  });
});

describe('crediting the wallet exactly once', () => {
  test('a valid charge.success credits the wallet, marks the payment SUCCEEDED and links the ledger', async () => {
    const { user, payment } = await paidPayment(500_000);

    const res = await deliver(payment.reference);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ duplicate: false, outcome: 'credited' });
    expect(await balanceOf(user.id)).toBe(500_000);

    const row = await db('payments').where({ reference: payment.reference }).first();
    expect(row.status).toBe('SUCCEEDED');
    expect(row.ledger_transaction_id).not.toBeNull();
    const [tx] = await fundingTransactions(payment.reference);
    expect(tx.id).toBe(row.ledger_transaction_id);
    expect(tx.type).toBe('WALLET_FUNDING');

    const wallet = await request(app).get('/api/v1/wallet').set(bearer(user.token));
    expect(wallet.body.data.wallet.balanceKobo).toBe(500_000);
  });

  test('the same webhook delivered 4 times credits ONCE; the repeats are acknowledged as duplicates', async () => {
    const { user, payment } = await paidPayment(300_000);

    const first = await deliver(payment.reference);
    const repeats = [await deliver(payment.reference), await deliver(payment.reference), await deliver(payment.reference)];

    expect(first.body.data.duplicate).toBe(false);
    repeats.forEach((r) => {
      expect(r.status).toBe(200);
      expect(r.body.data.duplicate).toBe(true);
    });
    expect(await balanceOf(user.id)).toBe(300_000);
    expect(await fundingTransactions(payment.reference)).toHaveLength(1);
  });

  test('10 identical webhooks arriving at the SAME moment credit exactly once', async () => {
    const { user, payment } = await paidPayment(250_000);

    const results = await Promise.all(Array.from({ length: 10 }, () => deliver(payment.reference)));

    results.forEach((r) => expect(r.status).toBe(200));
    expect(await balanceOf(user.id)).toBe(250_000);
    expect(await fundingTransactions(payment.reference)).toHaveLength(1);
    expect(await db('webhook_events').where('event_key', 'like', `charge.success:${payment.reference}:%`)).toHaveLength(1);
  });

  test('a webhook that did NOT go through the event table still cannot double-credit (ledger + payment guards)', async () => {
    // Simulates a different event key (e.g. the provider changed its event id) for the same payment.
    const { user, payment } = await paidPayment(120_000);
    await deliver(payment.reference).expect(200);

    const t = provider.transactions.get(payment.reference);
    const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { id: t.id + 5000, reference: payment.reference, amount: 120_000, currency: 'NGN' } }));
    const res = await postWebhook(rawBody, sign(rawBody, provider.secret));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ duplicate: false, outcome: 'already_credited' });
    expect(await balanceOf(user.id)).toBe(120_000);
  });

  test('the credited amount is the one WE recorded, whatever the webhook body claims', async () => {
    const { user, payment } = await paidPayment(200_000);
    const t = provider.transactions.get(payment.reference);
    const inflated = Buffer.from(JSON.stringify({ event: 'charge.success', data: { id: t.id, reference: payment.reference, amount: 999_999_999, currency: 'NGN' } }));

    const res = await postWebhook(inflated, sign(inflated, provider.secret)); // correctly signed

    expect(res.body.data.outcome).toBe('credited');
    expect(await balanceOf(user.id)).toBe(200_000);
  });
});

describe('re-verifying with the provider before crediting', () => {
  test('a signed webhook for a payment the provider says is NOT paid credits nothing', async () => {
    const { user, payment } = await pendingPayment(500_000); // customer never paid
    const res = await deliver(payment.reference);
    expect(res.body.data.outcome).toBe('not_successful');
    expect(await balanceOf(user.id)).toBe(0);
    expect((await db('payments').where({ reference: payment.reference }).first()).status).toBe('PENDING');
  });

  test('the provider reports a DIFFERENT amount than we asked for: not credited, payment FAILED', async () => {
    const { user, payment } = await pendingPayment(500_000);
    provider.markPaid(payment.reference, { amountKobo: 100_000 });

    const res = await deliver(payment.reference);

    expect(res.body.data.outcome).toBe('amount_mismatch');
    expect(await balanceOf(user.id)).toBe(0);
    const row = await db('payments').where({ reference: payment.reference }).first();
    expect(row).toMatchObject({ status: 'FAILED', failure_reason: 'AMOUNT_MISMATCH' });
  });

  test('verify is called before any credit', async () => {
    const { payment } = await paidPayment();
    const spy = jest.spyOn(provider, 'verifyTransaction');
    await deliver(payment.reference).expect(200);
    expect(spy).toHaveBeenCalledWith(payment.reference);
    spy.mockRestore();
  });

  test('an unknown reference is acknowledged (200) and credits nobody', async () => {
    const { user, payment } = await paidPayment();
    const t = provider.transactions.get(payment.reference);
    const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { id: t.id + 1, reference: 'KM-does-not-exist-123', amount: 1_000_000, currency: 'NGN' } }));
    const res = await postWebhook(raw, sign(raw, provider.secret));
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('unknown_payment');
    expect(await balanceOf(user.id)).toBe(0);
  });

  test('other event types are stored and ignored; a failed charge leaves the payment PENDING', async () => {
    const { user, payment } = await pendingPayment();
    provider.markFailed(payment.reference);
    const res = await deliver(payment.reference, 'charge.failed');
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('ignored');
    expect(await balanceOf(user.id)).toBe(0);
  });

  test('provider down while verifying: 5xx so it retries, event NOT marked processed, retry credits once', async () => {
    const { user, payment } = await paidPayment(400_000);
    const spy = jest
      .spyOn(provider, 'verifyTransaction')
      .mockRejectedValueOnce(new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'provider unreachable'));

    const failed = await deliver(payment.reference);
    expect(failed.status).toBe(502);
    expect(await balanceOf(user.id)).toBe(0);
    const event = await db('webhook_events').where('event_key', 'like', `charge.success:${payment.reference}:%`).first();
    expect(event.processed_at).toBeNull();

    const retry = await deliver(payment.reference); // the provider's own retry
    expect(retry.status).toBe(200);
    expect(retry.body.data).toMatchObject({ duplicate: false, outcome: 'credited' });
    expect(await balanceOf(user.id)).toBe(400_000);
    spy.mockRestore();
  });

  test('a frozen wallet is not credited, the webhook is still acknowledged, and a later status check credits it', async () => {
    const { user, payment } = await paidPayment(150_000);
    await db('accounts').where({ owner_type: 'USER', owner_id: user.id }).update({ status: 'FROZEN' }).catch(() => {});
    // The wallet may not exist yet: create it frozen.
    const existing = await db('accounts').where({ owner_type: 'USER', owner_id: user.id }).first();
    if (!existing) await db('accounts').insert({ owner_type: 'USER', owner_id: user.id, status: 'FROZEN' });

    const res = await deliver(payment.reference);
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('account_not_active');
    expect(await balanceOf(user.id)).toBe(0);

    await db('accounts').where({ owner_type: 'USER', owner_id: user.id }).update({ status: 'ACTIVE' });
    const status = await request(app).get(`/api/v1/wallet/fund/${payment.reference}`).set(bearer(user.token));
    expect(status.body.data.payment.status).toBe('SUCCEEDED');
    expect(await balanceOf(user.id)).toBe(150_000);
  });
});

describe('GET /wallet/fund/:reference', () => {
  test('a pending payment that was paid (webhook missed) is verified and credited, once, however often it is polled', async () => {
    const { user, payment } = await paidPayment(600_000);

    const polls = await Promise.all([1, 2, 3, 4].map(() => request(app).get(`/api/v1/wallet/fund/${payment.reference}`).set(bearer(user.token))));

    polls.forEach((r) => expect(r.body.data.payment.status).toBe('SUCCEEDED'));
    expect(await balanceOf(user.id)).toBe(600_000);
    expect(await fundingTransactions(payment.reference)).toHaveLength(1);
  });

  test('an unpaid payment stays PENDING', async () => {
    const { user, payment } = await pendingPayment();
    const res = await request(app).get(`/api/v1/wallet/fund/${payment.reference}`).set(bearer(user.token));
    expect(res.body.data.payment.status).toBe('PENDING');
  });

  test("someone else's payment is 404", async () => {
    const { payment } = await paidPayment();
    const other = await createUserAndLogin(app);
    expect((await request(app).get(`/api/v1/wallet/fund/${payment.reference}`).set(bearer(other.token))).status).toBe(404);
  });
});

describe('Idempotency-Key on POST /wallet/fund', () => {
  test('is required, and must be well-formed', async () => {
    const user = await createUserAndLogin(app);
    const missing = await request(app).post('/api/v1/wallet/fund').set(bearer(user.token)).send({ amountKobo: 500_000 });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toMatch(/Idempotency-Key/);
    expect((await fund(user.token, { amountKobo: 500_000 }, 'short')).status).toBe(400);
    expect((await fund(user.token, { amountKobo: 500_000 }, 'has spaces in the key')).status).toBe(400);
  });

  test('same key + same body: the ORIGINAL response is replayed and only one payment exists', async () => {
    const user = await createUserAndLogin(app);
    const key = newKey();

    const first = await fund(user.token, { amountKobo: 500_000 }, key);
    const second = await fund(user.token, { amountKobo: 500_000 }, key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.body).toEqual(first.body);
    expect(await db('payments').where({ user_id: user.id })).toHaveLength(1);
  });

  test('the body key order does not matter', async () => {
    const user = await createUserAndLogin(app);
    const key = newKey();
    const a = await request(app).post('/api/v1/wallet/fund').set(bearer(user.token)).set('Idempotency-Key', key).send('{"amountKobo":500000}').set('Content-Type', 'application/json');
    const b = await request(app).post('/api/v1/wallet/fund').set(bearer(user.token)).set('Idempotency-Key', key).send('{ "amountKobo" : 500000 }').set('Content-Type', 'application/json');
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.data.payment.reference).toBe(a.body.data.payment.reference);
  });

  test('same key + DIFFERENT body: 409 and nothing new is created', async () => {
    const user = await createUserAndLogin(app);
    const key = newKey();
    await fund(user.token, { amountKobo: 500_000 }, key).expect(201);

    const res = await fund(user.token, { amountKobo: 900_000 }, key);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await db('payments').where({ user_id: user.id })).toHaveLength(1);
  });

  test('6 simultaneous requests with one key create exactly ONE payment', async () => {
    const user = await createUserAndLogin(app);
    const key = newKey();

    const results = await Promise.all(Array.from({ length: 6 }, () => fund(user.token, { amountKobo: 500_000 }, key)));

    const created = results.filter((r) => r.status === 201);
    const inProgress = results.filter((r) => r.status === 409);
    expect(created.length + inProgress.length).toBe(6);
    expect(created.length).toBeGreaterThanOrEqual(1);
    inProgress.forEach((r) => expect(r.body.error.code).toBe('REQUEST_IN_PROGRESS'));
    expect(new Set(created.map((r) => r.body.data.payment.reference)).size).toBe(1);
    expect(await db('payments').where({ user_id: user.id })).toHaveLength(1);
  });

  test('keys are per user: the same key from two users is two independent requests', async () => {
    const a = await createUserAndLogin(app);
    const b = await createUserAndLogin(app);
    const key = newKey();
    const ra = await fund(a.token, { amountKobo: 500_000 }, key);
    const rb = await fund(b.token, { amountKobo: 500_000 }, key);
    expect(rb.status).toBe(201);
    expect(rb.headers['idempotent-replayed']).toBeUndefined();
    expect(rb.body.data.payment.reference).not.toBe(ra.body.data.payment.reference);
  });

  test('a FAILED request is not remembered: the client can retry with the same key', async () => {
    const user = await createUserAndLogin(app);
    const key = newKey();
    const spy = jest
      .spyOn(provider, 'initializeTransaction')
      .mockRejectedValueOnce(new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'provider unreachable'));

    const failed = await fund(user.token, { amountKobo: 500_000 }, key);
    expect(failed.status).toBe(502);

    const retry = await fund(user.token, { amountKobo: 500_000 }, key);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    spy.mockRestore();
    // the failed attempt left a FAILED payment behind, the retry a PENDING one
    const rows = await db('payments').where({ user_id: user.id }).orderBy('created_at');
    expect(rows.map((r) => r.status)).toEqual(['FAILED', 'PENDING']);
  });

  test('a request whose owner died (lock older than the limit) is taken over; a fresh one is 409', async () => {
    const user = await createUserAndLogin(app);
    const key = newKey();
    await fund(user.token, { amountKobo: 500_000 }, key).expect(201);

    // pretend the first request never finished
    await db('idempotency_keys').where({ user_id: user.id, key }).update({ status: 'IN_PROGRESS' });
    const fresh = await fund(user.token, { amountKobo: 500_000 }, key);
    expect(fresh.status).toBe(409);
    expect(fresh.body.error.code).toBe('REQUEST_IN_PROGRESS');

    await db('idempotency_keys').where({ user_id: user.id, key }).update({ locked_at: new Date(Date.now() - 3600_000) });
    const takenOver = await fund(user.token, { amountKobo: 500_000 }, key);
    expect(takenOver.status).toBe(201);
  });

  test('records expire: an expired key is treated as new', async () => {
    const user = await createUserAndLogin(app);
    const key = newKey();
    const first = await fund(user.token, { amountKobo: 500_000 }, key).expect(201);
    await db('idempotency_keys').where({ user_id: user.id, key }).update({ expires_at: new Date(Date.now() - 1000) });
    const again = await fund(user.token, { amountKobo: 500_000 }, key);
    expect(again.status).toBe(201);
    expect(again.body.data.payment.reference).not.toBe(first.body.data.payment.reference);
  });
});

describe('mock gateway (dev endpoint) delivers duplicate webhooks', () => {
  test('"pay" sends the signed webhook 1 + duplicates times; the wallet is credited once', async () => {
    const { user, payment } = await pendingPayment(500_000);

    const res = await request(app).post(`/api/v1/dev/mock-payments/${payment.reference}/pay`).send({ duplicates: 3 });

    expect(res.status).toBe(200);
    const { deliveries } = res.body.data;
    expect(deliveries).toHaveLength(4);
    expect(deliveries.filter((d) => d.outcome === 'credited' && !d.duplicate)).toHaveLength(1);
    expect(deliveries.filter((d) => d.duplicate)).toHaveLength(3);
    expect(await balanceOf(user.id)).toBe(500_000);
  });
});

describe('database guards on payments', () => {
  async function succeededPayment() {
    const { payment } = await paidPayment(100_000);
    await deliver(payment.reference).expect(200);
    return payment;
  }
  const expectDbError = (promise, pattern) => expect(promise).rejects.toThrow(pattern);

  test('amount, user and reference can never change', async () => {
    const { payment } = await pendingPayment();
    await expectDbError(db('payments').where({ reference: payment.reference }).update({ amount_kobo: 1 }), /PAYMENT_IMMUTABLE/);
    await expectDbError(db('payments').where({ reference: payment.reference }).update({ reference: 'KM-changed-00000' }), /PAYMENT_IMMUTABLE/);
  });

  test('a SUCCEEDED payment can never go back to PENDING, and payments are never deleted', async () => {
    const payment = await succeededPayment();
    await expectDbError(db('payments').where({ reference: payment.reference }).update({ status: 'PENDING' }), /PAYMENT_INVALID_STATUS/);
    await expectDbError(db('payments').where({ reference: payment.reference }).del(), /PAYMENT_UNDELETABLE/);
  });

  test('a payment cannot be SUCCEEDED without a ledger transaction', async () => {
    const { payment } = await pendingPayment();
    await expect(db('payments').where({ reference: payment.reference }).update({ status: 'SUCCEEDED' })).rejects.toThrow(/payments_succeeded_has_ledger_chk/);
  });

  test('non-positive amounts and non-NGN currency are refused by the database', async () => {
    const user = await createUserAndLogin(app);
    await expect(db('payments').insert({ user_id: user.id, reference: 'KM-zero-amount-1', provider: 'mock', amount_kobo: 0 })).rejects.toThrow(/payments_amount_chk/);
    await expect(db('payments').insert({ user_id: user.id, reference: 'KM-usd-currency-1', provider: 'mock', amount_kobo: 100, currency: 'USD' })).rejects.toThrow(/payments_currency_chk/);
  });
});

describe('ledger audit with payments', () => {
  test('passes after all the funding above', async () => {
    const result = await runAudit();
    expect(result.checks.filter((c) => !c.pass)).toEqual([]);
  });

  test('FAILS when a successful payment no longer matches its ledger amount (tampering, rolled back)', async () => {
    const { payment } = await paidPayment(100_000);
    await deliver(payment.reference).expect(200);

    let result;
    await db
      .transaction(async (trx) => {
        await trx.raw('ALTER TABLE payments DISABLE TRIGGER USER');
        await trx('payments').where({ reference: payment.reference }).update({ amount_kobo: 999_999 });
        result = await runAudit(trx);
        throw new Error('ROLLBACK_ON_PURPOSE');
      })
      .catch((e) => {
        if (e.message !== 'ROLLBACK_ON_PURPOSE') throw e;
      });

    expect(result.pass).toBe(false);
    expect(result.checks.filter((c) => !c.pass).map((c) => c.name).join('|')).toMatch(/top-up payment/);
    expect((await runAudit()).pass).toBe(true);
  });

  test('platform books balance: EXTERNAL is negative by exactly the money funded', async () => {
    const result = await runAudit();
    expect(result.totals.fundedKobo).toBeGreaterThan(0);
    const external = await db('accounts').where({ owner_type: 'SYSTEM', owner_id: 'PLATFORM_EXTERNAL' }).first();
    expect(external.balance_kobo).toBe(-(result.totals.fundedKobo - result.totals.paidOutKobo));
    expect(await getAccount(external.id)).toBeTruthy();
  });
});
