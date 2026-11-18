const backend = require('../helpers/backend'); // must come before the app (installs mocks)
const request = require('supertest');
const createApp = require('../../src/app');
const { db } = require('../../src/config/postgres');
const { createUserAndLogin, bearer } = require('../helpers/users');
const { createVendor, createProduct } = require('../helpers/catalog');
const { fundWallet, addToCart, checkout } = require('../helpers/orders');

const app = createApp();
let admin;
let vendor;

beforeAll(async () => {
  await backend.start();
  admin = await createUserAndLogin(app, { roles: ['buyer', 'admin'] });
  vendor = await createVendor(app, admin);
});
afterAll(async () => {
  await backend.stop();
  await db.destroy();
});

async function placeOrder(buyer, { quantity = 1 } = {}) {
  const p = await createProduct(app, vendor, { priceKobo: 50_000, stock: 50 });
  await addToCart(app, buyer, { productId: p.id, quantity }).expect(201);
  return (await checkout(app, buyer).expect(201)).body.data.order;
}

describe('GET /orders and GET /orders/:id', () => {
  test('need authentication', async () => {
    expect((await request(app).get('/api/v1/orders')).status).toBe(401);
    expect((await request(app).get('/api/v1/orders/00000000-0000-4000-8000-000000000000')).status).toBe(401);
  });

  test('a buyer lists only their own orders, newest first, with cursor pagination', async () => {
    const buyer = await createUserAndLogin(app);
    const other = await createUserAndLogin(app);
    await fundWallet(buyer.id, 5_000_000);
    await fundWallet(other.id, 5_000_000);
    const placed = [];
    for (let i = 0; i < 5; i += 1) placed.push(await placeOrder(buyer));
    await placeOrder(other);

    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const res = await request(app).get(`/api/v1/orders?limit=2${cursor ? `&cursor=${cursor}` : ''}`).set(bearer(buyer.token));
      expect(res.status).toBe(200);
      seen.push(...res.body.data.orders);
      cursor = res.body.data.nextCursor;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen.map((o) => o.id)).toEqual([...placed].reverse().map((o) => o.id));
    expect(seen[0].subOrders[0].items).toHaveLength(1);
  });

  test('a buyer reads their order; someone else gets 404; an admin can read it', async () => {
    const buyer = await createUserAndLogin(app);
    const stranger = await createUserAndLogin(app);
    await fundWallet(buyer.id, 1_000_000);
    const order = await placeOrder(buyer, { quantity: 2 });

    const mine = await request(app).get(`/api/v1/orders/${order.id}`).set(bearer(buyer.token));
    expect(mine.status).toBe(200);
    expect(mine.body.data.order).toMatchObject({ id: order.id, status: 'PAID', totalKobo: 100_000 });
    expect(JSON.stringify(mine.body)).not.toMatch(/idempotency|payment_transaction|stockDecremented|vendorUserId/i);

    expect((await request(app).get(`/api/v1/orders/${order.id}`).set(bearer(stranger.token))).status).toBe(404);
    expect((await request(app).get(`/api/v1/orders/${order.id}`).set(bearer(admin.token))).status).toBe(200);
  });

  test.each(['/api/v1/orders/not-a-uuid', '/api/v1/orders?limit=0', '/api/v1/orders?cursor=garbage'])('rejects %s with 422', async (url) => {
    const buyer = await createUserAndLogin(app);
    expect((await request(app).get(url).set(bearer(buyer.token))).status).toBe(422);
  });

  test('an unknown order id is 404', async () => {
    const buyer = await createUserAndLogin(app);
    expect((await request(app).get('/api/v1/orders/00000000-0000-4000-8000-000000000000').set(bearer(buyer.token))).status).toBe(404);
  });
});
