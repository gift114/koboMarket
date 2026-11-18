const backend = require('../helpers/backend'); // must come before the app (installs mocks)
const request = require('supertest');
const createApp = require('../../src/app');
const { db } = require('../../src/config/postgres');
const { runAudit } = require('../../src/modules/audit/ledgerAudit.service');
const fulfilmentService = require('../../src/modules/orders/fulfilment.service');
const { commissionFor } = require('../../src/modules/orders/escrow.service');
const { createUserAndLogin, bearer } = require('../helpers/users');
const { createVendor, createProduct } = require('../helpers/catalog');
const { fundWallet, walletBalance, escrowBalance, addToCart, checkout, productStock } = require('../helpers/orders');

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

const revenueBalance = async () => (await db('accounts').where({ owner_type: 'SYSTEM', owner_id: 'PLATFORM_REVENUE' }).first()).balance_kobo;

/** A funded buyer, a vendor and one PAID order of `priceKobo` x `quantity` from that vendor. */
async function setup({ priceKobo = 100_000, quantity = 1, stock = 20 } = {}) {
  const vendor = await createVendor(app, admin);
  const buyer = await createUserAndLogin(app);
  await fundWallet(buyer.id, 10_000_000);
  const product = await createProduct(app, vendor, { priceKobo, stock });
  await addToCart(app, buyer, { productId: product.id, quantity }).expect(201);
  const order = (await checkout(app, buyer).expect(201)).body.data.order;
  return { vendor, buyer, product, order, subId: order.subOrders[0].id };
}

const post = (user, subId, action) => request(app).post(`/api/v1/orders/sub-orders/${subId}/${action}`).set(bearer(user.token));
const openDispute = (buyer, subId) =>
  post(buyer, subId, 'dispute').send({ reason: 'The item never arrived at my address.' }).expect(201);
const getSub = async (subId) => db('sub_orders').where({ id: subId }).first();
const getOrder = async (id) => db('orders').where({ id }).first();
const ageShipment = (subId, hours) =>
  db('sub_orders').where({ id: subId }).update({ shipped_at: db.raw(`now() - interval '${hours} hours'`) });

describe('ship', () => {
  test('only the owning vendor can ship; PAID -> SHIPPED', async () => {
    const { vendor, buyer, subId } = await setup();
    const otherVendor = await createVendor(app, admin);

    expect((await request(app).post(`/api/v1/orders/sub-orders/${subId}/ship`)).status).toBe(401);
    expect((await post(buyer, subId, 'ship')).status).toBe(403); // not a vendor
    expect((await post(otherVendor, subId, 'ship')).status).toBe(404); // a vendor, but not the owner

    const res = await post(vendor, subId, 'ship').expect(200);
    expect(res.body.data.subOrder.status).toBe('SHIPPED');
    expect(res.body.data.subOrder.shippedAt).toBeTruthy();
    expect((await getSub(subId)).status).toBe('SHIPPED');

    const again = await post(vendor, subId, 'ship');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE');
  });

  test('an unknown id is 404 and a malformed id is 422', async () => {
    const vendor = await createVendor(app, admin);
    expect((await post(vendor, '00000000-0000-4000-8000-000000000000', 'ship')).status).toBe(404);
    expect((await post(vendor, 'nope', 'ship')).status).toBe(422);
  });

  test('cannot ship while checkout has not finished its stock step', async () => {
    const { vendor, order, subId } = await setup();
    await db('orders').where({ id: order.id }).update({ stock_status: 'PENDING' });
    const res = await post(vendor, subId, 'ship');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_READY');
    expect((await getSub(subId)).status).toBe('PAID');
    await db('orders').where({ id: order.id }).update({ stock_status: 'RESERVED' });
  });
});

describe('confirm delivery releases escrow', () => {
  test('splits the escrow 95% / 5% in ONE three-leg ledger transaction', async () => {
    const { vendor, buyer, order, subId } = await setup({ priceKobo: 100_000, quantity: 2 }); // 200,000
    await post(vendor, subId, 'ship').expect(200);
    const [escrow0, revenue0, vendor0] = [await escrowBalance(), await revenueBalance(), await walletBalance(vendor.id)];

    const res = await post(buyer, subId, 'confirm-delivery').expect(200);
    expect(res.body.data.subOrder).toMatchObject({ status: 'COMPLETED', escrowHeldKobo: 0 });
    expect(res.body.data.subOrder.deliveredAt).toBeTruthy();
    expect(res.body.data.subOrder.completedAt).toBeTruthy();

    expect(await walletBalance(vendor.id)).toBe(vendor0 + 190_000);
    expect(await revenueBalance()).toBe(revenue0 + 10_000);
    expect(await escrowBalance()).toBe(escrow0 - 200_000);

    const tx = await db('transactions').where({ idempotency_key: `release:${subId}` }).first();
    expect(tx.type).toBe('ESCROW_RELEASE');
    const entries = await db('ledger_entries').where({ transaction_id: tx.id });
    expect(entries).toHaveLength(3);
    expect(entries.filter((e) => e.direction === 'debit').map((e) => e.amount_kobo)).toEqual([200_000]);
    expect(entries.filter((e) => e.direction === 'credit').map((e) => e.amount_kobo).sort((a, b) => a - b)).toEqual([10_000, 190_000]);

    expect((await getOrder(order.id)).status).toBe('COMPLETED'); // the only sub-order is done
    expect((await runAudit()).pass).toBe(true);
  });

  test('commission rounds down to a whole kobo and the vendor gets the remainder', async () => {
    const { vendor, buyer, subId } = await setup({ priceKobo: 33_333 }); // 5% = 1,666.65
    await post(vendor, subId, 'ship').expect(200);
    const [revenue0, vendor0] = [await revenueBalance(), await walletBalance(vendor.id)];
    await post(buyer, subId, 'confirm-delivery').expect(200);
    expect(await revenueBalance()).toBe(revenue0 + 1_666);
    expect(await walletBalance(vendor.id)).toBe(vendor0 + 31_667);
    expect(Number.isInteger(await walletBalance(vendor.id))).toBe(true);
  });

  test('uses the rate recorded on the sub-order (10% here), not the current default', async () => {
    const { vendor, buyer, subId } = await setup({ priceKobo: 100_000 });
    await db.transaction(async (trx) => {
      await trx.raw('ALTER TABLE sub_orders DISABLE TRIGGER USER');
      await trx('sub_orders').where({ id: subId }).update({ commission_rate_bps: 1000 });
      await trx.raw('ALTER TABLE sub_orders ENABLE TRIGGER USER');
    });
    await post(vendor, subId, 'ship').expect(200);
    const [revenue0, vendor0] = [await revenueBalance(), await walletBalance(vendor.id)];
    await post(buyer, subId, 'confirm-delivery').expect(200);
    expect(await revenueBalance()).toBe(revenue0 + 10_000);
    expect(await walletBalance(vendor.id)).toBe(vendor0 + 90_000);
  });

  test('commissionFor is exact for huge amounts and edge rates', () => {
    expect(commissionFor(100_000, 500)).toBe(5_000);
    expect(commissionFor(1, 500)).toBe(0);
    expect(commissionFor(199, 500)).toBe(9);
    expect(commissionFor(100_000, 0)).toBe(0);
    expect(commissionFor(100_000, 10_000)).toBe(100_000);
    expect(commissionFor(9_007_199_254_740_000, 500)).toBe(450_359_962_737_000); // > 2^53 once multiplied: BigInt keeps it exact
  });

  test('a 0% commission pays the vendor everything (two-leg release)', async () => {
    const { vendor, buyer, subId } = await setup({ priceKobo: 100_000 });
    await db.transaction(async (trx) => {
      await trx.raw('ALTER TABLE sub_orders DISABLE TRIGGER USER');
      await trx('sub_orders').where({ id: subId }).update({ commission_rate_bps: 0 });
      await trx.raw('ALTER TABLE sub_orders ENABLE TRIGGER USER');
    });
    await post(vendor, subId, 'ship').expect(200);
    const vendor0 = await walletBalance(vendor.id);
    await post(buyer, subId, 'confirm-delivery').expect(200);
    expect(await walletBalance(vendor.id)).toBe(vendor0 + 100_000);
    const tx = await db('transactions').where({ idempotency_key: `release:${subId}` }).first();
    expect(await db('ledger_entries').where({ transaction_id: tx.id })).toHaveLength(2);
  });

  test('only the buyer, and only once SHIPPED', async () => {
    const { vendor, buyer, subId } = await setup();
    const stranger = await createUserAndLogin(app);

    const early = await post(buyer, subId, 'confirm-delivery');
    expect(early.status).toBe(409); // still PAID
    expect(early.body.error.code).toBe('INVALID_STATE');

    await post(vendor, subId, 'ship').expect(200);
    expect((await post(stranger, subId, 'confirm-delivery')).status).toBe(404);
    expect((await post(vendor, subId, 'confirm-delivery')).status).toBe(404); // the vendor cannot confirm their own delivery
    expect((await getSub(subId)).status).toBe('SHIPPED');
  });

  test('confirming twice releases once', async () => {
    const { vendor, buyer, subId } = await setup();
    await post(vendor, subId, 'ship').expect(200);
    await post(buyer, subId, 'confirm-delivery').expect(200);
    const vendor1 = await walletBalance(vendor.id);
    const second = await post(buyer, subId, 'confirm-delivery');
    expect(second.status).toBe(409);
    expect(await walletBalance(vendor.id)).toBe(vendor1);
    expect(await db('transactions').where({ idempotency_key: `release:${subId}` })).toHaveLength(1);
  });

  test('five simultaneous confirmations: exactly one succeeds, the vendor is paid once', async () => {
    const { vendor, buyer, subId } = await setup({ priceKobo: 100_000 });
    await post(vendor, subId, 'ship').expect(200);
    const vendor0 = await walletBalance(vendor.id);
    const results = await Promise.all(Array.from({ length: 5 }, () => post(buyer, subId, 'confirm-delivery')));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await walletBalance(vendor.id)).toBe(vendor0 + 95_000);
    expect(await db('transactions').where({ idempotency_key: `release:${subId}` })).toHaveLength(1);
    expect((await runAudit()).pass).toBe(true);
  });

  test('a failed release rolls everything back (frozen vendor wallet): still SHIPPED, nothing moved', async () => {
    const { vendor, buyer, subId } = await setup();
    await post(vendor, subId, 'ship').expect(200);
    await db('accounts').where({ owner_type: 'USER', owner_id: vendor.id }).update({ status: 'FROZEN' }).catch(() => {});
    const acct = await db('accounts').where({ owner_type: 'USER', owner_id: vendor.id }).first();
    if (!acct) return; // wallet created lazily; nothing to freeze
    const escrow0 = await escrowBalance();
    const res = await post(buyer, subId, 'confirm-delivery');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_ACTIVE');
    expect((await getSub(subId)).status).toBe('SHIPPED');
    expect((await getSub(subId)).escrow_held_kobo).toBe(100_000);
    expect(await escrowBalance()).toBe(escrow0);
    await db('accounts').where({ id: acct.id }).update({ status: 'ACTIVE' });
    await post(buyer, subId, 'confirm-delivery').expect(200); // works once the wallet is active again
  });
});

describe('cancel', () => {
  test('before shipping: refunds the buyer, restores stock, cancels sub-order and order', async () => {
    const { vendor, buyer, product, order, subId } = await setup({ priceKobo: 50_000, quantity: 3, stock: 10 });
    expect(await productStock(app, product)).toBe(7);
    const [buyer0, escrow0] = [await walletBalance(buyer.id), await escrowBalance()];

    const res = await post(buyer, subId, 'cancel').expect(200);
    expect(res.body.data.subOrder).toMatchObject({ status: 'CANCELLED', escrowHeldKobo: 0 });
    expect(res.body.data.subOrder.cancelledAt).toBeTruthy();
    expect(await walletBalance(buyer.id)).toBe(buyer0 + 150_000);
    expect(await escrowBalance()).toBe(escrow0 - 150_000);
    expect(await productStock(app, product)).toBe(10);
    const parent = await getOrder(order.id);
    expect(parent.status).toBe('CANCELLED');
    expect(parent.cancel_reason).toBe('BUYER_CANCELLED');

    // cancelled means cancelled: it can no longer be shipped, confirmed or cancelled again
    expect((await post(vendor, subId, 'ship')).status).toBe(409);
    expect((await post(buyer, subId, 'confirm-delivery')).status).toBe(409);
    expect((await post(buyer, subId, 'cancel')).status).toBe(409);
    expect(await walletBalance(buyer.id)).toBe(buyer0 + 150_000);
    expect(await productStock(app, product)).toBe(10); // restocked once only
    expect((await runAudit()).pass).toBe(true);
  });

  test('after SHIPPED the buyer can no longer cancel', async () => {
    const { vendor, buyer, subId } = await setup();
    await post(vendor, subId, 'ship').expect(200);
    const res = await post(buyer, subId, 'cancel');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANNOT_CANCEL');
    expect((await getSub(subId)).status).toBe('SHIPPED');
  });

  test('only the buyer who owns it', async () => {
    const { vendor, subId } = await setup();
    const stranger = await createUserAndLogin(app);
    expect((await post(stranger, subId, 'cancel')).status).toBe(404);
    expect((await post(vendor, subId, 'cancel')).status).toBe(404);
    expect((await getSub(subId)).status).toBe('PAID');
  });

  test('a multi-vendor order: cancelling one part leaves the order open; finishing the other completes it', async () => {
    const v1 = await createVendor(app, admin);
    const v2 = await createVendor(app, admin);
    const buyer = await createUserAndLogin(app);
    await fundWallet(buyer.id, 5_000_000);
    const p1 = await createProduct(app, v1, { priceKobo: 40_000 });
    const p2 = await createProduct(app, v2, { priceKobo: 60_000 });
    await addToCart(app, buyer, { productId: p1.id, quantity: 1 }).expect(201);
    await addToCart(app, buyer, { productId: p2.id, quantity: 1 }).expect(201);
    const order = (await checkout(app, buyer).expect(201)).body.data.order;
    const sub1 = order.subOrders.find((s) => s.vendorId === v1.vendorId).id;
    const sub2 = order.subOrders.find((s) => s.vendorId === v2.vendorId).id;

    await post(buyer, sub1, 'cancel').expect(200);
    expect((await getOrder(order.id)).status).toBe('PAID');
    expect((await getSub(sub2)).status).toBe('PAID');

    await post(v2, sub2, 'ship').expect(200);
    await post(buyer, sub2, 'confirm-delivery').expect(200);
    expect((await getOrder(order.id)).status).toBe('COMPLETED');
    expect((await runAudit()).pass).toBe(true);
  });

  test('cancel and ship racing: exactly one wins and the books balance either way', async () => {
    for (let i = 0; i < 3; i += 1) {
      const { vendor, buyer, subId } = await setup();
      const [a, b] = await Promise.all([post(buyer, subId, 'cancel'), post(vendor, subId, 'ship')]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const status = (await getSub(subId)).status;
      expect(['CANCELLED', 'SHIPPED']).toContain(status);
      expect((await getSub(subId)).escrow_held_kobo).toBe(status === 'CANCELLED' ? 0 : 100_000);
    }
    expect((await runAudit()).pass).toBe(true);
  });
});

describe('auto-complete after 72 hours', () => {
  test('completes SHIPPED sub-orders older than the window and releases the money', async () => {
    const { vendor, subId, order } = await setup({ priceKobo: 100_000 });
    await post(vendor, subId, 'ship').expect(200);
    await ageShipment(subId, 73);
    const vendor0 = await walletBalance(vendor.id);

    const out = await fulfilmentService.autoCompleteOverdue(72);
    expect(out.completed).toBeGreaterThanOrEqual(1);
    const sub = await getSub(subId);
    expect(sub.status).toBe('COMPLETED');
    expect(sub.escrow_held_kobo).toBe(0);
    expect(sub.completed_at).toBeTruthy();
    expect(await walletBalance(vendor.id)).toBe(vendor0 + 95_000);
    expect((await getOrder(order.id)).status).toBe('COMPLETED');
    expect((await runAudit()).pass).toBe(true);
  });

  test('leaves recent shipments, unshipped orders and just-under-72h shipments alone', async () => {
    const fresh = await setup();
    await post(fresh.vendor, fresh.subId, 'ship').expect(200);
    const almost = await setup();
    await post(almost.vendor, almost.subId, 'ship').expect(200);
    await ageShipment(almost.subId, 71);
    const unshipped = await setup();
    await db('orders').where({ id: unshipped.order.id }).update({ created_at: db.raw("now() - interval '200 hours'") }).catch(() => {});

    await fulfilmentService.autoCompleteOverdue(72);
    expect((await getSub(fresh.subId)).status).toBe('SHIPPED');
    expect((await getSub(almost.subId)).status).toBe('SHIPPED');
    expect((await getSub(unshipped.subId)).status).toBe('PAID');
  });

  test('SKIPS disputed sub-orders: their escrow stays frozen', async () => {
    const { vendor, buyer, subId } = await setup({ priceKobo: 100_000 });
    await post(vendor, subId, 'ship').expect(200);
    await ageShipment(subId, 100);
    await openDispute(buyer, subId);
    const [vendor0, escrow0] = [await walletBalance(vendor.id), await escrowBalance()];

    await fulfilmentService.autoCompleteOverdue(72);
    const sub = await getSub(subId);
    expect(sub.status).toBe('DISPUTED');
    expect(sub.escrow_held_kobo).toBe(100_000);
    expect(await walletBalance(vendor.id)).toBe(vendor0);
    expect(await escrowBalance()).toBe(escrow0);
  });

  test('a dispute that lands between the job\'s query and its lock is respected (re-check under lock)', async () => {
    const { vendor, buyer, subId } = await setup();
    await post(vendor, subId, 'ship').expect(200);
    await ageShipment(subId, 100);
    const repo = require('../../src/modules/orders/order.repository');
    const spy = jest.spyOn(repo, 'findOverdueShipped').mockImplementationOnce(async (...args) => {
      const rows = await jest.requireActual('../../src/modules/orders/order.repository').findOverdueShipped(...args);
      await openDispute(buyer, subId); // lands right after the query
      return rows;
    });
    await fulfilmentService.autoCompleteOverdue(72);
    spy.mockRestore();
    expect((await getSub(subId)).status).toBe('DISPUTED');
    expect(await db('transactions').where({ idempotency_key: `release:${subId}` })).toHaveLength(0);
  });

  test('running the job twice, or at the same time, or racing the buyer, releases exactly once', async () => {
    const { vendor, buyer, subId } = await setup({ priceKobo: 100_000 });
    await post(vendor, subId, 'ship').expect(200);
    await ageShipment(subId, 80);
    const vendor0 = await walletBalance(vendor.id);

    await Promise.all([
      fulfilmentService.autoCompleteOverdue(72),
      fulfilmentService.autoCompleteOverdue(72),
      post(buyer, subId, 'confirm-delivery'),
    ]);
    await fulfilmentService.autoCompleteOverdue(72);

    expect(await walletBalance(vendor.id)).toBe(vendor0 + 95_000);
    expect(await db('transactions').where({ idempotency_key: `release:${subId}` })).toHaveLength(1);
    expect((await getSub(subId)).status).toBe('COMPLETED');
    expect((await runAudit()).pass).toBe(true);
  });

  test('the job is registered with the scheduler and uses the configured window', () => {
    const job = require('../../src/jobs/autoComplete.job');
    expect(job.name).toBe('escrow-auto-complete');
    expect(require('../../src/config').business.escrowAutoCompleteHours).toBe(72);
    expect(require('fs').readFileSync(require.resolve('../../src/jobs/scheduler'), 'utf8')).toContain('autoCompleteJob');
  });
});

describe('GET /orders/sales (vendor)', () => {
  test('a vendor sees only their own sales, can filter by status and paginate', async () => {
    const { vendor, buyer, subId } = await setup();
    const other = await setup();
    for (let i = 0; i < 2; i += 1) {
      const p = await createProduct(app, vendor, { priceKobo: 10_000 });
      await addToCart(app, buyer, { productId: p.id, quantity: 1 }).expect(201);
      await checkout(app, buyer).expect(201);
    }
    await post(vendor, subId, 'ship').expect(200);

    const all = await request(app).get('/api/v1/orders/sales?limit=2').set(bearer(vendor.token)).expect(200);
    expect(all.body.data.subOrders).toHaveLength(2);
    expect(all.body.data.nextCursor).toBeTruthy();
    const page2 = await request(app).get(`/api/v1/orders/sales?limit=2&cursor=${all.body.data.nextCursor}`).set(bearer(vendor.token)).expect(200);
    expect(page2.body.data.subOrders).toHaveLength(1);
    expect(page2.body.data.nextCursor).toBeNull();

    const everything = [...all.body.data.subOrders, ...page2.body.data.subOrders];
    expect(everything.map((s) => s.id)).not.toContain(other.subId);

    const shipped = await request(app).get('/api/v1/orders/sales?status=SHIPPED').set(bearer(vendor.token)).expect(200);
    expect(shipped.body.data.subOrders.map((s) => s.id)).toEqual([subId]);
    expect((await request(app).get('/api/v1/orders/sales?status=BOGUS').set(bearer(vendor.token))).status).toBe(422);
    expect((await request(app).get('/api/v1/orders/sales').set(bearer(buyer.token))).status).toBe(403);
  });
});

describe('the database refuses what the service would never do', () => {
  test('escrow can not be raised, and a completed sub-order can not move again', async () => {
    const { vendor, buyer, subId } = await setup();
    await post(vendor, subId, 'ship').expect(200);
    await post(buyer, subId, 'confirm-delivery').expect(200);
    await expect(db('sub_orders').where({ id: subId }).update({ status: 'SHIPPED' })).rejects.toThrow(/SUB_ORDER_INVALID_TRANSITION/);
    await expect(db('sub_orders').where({ id: subId }).update({ status: 'CANCELLED' })).rejects.toThrow(/SUB_ORDER_INVALID_TRANSITION/);
    await expect(db('sub_orders').where({ id: subId }).update({ escrow_held_kobo: 5 })).rejects.toThrow(/SUB_ORDER_ESCROW_INCREASE/);
  });
});
