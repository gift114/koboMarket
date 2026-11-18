const backend = require('../helpers/backend'); // must come before anything that loads the repositories
const request = require('supertest');
const createApp = require('../../src/app');
const { db } = require('../../src/config/postgres');
const bus = require('../../src/events/bus');
const { runAudit } = require('../../src/modules/audit/ledgerAudit.service');
const reports = require('../../src/modules/reports/reports.service');
const { run, CATALOG, BUYER_FUNDING_KOBO } = require('../../src/db/seeds/seed');

const app = createApp();

beforeAll(async () => {
  await backend.start();
});
afterAll(async () => {
  await backend.stop();
  await db.destroy();
});

const login = (email, password) => request(app).post('/api/v1/auth/login').send({ email, password });

describe('seed script', () => {
  let first;

  test('creates the demo data through the real services, and the books balance afterwards', async () => {
    first = await run({ password: 'Seed#Pass1234' });
    expect(first).toMatchObject({ users: 9, vendors: 3, products: CATALOG.length, productsCreated: CATALOG.length, fundedWallets: 5 });
    expect(Object.keys(first.orders).sort()).toEqual(['completed', 'disputed', 'paid', 'shipped']);

    const status = async (id) => (await db('sub_orders').where({ id }).first()).status;
    expect(await status(first.orders.paid)).toBe('PAID');
    expect(await status(first.orders.shipped)).toBe('SHIPPED');
    expect(await status(first.orders.completed)).toBe('COMPLETED');
    expect(await status(first.orders.disputed)).toBe('DISPUTED');
    expect(await db('disputes').where({ sub_order_id: first.orders.disputed, status: 'OPEN' })).toHaveLength(1);

    expect((await runAudit()).pass).toBe(true);
    expect((await reports.reconciliation()).discrepancies).toEqual([]);
    expect((await reports.escrowTotal()).inSync).toBe(true);
  });

  test('the demo accounts can log in with the given password; roles are right', async () => {
    const admin = await login('admin@kobomarket.test', 'Seed#Pass1234').expect(200);
    expect((await request(app).get('/api/v1/admin/users?limit=100').set('Authorization', `Bearer ${admin.body.data.accessToken}`).expect(200)).body.data.users.length).toBeGreaterThanOrEqual(9);
    const vendor = await login('vendor2@kobomarket.test', 'Seed#Pass1234').expect(200);
    const sales = await request(app).get('/api/v1/orders/sales').set('Authorization', `Bearer ${vendor.body.data.accessToken}`).expect(200);
    expect(sales.body.data.subOrders.map((s) => s.status)).toEqual(['SHIPPED']);
    expect((await login('buyer1@kobomarket.test', 'wrong-password')).status).toBe(401);
  });

  test('buyers were funded once and the sold items left the stock', async () => {
    const buyer = await login('buyer5@kobomarket.test', 'Seed#Pass1234').expect(200);
    const wallet = await request(app).get('/api/v1/wallet').set('Authorization', `Bearer ${buyer.body.data.accessToken}`).expect(200);
    expect(wallet.body.data.wallet.balanceKobo).toBe(BUYER_FUNDING_KOBO); // buyer5 bought nothing
    const catalog = await request(app).get('/api/v1/products?limit=50').expect(200);
    expect(catalog.body.data.products).toHaveLength(CATALOG.length);
  });

  test('notifications were written for the demo orders', async () => {
    await bus.idle();
    const vendor = await login('vendor3@kobomarket.test', 'Seed#Pass1234').expect(200);
    const list = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${vendor.body.data.accessToken}`).expect(200);
    expect(list.body.data.notifications.map((n) => n.type).sort()).toEqual(['DISPUTE_OPENED', 'NEW_ORDER']);
  });

  test('running it again changes nothing (safe to repeat)', async () => {
    const count = async () => ({
      orders: Number((await db('orders').count('* as c').first()).c),
      transactions: Number((await db('transactions').count('* as c').first()).c),
      disputes: Number((await db('disputes').count('* as c').first()).c),
    });
    const before = await count();
    const second = await run({ password: 'Seed#Pass1234' });
    await bus.idle();
    expect(second).toMatchObject({ users: 9, products: CATALOG.length, productsCreated: 0, fundedWallets: 0 });
    expect(second.createdEmails).toEqual([]);
    expect(await count()).toEqual(before);
    expect((await runAudit()).pass).toBe(true);
    const buyer1 = await login('buyer1@kobomarket.test', 'Seed#Pass1234').expect(200);
    const wallet = await request(app).get('/api/v1/wallet').set('Authorization', `Bearer ${buyer1.body.data.accessToken}`).expect(200);
    expect(wallet.body.data.wallet.balanceKobo).toBeLessThan(BUYER_FUNDING_KOBO); // funded once, then bought
  });

  test('without SEED_PASSWORD a random password is generated and reported once', async () => {
    const { store } = require('../helpers/memory-repositories');
    if (store) store.users.delete([...store.users.values()].find((u) => u.email === 'buyer5@kobomarket.test')?.id); // only meaningful in the memory backend
    const again = await run();
    if (store) {
      expect(again.createdEmails).toEqual(['buyer5@kobomarket.test']);
      expect(again.passwordSetForNewUsers).toMatch(/^[A-Za-z0-9_-]{12}#9a$/);
    } else {
      expect(again.passwordSetForNewUsers).toMatch(/#9a$/);
    }
  });
});
