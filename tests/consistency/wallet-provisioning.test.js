const backend = require('../helpers/backend'); // must come before the app (installs mocks)
const request = require('supertest');
const createApp = require('../../src/app');
const { db } = require('../../src/config/postgres');
const config = require('../../src/config');
const userRepository = require('../../src/modules/users/user.repository');
const accountRepository = require('../../src/modules/wallet/account.repository');
const walletProvisioning = require('../../src/modules/wallet/walletProvisioning.service');
const scheduler = require('../../src/jobs/scheduler');
const { createUser, uniqueEmail, PASSWORD } = require('../helpers/users');

const app = createApp();
const IN_TEN_MINUTES = () => new Date(Date.now() + 10 * 60 * 1000); // past any grace period or backoff

const register = (email = uniqueEmail('wallet')) =>
  request(app).post('/api/v1/auth/register').send({ email, password: PASSWORD, fullName: 'Wallet Tester' });

const pgAccounts = (userId) => db('accounts').where({ owner_type: 'USER', owner_id: userId });

beforeAll(() => backend.start());
afterAll(async () => {
  await backend.stop();
  await db.destroy();
});
afterEach(() => jest.restoreAllMocks());

describe('Signup creates the PostgreSQL wallet', () => {
  test('a new user gets an empty NGN wallet and is marked ready', async () => {
    const res = await register();
    expect(res.status).toBe(201);
    const userId = res.body.data.user.id;

    const rows = await pgAccounts(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ owner_type: 'USER', currency: 'NGN', balance_kobo: 0, status: 'ACTIVE' });
    expect((await userRepository.findById(userId)).walletStatus).toBe('ready');
  });
});

describe('Cross-database consistency: user in MongoDB, wallet in PostgreSQL', () => {
  test('PostgreSQL failing at signup does not lose the registration, and the job heals it', async () => {
    jest.spyOn(accountRepository, 'createUserAccountIfMissing').mockRejectedValueOnce(new Error('postgres is down'));

    const res = await register();
    expect(res.status).toBe(201); // registration still succeeds
    const userId = res.body.data.user.id;

    // State right after the failure: user exists, no wallet, durably marked as pending.
    expect(await pgAccounts(userId)).toHaveLength(0);
    const pending = await userRepository.findById(userId);
    expect(pending.walletStatus).toBe('pending');
    expect(pending.walletAttempts).toBe(1);
    expect(pending.walletNextAttemptAt.getTime()).toBeGreaterThan(Date.now()); // backing off

    // The job does not hammer a failing dependency: before the backoff elapses, nothing to do.
    await walletProvisioning.reconcile(new Date());
    expect(await pgAccounts(userId)).toHaveLength(0);

    // Once the backoff has passed (and PostgreSQL is back), the job creates the wallet.
    const result = await walletProvisioning.reconcile(IN_TEN_MINUTES());
    expect(result.provisioned).toBeGreaterThanOrEqual(1);
    expect(await pgAccounts(userId)).toHaveLength(1);
    expect((await userRepository.findById(userId)).walletStatus).toBe('ready');
  });

  test('a user who never reached the fast path (crash after the insert) is still picked up', async () => {
    const { id } = await createUser(); // created directly: pending, wallet never attempted
    expect(await pgAccounts(id)).toHaveLength(0);

    await walletProvisioning.reconcile(new Date()); // still inside the grace period: left alone
    expect(await pgAccounts(id)).toHaveLength(0);

    await walletProvisioning.reconcile(IN_TEN_MINUTES());
    expect(await pgAccounts(id)).toHaveLength(1);
    expect((await userRepository.findById(id)).walletStatus).toBe('ready');
  });

  test('wallet created but the "ready" flag update lost: retry makes no second wallet', async () => {
    jest.spyOn(userRepository, 'markWalletReady').mockRejectedValueOnce(new Error('mongo hiccup'));

    const res = await register();
    expect(res.status).toBe(201);
    const userId = res.body.data.user.id;

    expect(await pgAccounts(userId)).toHaveLength(1); // PostgreSQL side is done...
    expect((await userRepository.findById(userId)).walletStatus).toBe('pending'); // ...MongoDB side is not

    await walletProvisioning.reconcile(IN_TEN_MINUTES());

    expect(await pgAccounts(userId)).toHaveLength(1); // still exactly one
    expect((await userRepository.findById(userId)).walletStatus).toBe('ready');
  });

  test('a registration survives even if recording the failure fails too', async () => {
    jest.spyOn(accountRepository, 'createUserAccountIfMissing').mockRejectedValueOnce(new Error('postgres is down'));
    jest.spyOn(userRepository, 'incrementWalletAttempts').mockRejectedValueOnce(new Error('mongo is down too'));

    const res = await register();
    expect(res.status).toBe(201);
    const userId = res.body.data.user.id;
    expect((await userRepository.findById(userId)).walletStatus).toBe('pending'); // still on the job's list

    await walletProvisioning.reconcile(IN_TEN_MINUTES());
    expect(await pgAccounts(userId)).toHaveLength(1);
  });

  test('repeated failures back off exponentially up to the configured cap', async () => {
    expect([1, 2, 3, 4].map(walletProvisioning.backoffSeconds)).toEqual([5, 10, 20, 40]);
    expect(walletProvisioning.backoffSeconds(1000)).toBe(config.walletProvisioning.maxBackoffSeconds);

    const { id } = await createUser();
    jest.spyOn(accountRepository, 'createUserAccountIfMissing').mockRejectedValue(new Error('still down'));

    let now = IN_TEN_MINUTES();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await walletProvisioning.reconcile(now);
      const user = await userRepository.findById(id);
      expect(user.walletAttempts).toBe(attempt);
      expect(user.walletStatus).toBe('pending');
      const expectedDelay = walletProvisioning.backoffSeconds(attempt) * 1000;
      expect(user.walletNextAttemptAt.getTime()).toBe(now.getTime() + expectedDelay);
      now = new Date(now.getTime() + expectedDelay + 1000);
    }
  });

  test('ten concurrent provisioning calls for one user create exactly one wallet', async () => {
    const { id } = await createUser();
    await Promise.all(Array.from({ length: 10 }, () => walletProvisioning.provision(id)));
    expect(await pgAccounts(id)).toHaveLength(1);
  });

  test('two job runs at the same moment never claim the same user', async () => {
    const users = await Promise.all(Array.from({ length: 5 }, () => createUser()));
    const now = IN_TEN_MINUTES();

    const [first, second] = await Promise.all([
      userRepository.claimPendingWalletUsers(now, 50, 60000),
      userRepository.claimPendingWalletUsers(now, 50, 60000),
    ]);

    expect(first.filter((id) => second.includes(id))).toEqual([]); // disjoint
    for (const { id } of users) {
      expect([...first, ...second].filter((claimed) => claimed === id)).toHaveLength(1); // each claimed once
    }
  });

  test('the account lookup used by later modules finds the wallet', async () => {
    const res = await register();
    const account = await accountRepository.findUserAccount(res.body.data.user.id);
    expect(account).toMatchObject({ currency: 'NGN', balanceKobo: 0, status: 'ACTIVE' });
  });
});

describe('Scheduler', () => {
  test('starts the wallet job and stops cleanly', () => {
    expect(() => scheduler.start()).not.toThrow();
    expect(() => scheduler.stop()).not.toThrow();
  });
});
