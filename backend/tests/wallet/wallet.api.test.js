const backend = require('../helpers/backend'); // must come before the app (installs mocks)
const request = require('supertest');
const createApp = require('../../src/app');
const ledger = require('../../src/modules/wallet/ledger.service');
const accountRepository = require('../../src/modules/wallet/account.repository');
const { createUserAndLogin, bearer } = require('../helpers/users');
const { SYSTEM_ACCOUNT, TRANSACTION_TYPE } = require('../../src/db/constants');

const app = createApp();
beforeAll(() => backend.start());
afterAll(() => backend.stop());

const getWallet = (token) => request(app).get('/api/v1/wallet').set(bearer(token));
const getTransactions = (token, query = '') => request(app).get(`/api/v1/wallet/transactions${query}`).set(bearer(token));

async function fundUser(user, kobo, extra = {}) {
  const account = await accountRepository.createUserAccountIfMissing(user.id);
  const external = await accountRepository.getSystemAccountId(SYSTEM_ACCOUNT.EXTERNAL);
  await ledger.transfer({
    fromAccountId: external,
    toAccountId: account.id,
    amountKobo: kobo,
    type: TRANSACTION_TYPE.WALLET_FUNDING,
    ...extra,
  });
  return account;
}

describe('GET /wallet', () => {
  test('requires authentication', async () => {
    expect((await request(app).get('/api/v1/wallet')).status).toBe(401);
    expect((await request(app).get('/api/v1/wallet/transactions')).status).toBe(401);
  });

  test('a user whose wallet is still pending gets one created on first use, with a zero balance', async () => {
    const user = await createUserAndLogin(app); // created straight in the DB: no wallet yet
    expect(await accountRepository.findUserAccount(user.id)).toBeNull();

    const res = await getWallet(user.token);

    expect(res.status).toBe(200);
    expect(res.body.data.wallet).toMatchObject({ currency: 'NGN', balanceKobo: 0, status: 'ACTIVE', balanceDisplay: 'N0.00' });
    expect(await accountRepository.findUserAccount(user.id)).not.toBeNull();
  });

  test('shows the balance as integer kobo', async () => {
    const user = await createUserAndLogin(app);
    await fundUser(user, 150_050);

    const { wallet } = (await getWallet(user.token)).body.data;
    expect(wallet.balanceKobo).toBe(150_050);
    expect(Number.isInteger(wallet.balanceKobo)).toBe(true);
    expect(wallet.balanceDisplay).toBe('N1,500.50');
  });

  test('every user only ever sees their own wallet', async () => {
    const alice = await createUserAndLogin(app);
    const bob = await createUserAndLogin(app);
    await fundUser(alice, 5_000);
    await fundUser(bob, 9_000);

    expect((await getWallet(alice.token)).body.data.wallet.balanceKobo).toBe(5_000);
    expect((await getWallet(bob.token)).body.data.wallet.balanceKobo).toBe(9_000);
  });
});

describe('GET /wallet/transactions', () => {
  test('lists entries newest first with the balance after each one', async () => {
    const user = await createUserAndLogin(app);
    const account = await fundUser(user, 10_000, { metadata: { description: 'Wallet top-up' } });
    const other = await accountRepository.createUserAccountIfMissing((await createUserAndLogin(app)).id);
    await ledger.transfer({ fromAccountId: account.id, toAccountId: other.id, amountKobo: 3_000, type: TRANSACTION_TYPE.ORDER_PAYMENT });

    const res = await getTransactions(user.token);

    expect(res.status).toBe(200);
    const { transactions, nextCursor } = res.body.data;
    expect(nextCursor).toBeNull();
    expect(transactions.map((t) => [t.type, t.direction, t.amountKobo, t.balanceAfterKobo])).toEqual([
      ['ORDER_PAYMENT', 'debit', 3_000, 7_000],
      ['WALLET_FUNDING', 'credit', 10_000, 10_000],
    ]);
    expect(transactions[1].description).toBe('Wallet top-up');
    expect(transactions[0].reference).toMatch(/^ORDER_PAYMENT-/);
  });

  test('cursor pagination walks the whole history exactly once', async () => {
    const user = await createUserAndLogin(app);
    for (let i = 0; i < 5; i += 1) await fundUser(user, 1_000 + i);

    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const res = await getTransactions(user.token, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.transactions);
      cursor = res.body.data.nextCursor;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen.map((t) => t.id)).size).toBe(5);
    expect(seen[0].balanceAfterKobo).toBe(1_000 + 1_001 + 1_002 + 1_003 + 1_004);
    expect(seen[4].balanceAfterKobo).toBe(1_000);
  });

  test('filtering does not distort the running balance', async () => {
    const user = await createUserAndLogin(app);
    const account = await fundUser(user, 10_000);
    const other = await accountRepository.createUserAccountIfMissing((await createUserAndLogin(app)).id);
    await ledger.transfer({ fromAccountId: account.id, toAccountId: other.id, amountKobo: 4_000 });

    const debits = (await getTransactions(user.token, '?direction=debit')).body.data.transactions;
    expect(debits).toHaveLength(1);
    expect(debits[0].balanceAfterKobo).toBe(6_000); // still 10,000 - 4,000, not -4,000

    const fundings = (await getTransactions(user.token, '?type=WALLET_FUNDING')).body.data.transactions;
    expect(fundings).toHaveLength(1);
  });

  test("never includes another user's entries", async () => {
    const alice = await createUserAndLogin(app);
    const bob = await createUserAndLogin(app);
    await fundUser(alice, 1_234);
    await fundUser(bob, 5_678);

    const { transactions } = (await getTransactions(alice.token)).body.data;
    expect(transactions).toHaveLength(1);
    expect(transactions[0].amountKobo).toBe(1_234);
  });

  test.each(['?limit=0', '?limit=101', '?limit=abc', '?cursor=-1', '?direction=up', '?type=NOPE'])(
    'rejects invalid query %s with 422',
    async (query) => {
      const user = await createUserAndLogin(app);
      const res = await getTransactions(user.token, query);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    },
  );
});
