const backend = require('../helpers/backend'); // must come before the app (installs mocks)
const request = require('supertest');
const createApp = require('../../src/app');
const { db } = require('../../src/config/postgres');
const reports = require('../../src/modules/reports/reports.service');
const { createUserAndLogin, bearer } = require('../helpers/users');
const { createVendor, createProduct } = require('../helpers/catalog');
const { fundWallet, addToCart, checkout } = require('../helpers/orders');

const app = createApp();
let admin;

beforeAll(async () => {
  await backend.start();
  admin = await createUserAndLogin(app, { roles: ['buyer', 'admin'] });
});
afterAll(async () => {
  await backend.stop();
  await db.destroy();
});

const get = (user, path) => request(app).get(`/api/v1/admin/reports${path}`).set(bearer(user.token));
const post = (user, subId, action, body) => request(app).post(`/api/v1/orders/sub-orders/${subId}/${action}`).set(bearer(user.token)).send(body);

/** A sale of `priceKobo` that is shipped and confirmed (vendor earns 95%, platform 5%). */
async function completedSale(vendor, priceKobo) {
  const buyer = await createUserAndLogin(app);
  await fundWallet(buyer.id, priceKobo * 2);
  const product = await createProduct(app, vendor, { priceKobo, stock: 5 });
  await addToCart(app, buyer, { productId: product.id, quantity: 1 }).expect(201);
  const sub = (await checkout(app, buyer).expect(201)).body.data.order.subOrders[0].id;
  await post(vendor, sub, 'ship').expect(200);
  await post(buyer, sub, 'confirm-delivery').expect(200);
  return { buyer, sub };
}

describe('access', () => {
  test('every report is admin only', async () => {
    const buyer = await createUserAndLogin(app);
    for (const path of ['/revenue-by-day', '/top-vendors', '/escrow', '/reconciliation']) {
      expect([path, (await get(buyer, path)).status]).toEqual([path, 403]);
      expect([path, (await request(app).get(`/api/v1/admin/reports${path}`)).status]).toEqual([path, 401]);
    }
  });
});

describe('revenue by day', () => {
  test('is zero-filled, ordered, and today\'s figure rises by exactly the commission earned', async () => {
    const vendor = await createVendor(app, admin);
    const before = (await get(admin, '/revenue-by-day?days=3').expect(200)).body.data;
    expect(before.byDay).toHaveLength(3);
    expect(before.byDay.map((d) => d.day)).toEqual([...before.byDay.map((d) => d.day)].sort());
    const today = new Date().toISOString().slice(0, 10);
    expect(before.byDay[2].day).toBe(today);
    expect(before.byDay[0].revenueKobo).toBe(0); // nothing happened two days ago: still listed, as zero

    await completedSale(vendor, 200_000); // 5% = 10,000
    const partial = await completedSale(vendor, 100_000); // 5,000
    expect(partial.sub).toBeTruthy();
    const after = (await get(admin, '/revenue-by-day?days=3').expect(200)).body.data;
    expect(after.byDay[2].revenueKobo - before.byDay[2].revenueKobo).toBe(15_000);
    expect(after.byDay[2].transactions - before.byDay[2].transactions).toBe(2);
    expect(after.totalKobo).toBe(after.byDay.reduce((s, d) => s + d.revenueKobo, 0));
  });

  test('matches the platform revenue account exactly over a long window', async () => {
    const rows = (await get(admin, '/revenue-by-day?days=366').expect(200)).body.data;
    const account = await db('accounts').where({ owner_type: 'SYSTEM', owner_id: 'PLATFORM_REVENUE' }).first();
    expect(rows.byDay).toHaveLength(366);
    expect(rows.totalKobo).toBe(Number(account.balance_kobo));
  });

  test('rejects bad day counts', async () => {
    for (const d of ['0', '367', 'abc', '-1']) expect([d, (await get(admin, `/revenue-by-day?days=${d}`)).status]).toEqual([d, 422]);
  });
});

describe('top 10 vendors this month', () => {
  test('ranks by earnings after commission, at most 10, biggest first', async () => {
    const vendors = [];
    for (let i = 0; i < 11; i += 1) vendors.push(await createVendor(app, admin));
    // vendor i sells (10,000,000 + i * 1,000,000) kobo: far more than any other test's data
    for (const [i, v] of vendors.entries()) await completedSale(v, 10_000_000 + i * 1_000_000);

    const res = (await get(admin, '/top-vendors').expect(200)).body.data;
    expect(res.month).toBe(new Date().toISOString().slice(0, 7));
    expect(res.vendors).toHaveLength(10);
    expect(res.vendors.map((v) => v.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(res.vendors.map((v) => v.vendorId)).toEqual(vendors.slice(1).reverse().map((v) => v.vendorId)); // vendor 0, the smallest, is out
    const top = res.vendors[0];
    expect(top).toMatchObject({ earnedKobo: 20_000_000 * 0.95, commissionKobo: 20_000_000 * 0.05, subOrders: 1 });
    expect(top.storeName).toMatch(/^Catalog Store/);
    expect(res.vendors.every((v, i, a) => i === 0 || a[i - 1].earnedKobo >= v.earnedKobo)).toBe(true);
  });

  test('other months are separate; a dispute settlement counts for the vendor\'s share only', async () => {
    expect((await get(admin, '/top-vendors?month=2020-01').expect(200)).body.data).toEqual({ month: '2020-01', vendors: [] });
    for (const bad of ['2026-13', '2026-1', 'november', '2026']) expect([bad, (await get(admin, `/top-vendors?month=${bad}`)).status]).toEqual([bad, 422]);

    const vendor = await createVendor(app, admin);
    const buyer = await createUserAndLogin(app);
    await fundWallet(buyer.id, 900_000_000);
    const p = await createProduct(app, vendor, { priceKobo: 500_000_000, stock: 2 });
    await addToCart(app, buyer, { productId: p.id, quantity: 1 }).expect(201);
    const sub = (await checkout(app, buyer).expect(201)).body.data.order.subOrders[0].id;
    await post(vendor, sub, 'ship').expect(200);
    const d = (await post(buyer, sub, 'dispute', { reason: 'Half of it was damaged.' }).expect(201)).body.data.dispute;
    await request(app).post(`/api/v1/disputes/${d.id}/resolve`).set(bearer(admin.token)).send({ resolution: 'PARTIAL_REFUND', refundKobo: 100_000_000, note: 'Partial credit' }).expect(200);

    const res = (await get(admin, '/top-vendors').expect(200)).body.data;
    expect(res.vendors[0]).toMatchObject({ vendorId: vendor.vendorId, earnedKobo: 380_000_000, commissionKobo: 20_000_000 }); // 400M - 5%
  });
});

describe('escrow total', () => {
  test('equals the escrow account, split by status, and shows money frozen by disputes', async () => {
    const vendor = await createVendor(app, admin);
    const buyer = await createUserAndLogin(app);
    await fundWallet(buyer.id, 1_000_000);
    const p = await createProduct(app, vendor, { priceKobo: 123_400, stock: 5 });
    await addToCart(app, buyer, { productId: p.id, quantity: 1 }).expect(201);
    const sub = (await checkout(app, buyer).expect(201)).body.data.order.subOrders[0].id;

    const paid = (await get(admin, '/escrow').expect(200)).body.data;
    expect(paid.inSync).toBe(true);
    expect(paid.escrowAccountKobo).toBe(paid.heldBySubOrdersKobo);
    expect(paid.byStatus.reduce((s, r) => s + r.escrowKobo, 0)).toBe(paid.escrowAccountKobo);
    const paidRow = paid.byStatus.find((r) => r.status === 'PAID');
    expect(paidRow.escrowKobo).toBeGreaterThanOrEqual(123_400);

    await post(vendor, sub, 'ship').expect(200);
    await post(buyer, sub, 'dispute', { reason: 'Parcel was empty on arrival.' }).expect(201);
    const disputed = (await get(admin, '/escrow').expect(200)).body.data;
    expect(disputed.inDisputeKobo - paid.inDisputeKobo).toBe(123_400);
    expect(disputed.escrowAccountKobo).toBe(paid.escrowAccountKobo); // frozen, not moved
    expect(disputed.inSync).toBe(true);
  });
});

describe('reconciliation', () => {
  test('is EMPTY on a healthy system', async () => {
    const res = (await get(admin, '/reconciliation').expect(200)).body.data;
    expect(res.discrepancies).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.checksRun).toBeGreaterThanOrEqual(10);
  });

  test('reports a discrepancy the moment the books disagree (rolled back)', async () => {
    let tampered;
    await db
      .transaction(async (trx) => {
        await trx.raw('ALTER TABLE sub_orders DISABLE TRIGGER USER');
        const sub = await trx('sub_orders').where('escrow_held_kobo', '>', 0).first();
        await trx('sub_orders').where({ id: sub.id }).update({ escrow_held_kobo: sub.escrow_held_kobo - 1 });
        tampered = await reports.reconciliation(trx);
        throw new Error('ROLLBACK_ON_PURPOSE');
      })
      .catch((e) => {
        if (e.message !== 'ROLLBACK_ON_PURPOSE') throw e;
      });
    expect(tampered.ok).toBe(false);
    expect(tampered.discrepancies.length).toBeGreaterThan(0);
    expect(tampered.discrepancies[0]).toEqual({ rule: expect.any(String), rows: expect.any(Array) });
    expect((await get(admin, '/reconciliation').expect(200)).body.data.discrepancies).toEqual([]); // and the rollback left no trace
  });
});
