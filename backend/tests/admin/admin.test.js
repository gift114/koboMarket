const backend = require('../helpers/backend'); // must come before the app (installs mocks)
const request = require('supertest');
const createApp = require('../../src/app');
const { db } = require('../../src/config/postgres');
const { runAudit } = require('../../src/modules/audit/ledgerAudit.service');
const { createUser, createUserAndLogin, login, bearer } = require('../helpers/users');
const { createVendor, createProduct } = require('../helpers/catalog');
const { fundWallet, walletBalance, addToCart, checkout, newKey } = require('../helpers/orders');

const app = createApp();
let admin;

beforeAll(async () => {
  await backend.start();
  admin = await createUserAndLogin(app, { roles: ['buyer', 'admin'] });
});
afterAll(async () => {
  await db('platform_settings').del(); // do not leak a custom rate into other suites
  await backend.stop();
  await db.destroy();
});

const as = (user, method, path, body) => {
  const r = request(app)[method](`/api/v1${path}`).set(bearer(user.token));
  return body === undefined ? r : r.send(body);
};
const post = (user, subId, action) => request(app).post(`/api/v1/orders/sub-orders/${subId}/${action}`).set(bearer(user.token));

describe('admin: list and search users', () => {
  test('admin only; never exposes secrets; filters by text, role and status; paginates', async () => {
    const buyer = await createUserAndLogin(app);
    expect((await as(buyer, 'get', '/admin/users')).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/users')).status).toBe(401);

    const tag = `zebra${Date.now()}`;
    const mk = (n) => createUser({ email: `${tag}.${n}@example.com` });
    const [u1, u2, u3] = [await mk(1), await mk(2), await mk(3)];
    await as(admin, 'patch', `/admin/users/${u2.id}/freeze`).expect(200);

    const found = await as(admin, 'get', `/admin/users?q=${tag.toUpperCase()}&limit=50`).expect(200); // case-insensitive
    expect(found.body.data.users.map((u) => u.id).sort()).toEqual([u1.id, u2.id, u3.id].sort());
    expect(JSON.stringify(found.body)).not.toMatch(/passwordHash|tokenVersion|\$2[aby]\$/);
    expect(found.body.data.users[0]).toEqual(expect.objectContaining({ email: expect.any(String), roles: expect.any(Array), status: expect.any(String), walletStatus: expect.any(String) }));

    const frozen = await as(admin, 'get', `/admin/users?q=${tag}&status=frozen`).expect(200);
    expect(frozen.body.data.users.map((u) => u.id)).toEqual([u2.id]);
    const admins = await as(admin, 'get', '/admin/users?role=admin&limit=100').expect(200);
    expect(admins.body.data.users.every((u) => u.roles.includes('admin'))).toBe(true);

    const page1 = await as(admin, 'get', `/admin/users?q=${tag}&limit=2`).expect(200);
    expect(page1.body.data.users).toHaveLength(2);
    expect(page1.body.data.nextCursor).toBeTruthy();
    const page2 = await as(admin, 'get', `/admin/users?q=${tag}&limit=2&cursor=${page1.body.data.nextCursor}`).expect(200);
    expect(page2.body.data.users).toHaveLength(1);
    expect(page2.body.data.nextCursor).toBeNull();
    expect([...page1.body.data.users, ...page2.body.data.users].map((u) => u.id).sort()).toEqual([u1.id, u2.id, u3.id].sort());
  });

  test('the search text is matched literally (no regex injection) and bad input is rejected', async () => {
    const res = await as(admin, 'get', '/admin/users?q=.*').expect(200);
    expect(res.body.data.users.every((u) => (u.email + u.fullName).includes('.*'))).toBe(true);
    expect((await as(admin, 'get', '/admin/users?role=king')).status).toBe(422);
    expect((await as(admin, 'get', '/admin/users?limit=1000')).status).toBe(422);
    expect((await as(admin, 'get', '/admin/users?cursor=zzz')).status).toBe(422);
  });
});

describe('admin: freeze and unfreeze', () => {
  test('a frozen user can still log in and read, but cannot place orders or withdraw; unfreezing restores both', async () => {
    const vendor = await createVendor(app, admin);
    await fundWallet(vendor.id, 500_000);
    const buyer = await createUserAndLogin(app);
    await fundWallet(buyer.id, 1_000_000);
    const product = await createProduct(app, vendor, { priceKobo: 50_000 });
    await addToCart(app, buyer, { productId: product.id, quantity: 1 }).expect(201);

    const frozen = await as(admin, 'patch', `/admin/users/${buyer.id}/freeze`).expect(200);
    expect(frozen.body.data.user.status).toBe('frozen');

    await login(app, buyer); // can log in
    expect((await as(buyer, 'get', '/wallet')).status).toBe(200); // and look around
    const order = await checkout(app, buyer);
    expect(order.status).toBe(403);
    expect(order.body.error.code).toBe('ACCOUNT_FROZEN');
    expect(await walletBalance(buyer.id)).toBe(1_000_000);

    await as(admin, 'patch', `/admin/users/${vendor.id}/freeze`).expect(200);
    const payout = await request(app).post('/api/v1/payouts').set(bearer(vendor.token)).set('Idempotency-Key', newKey()).send({ amountKobo: 100_000 });
    expect(payout.status).toBe(403);
    expect(payout.body.error.code).toBe('ACCOUNT_FROZEN');
    expect(await walletBalance(vendor.id)).toBe(500_000);
    expect(await db('payouts').where({ user_id: vendor.id })).toHaveLength(0);

    await as(admin, 'patch', `/admin/users/${buyer.id}/unfreeze`).expect(200);
    await as(admin, 'patch', `/admin/users/${vendor.id}/unfreeze`).expect(200);
    await checkout(app, buyer).expect(201);
    await request(app).post('/api/v1/payouts').set(bearer(vendor.token)).set('Idempotency-Key', newKey()).send({ amountKobo: 100_000 }).expect(201);
    await require('../../src/modules/payouts/payouts.service').processPending();
  });

  test('a frozen user cannot place a NEW order, while a retry of an order placed before the freeze just replays it', async () => {
    const vendor = await createVendor(app, admin);
    const buyer = await createUserAndLogin(app);
    await fundWallet(buyer.id, 1_000_000);
    const product = await createProduct(app, vendor, { priceKobo: 50_000 });
    await addToCart(app, buyer, { productId: product.id, quantity: 1 }).expect(201);
    const key = newKey();
    await checkout(app, buyer, { key }).expect(201);
    await as(admin, 'patch', `/admin/users/${buyer.id}/freeze`).expect(200);
    const replay = await checkout(app, buyer, { key }); // same key: the stored response of the order that already exists
    expect(replay.status).toBe(201);
    expect(await db('orders').where({ buyer_id: buyer.id })).toHaveLength(1);
    await addToCart(app, buyer, { productId: (await createProduct(app, vendor, { priceKobo: 10_000 })).id, quantity: 1 }).expect(201);
    expect((await checkout(app, buyer)).status).toBe(403); // a new key is a new order: refused
  });

  test('freezing is idempotent; you cannot freeze yourself or another admin; unknown or malformed ids fail cleanly', async () => {
    const buyer = await createUser();
    await as(admin, 'patch', `/admin/users/${buyer.id}/freeze`).expect(200);
    expect((await as(admin, 'patch', `/admin/users/${buyer.id}/freeze`)).body.data.user.status).toBe('frozen');
    expect((await as(admin, 'patch', `/admin/users/${buyer.id}/unfreeze`)).body.data.user.status).toBe('active');
    expect((await as(admin, 'patch', `/admin/users/${buyer.id}/unfreeze`)).body.data.user.status).toBe('active');

    const self = await as(admin, 'patch', `/admin/users/${admin.id}/freeze`);
    expect([self.status, self.body.error.code]).toEqual([409, 'CANNOT_FREEZE_SELF']);
    const otherAdmin = await createUser({ roles: ['buyer', 'admin'] });
    const other = await as(admin, 'patch', `/admin/users/${otherAdmin.id}/freeze`);
    expect([other.status, other.body.error.code]).toEqual([409, 'CANNOT_FREEZE_ADMIN']);

    expect((await as(admin, 'patch', '/admin/users/aaaaaaaaaaaaaaaaaaaaaaaa/freeze')).status).toBe(404);
    expect((await as(admin, 'patch', '/admin/users/not-an-id/freeze')).status).toBe(422);
    const plain = await createUserAndLogin(app);
    expect((await as(plain, 'patch', `/admin/users/${buyer.id}/freeze`)).status).toBe(403);
  });
});

describe('admin: view any wallet and its ledger', () => {
  test('balance, status and the ledger history with a running balance; admin only', async () => {
    const user = await createUserAndLogin(app);
    await fundWallet(user.id, 300_000);
    await fundWallet(user.id, 200_000);

    const wallet = await as(admin, 'get', `/admin/wallets/${user.id}`).expect(200);
    expect(wallet.body.data.wallet).toMatchObject({ balanceKobo: 500_000, status: 'ACTIVE', currency: 'NGN' });

    const ledger = await as(admin, 'get', `/admin/wallets/${user.id}/ledger`).expect(200);
    expect(ledger.body.data.transactions.map((t) => [t.direction, t.amountKobo, t.balanceAfterKobo])).toEqual([
      ['credit', 200_000, 500_000],
      ['credit', 300_000, 300_000],
    ]);
    const page = await as(admin, 'get', `/admin/wallets/${user.id}/ledger?limit=1`).expect(200);
    expect(page.body.data.transactions).toHaveLength(1);
    expect(page.body.data.nextCursor).toBeTruthy();

    expect((await as(user, 'get', `/admin/wallets/${user.id}`)).status).toBe(403); // not even your own, through the admin API
    expect((await as(user, 'get', `/admin/wallets/${user.id}/ledger`)).status).toBe(403);
    expect((await as(admin, 'get', '/admin/wallets/aaaaaaaaaaaaaaaaaaaaaaaa')).status).toBe(404);
    expect((await as(admin, 'get', '/admin/wallets/aaaaaaaaaaaaaaaaaaaaaaaa/ledger')).status).toBe(404);
    expect((await as(admin, 'get', `/admin/wallets/${user.id}/ledger?direction=sideways`)).status).toBe(422);
  });
});

describe('admin: commission rate', () => {
  test('defaults to 5%; a change applies to NEW orders only and is recorded in the history', async () => {
    const initial = await as(admin, 'get', '/admin/settings/commission').expect(200);
    expect(initial.body.data.commission).toMatchObject({ rateBps: 500, ratePercent: 5, source: 'default' });

    const vendor = await createVendor(app, admin);
    const buyer = await createUserAndLogin(app);
    await fundWallet(buyer.id, 10_000_000);
    const product = await createProduct(app, vendor, { priceKobo: 100_000, stock: 50 });
    const place = async () => {
      await addToCart(app, buyer, { productId: product.id, quantity: 1 }).expect(201);
      return (await checkout(app, buyer).expect(201)).body.data.order.subOrders[0].id;
    };
    const oldSub = await place(); // placed at 5%

    const changed = await as(admin, 'put', '/admin/settings/commission', { rateBps: 1000 }).expect(200);
    expect(changed.body.data.commission).toMatchObject({ rateBps: 1000, ratePercent: 10, source: 'admin', updatedBy: admin.id });
    const newSub = await place(); // placed at 10%
    expect((await db('sub_orders').where({ id: oldSub }).first()).commission_rate_bps).toBe(500);
    expect((await db('sub_orders').where({ id: newSub }).first()).commission_rate_bps).toBe(1000);

    const revenue = async () => (await db('accounts').where({ owner_type: 'SYSTEM', owner_id: 'PLATFORM_REVENUE' }).first()).balance_kobo;
    for (const [sub, expected] of [[oldSub, 5_000], [newSub, 10_000]]) {
      await post(vendor, sub, 'ship').expect(200);
      const before = await revenue();
      await post(buyer, sub, 'confirm-delivery').expect(200);
      expect(await revenue()).toBe(before + expected);
    }

    await as(admin, 'put', '/admin/settings/commission', { rateBps: 0 }).expect(200); // 0% is allowed
    expect((await as(admin, 'get', '/admin/settings/commission')).body.data.commission.rateBps).toBe(0);
    const history = await db('platform_setting_changes').where({ key: 'commission_rate_bps' }).orderBy('id');
    expect(history.map((h) => [h.old_value, h.new_value, h.changed_by])).toEqual([[null, 1000, admin.id], [1000, 0, admin.id]]);
    expect((await runAudit()).pass).toBe(true);
  });

  test('only integers from 0 to 5000 and only admins; the history can never be edited', async () => {
    for (const bad of [-1, 5001, 7.5, '500', null, {}]) {
      expect([bad, (await as(admin, 'put', '/admin/settings/commission', { rateBps: bad })).status]).toEqual([bad, 422]);
    }
    expect((await as(admin, 'put', '/admin/settings/commission', { rateBps: 500, extra: 1 })).status).toBe(422);
    const plain = await createUserAndLogin(app);
    expect((await as(plain, 'put', '/admin/settings/commission', { rateBps: 500 })).status).toBe(403);
    expect((await as(plain, 'get', '/admin/settings/commission')).status).toBe(403);

    // the database says no as well
    await expect(db('platform_settings').insert({ key: 'commission_rate_bps', value: JSON.stringify(6000), updated_by: admin.id }).onConflict('key').merge()).rejects.toThrow(/platform_settings_commission_chk/);
    await expect(db('platform_setting_changes').update({ changed_by: 'x' })).rejects.toThrow(/SETTINGS_HISTORY_APPEND_ONLY/);
    await expect(db('platform_setting_changes').del()).rejects.toThrow(/SETTINGS_HISTORY_APPEND_ONLY/);
  });
});
