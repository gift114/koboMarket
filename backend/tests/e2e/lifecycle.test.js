const backend = require('../helpers/backend'); // must come before the app (installs mocks)
const request = require('supertest');
const createApp = require('../../src/app');
const { db } = require('../../src/config/postgres');
const bus = require('../../src/events/bus');
const { runAudit } = require('../../src/modules/audit/ledgerAudit.service');
const payoutsService = require('../../src/modules/payouts/payouts.service');
const { createUserAndLogin, bearer } = require('../helpers/users');
const { createVendor, createProduct } = require('../helpers/catalog');
const { fundWallet, walletBalance, escrowBalance, addToCart, checkout, newKey } = require('../helpers/orders');

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

const notificationTypes = async (user) => {
  await bus.idle();
  const res = await request(app).get('/api/v1/notifications').set(bearer(user.token)).expect(200);
  return res.body.data.notifications.map((n) => n.type);
};

describe('whole marketplace lifecycle through the public API', () => {
  test('fund -> buy -> escrow -> ship -> confirm -> commission -> payout -> notifications -> audit', async () => {
    const vendor = await createVendor(app, admin);
    const buyer = await createUserAndLogin(app);
    await fundWallet(buyer.id, 1_000_000);
    const product = await createProduct(app, vendor, { priceKobo: 400_000, stock: 5 });

    const escrow0 = await escrowBalance();
    await addToCart(app, buyer, { productId: product.id, quantity: 2 }).expect(201);
    const order = (await checkout(app, buyer).expect(201)).body.data.order;
    const subId = order.subOrders[0].id;

    // Buyer paid 800,000 kobo; it sits in escrow, the vendor has nothing yet.
    expect(await walletBalance(buyer.id)).toBe(200_000);
    expect(await escrowBalance()).toBe(escrow0 + 800_000);
    expect(await walletBalance(vendor.id)).toBe(0);

    await request(app).post(`/api/v1/orders/sub-orders/${subId}/ship`).set(bearer(vendor.token)).expect(200);
    await request(app).post(`/api/v1/orders/sub-orders/${subId}/confirm-delivery`).set(bearer(buyer.token)).expect(200);

    // 5% commission (500 bps) on 800,000 = 40,000; vendor gets 760,000; escrow returns to its start.
    expect(await walletBalance(vendor.id)).toBe(760_000);
    expect(await escrowBalance()).toBe(escrow0);
    expect((await db('orders').where({ id: order.id }).first()).status).toBe('COMPLETED');

    // Vendor withdraws; the background job settles it.
    const payout = (await request(app).post('/api/v1/payouts').set(bearer(vendor.token))
      .set('Idempotency-Key', newKey()).send({ amountKobo: 700_000 }).expect(201)).body.data.payout;
    expect(await walletBalance(vendor.id)).toBe(60_000);
    await payoutsService.processPending();
    expect((await db('payouts').where({ id: payout.id }).first()).status).toBe('SUCCESS');

    expect(await notificationTypes(buyer)).toEqual(expect.arrayContaining(['ORDER_PLACED']));
    expect(await notificationTypes(vendor)).toEqual(expect.arrayContaining(['NEW_ORDER', 'FUNDS_RELEASED', 'PAYOUT_SUCCESS']));

    const audit = await runAudit();
    expect(audit.checks.filter((c) => !c.pass)).toEqual([]);
    expect(audit.pass).toBe(true);
  });
});
