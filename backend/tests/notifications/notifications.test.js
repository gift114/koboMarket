const backend = require('../helpers/backend'); // must come before the app (installs mocks)
const request = require('supertest');
const createApp = require('../../src/app');
const { db } = require('../../src/config/postgres');
const bus = require('../../src/events/bus');
const EVENTS = require('../../src/events/events');
const payoutsService = require('../../src/modules/payouts/payouts.service');
const fulfilmentService = require('../../src/modules/orders/fulfilment.service');
const notificationRepository = require('../../src/modules/notifications/notification.repository');
const { getProvider } = require('../../src/modules/payments/providers');
const { createUserAndLogin, bearer } = require('../helpers/users');
const { createVendor, createProduct } = require('../helpers/catalog');
const { fundWallet, addToCart, checkout, newKey } = require('../helpers/orders');

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

const mine = async (user, query = '') => (await request(app).get(`/api/v1/notifications${query}`).set(bearer(user.token)).expect(200)).body.data;
const types = async (user) => (await mine(user, '?limit=50')).notifications.map((n) => n.type);
const post = (user, subId, action, body) => request(app).post(`/api/v1/orders/sub-orders/${subId}/${action}`).set(bearer(user.token)).send(body);

async function shippedOrder() {
  const vendor = await createVendor(app, admin);
  const buyer = await createUserAndLogin(app);
  await fundWallet(buyer.id, 5_000_000);
  const product = await createProduct(app, vendor, { priceKobo: 100_000, stock: 10 });
  await addToCart(app, buyer, { productId: product.id, quantity: 1 }).expect(201);
  const order = (await checkout(app, buyer).expect(201)).body.data.order;
  const subId = order.subOrders[0].id;
  return { vendor, buyer, order, subId };
}

describe('notifications are created by events, after the fact', () => {
  test('order placed -> buyer and vendor; shipped -> buyer; confirmed -> vendor "funds released"', async () => {
    const { vendor, buyer, subId } = await shippedOrder();
    await bus.idle();
    expect(await types(buyer)).toEqual(['ORDER_PLACED']);
    expect(await types(vendor)).toEqual(['NEW_ORDER']);

    await post(vendor, subId, 'ship').expect(200);
    await bus.idle();
    expect(await types(buyer)).toEqual(['ORDER_SHIPPED', 'ORDER_PLACED']); // newest first
    await post(buyer, subId, 'confirm-delivery').expect(200);
    await bus.idle();
    const funds = (await mine(vendor)).notifications[0];
    expect(funds).toMatchObject({ type: 'FUNDS_RELEASED', read: false });
    expect(funds.message).toContain('950.00'); // 100,000 kobo minus 5% commission
    expect(funds.data).toMatchObject({ subOrderId: subId, reason: 'DELIVERY_CONFIRMED' });
  });

  test('a multi-vendor order notifies each vendor about their own part only', async () => {
    const v1 = await createVendor(app, admin);
    const v2 = await createVendor(app, admin);
    const buyer = await createUserAndLogin(app);
    await fundWallet(buyer.id, 5_000_000);
    for (const v of [v1, v2]) {
      const p = await createProduct(app, v, { priceKobo: 20_000 });
      await addToCart(app, buyer, { productId: p.id, quantity: 1 }).expect(201);
    }
    await checkout(app, buyer).expect(201);
    await bus.idle();
    expect(await types(buyer)).toEqual(['ORDER_PLACED']); // one notification for the order, not one per vendor
    for (const v of [v1, v2]) expect(await types(v)).toEqual(['NEW_ORDER']);
  });

  test('auto-completion tells the vendor the funds were released', async () => {
    const { vendor, subId } = await shippedOrder();
    await post(vendor, subId, 'ship').expect(200);
    await db('sub_orders').where({ id: subId }).update({ shipped_at: db.raw("now() - interval '100 hours'") });
    await fulfilmentService.autoCompleteOverdue(72);
    await bus.idle();
    const n = (await mine(vendor)).notifications.find((x) => x.type === 'FUNDS_RELEASED');
    expect(n.data.reason).toBe('AUTO_COMPLETED');
  });

  test('dispute opened -> vendor and every admin; resolved -> buyer and vendor (+ funds released to the vendor when they were paid)', async () => {
    const { vendor, buyer, subId } = await shippedOrder();
    await post(vendor, subId, 'ship').expect(200);
    const d = (await post(buyer, subId, 'dispute', { reason: 'It never arrived at my address.' }).expect(201)).body.data.dispute;
    await bus.idle();
    expect((await types(vendor))).toContain('DISPUTE_OPENED');
    expect((await types(admin))).toContain('DISPUTE_NEEDS_REVIEW');

    await request(app).post(`/api/v1/disputes/${d.id}/resolve`).set(bearer(admin.token)).send({ resolution: 'PARTIAL_REFUND', refundKobo: 30_000, note: 'Half the items missing' }).expect(200);
    await bus.idle();
    const b = (await mine(buyer)).notifications.find((n) => n.type === 'DISPUTE_RESOLVED');
    expect(b.message).toContain('partial refund of');
    const vTypes = await types(vendor);
    expect(vTypes).toEqual(expect.arrayContaining(['DISPUTE_RESOLVED', 'FUNDS_RELEASED']));

    // a full refund pays the vendor nothing, so no "funds released"
    const second = await shippedOrder();
    await post(second.vendor, second.subId, 'ship').expect(200);
    const d2 = (await post(second.buyer, second.subId, 'dispute', { reason: 'Item was not as described.' }).expect(201)).body.data.dispute;
    await request(app).post(`/api/v1/disputes/${d2.id}/resolve`).set(bearer(admin.token)).send({ resolution: 'FULL_REFUND', note: 'Refund approved' }).expect(200);
    await bus.idle();
    expect(await types(second.vendor)).not.toContain('FUNDS_RELEASED');
  });

  test('payout success and failure notify the vendor', async () => {
    const vendor = await createVendor(app, admin);
    await fundWallet(vendor.id, 500_000);
    const req = (amountKobo) => request(app).post('/api/v1/payouts').set(bearer(vendor.token)).set('Idempotency-Key', newKey()).send({ amountKobo });
    await req(100_000).expect(201);
    await payoutsService.processPending();
    provider.transferOutcome = 'failed';
    await req(100_000).expect(201);
    await payoutsService.processPending();
    await bus.idle();
    const list = (await mine(vendor)).notifications;
    expect(list.map((n) => n.type)).toEqual(['PAYOUT_FAILED', 'PAYOUT_SUCCESS']);
    expect(list[0].message).toMatch(/back in your wallet/);
  });

  test('nothing is notified for something that did not happen (rolled-back or refused actions)', async () => {
    const { vendor, buyer, subId } = await shippedOrder();
    await bus.idle();
    const before = (await mine(buyer)).notifications.length;
    await post(buyer, subId, 'confirm-delivery').expect(409); // not shipped yet
    await post(vendor, subId, 'cancel').expect(404);
    await bus.idle();
    expect((await mine(buyer)).notifications).toHaveLength(before);
    expect(await types(vendor)).toEqual(['NEW_ORDER']);
  });
});

describe('asynchronous and failure-proof', () => {
  test('the request returns before the listener has run; a broken listener or repository never fails the request', async () => {
    const vendor = await createVendor(app, admin);
    const buyer = await createUserAndLogin(app);
    await fundWallet(buyer.id, 1_000_000);
    const product = await createProduct(app, vendor, { priceKobo: 50_000 });

    const original = notificationRepository.create;
    notificationRepository.create = async () => {
      throw new Error('mongo is down');
    };
    try {
      await addToCart(app, buyer, { productId: product.id, quantity: 1 }).expect(201);
      const res = await checkout(app, buyer);
      expect(res.status).toBe(201); // the order succeeded although notifying failed
      await bus.idle(); // and the failure was contained
    } finally {
      notificationRepository.create = original;
    }
    expect(await types(buyer)).toEqual([]);
  });

  test('a listener that throws does not stop the other listeners or the publisher', async () => {
    const seen = [];
    bus.on('test.event', () => {
      throw new Error('boom');
    });
    bus.on('test.event', (p) => seen.push(p.n));
    expect(() => bus.publish('test.event', { n: 1 })).not.toThrow();
    expect(seen).toEqual([]); // not run synchronously: listeners are asynchronous
    await bus.idle();
    expect(seen).toEqual([1]);
  });

  test('the same event delivered twice produces one notification', async () => {
    const buyer = await createUserAndLogin(app);
    const payload = { payoutId: 'p-dup-1', userId: buyer.id, amountKobo: 123_400 };
    bus.publish(EVENTS.PAYOUT_SUCCESS, payload);
    bus.publish(EVENTS.PAYOUT_SUCCESS, payload);
    await bus.idle();
    expect(await types(buyer)).toEqual(['PAYOUT_SUCCESS']);
  });
});

describe('reading and marking notifications', () => {
  async function userWith(n) {
    const user = await createUserAndLogin(app);
    for (let i = 0; i < n; i += 1) {
      bus.publish(EVENTS.PAYOUT_SUCCESS, { payoutId: `p-${user.id}-${i}`, userId: user.id, amountKobo: 100_000 + i });
      await bus.idle(); // one at a time, so the creation order is the order of i
    }
    return user;
  }

  test('paginated newest first, with the unread count; unread filter', async () => {
    const user = await userWith(5);
    const page1 = await mine(user, '?limit=2');
    expect(page1.notifications).toHaveLength(2);
    expect(page1.unreadCount).toBe(5);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await mine(user, `?limit=2&cursor=${page1.nextCursor}`);
    const page3 = await mine(user, `?limit=2&cursor=${page2.nextCursor}`);
    expect(page3.nextCursor).toBeNull();
    const all = [...page1.notifications, ...page2.notifications, ...page3.notifications];
    expect(all).toHaveLength(5);
    expect(new Set(all.map((n) => n.id)).size).toBe(5);
    expect(all[0].message).toContain('1,000.04'); // newest first

    await request(app).patch(`/api/v1/notifications/${all[0].id}/read`).set(bearer(user.token)).expect(200);
    expect((await mine(user, '?unread=true&limit=50')).notifications).toHaveLength(4);
    expect((await mine(user, '?unread=false&limit=50')).notifications).toHaveLength(5);
  });

  test('unread count, mark one read (idempotent), mark all read', async () => {
    const user = await userWith(3);
    const get = async () => (await request(app).get('/api/v1/notifications/unread-count').set(bearer(user.token)).expect(200)).body.data.unreadCount;
    expect(await get()).toBe(3);
    const first = (await mine(user)).notifications[0];
    const r1 = await request(app).patch(`/api/v1/notifications/${first.id}/read`).set(bearer(user.token)).expect(200);
    expect(r1.body.data.notification).toMatchObject({ read: true });
    const readAt = r1.body.data.notification.readAt;
    const r2 = await request(app).patch(`/api/v1/notifications/${first.id}/read`).set(bearer(user.token)).expect(200);
    expect(r2.body.data.notification.readAt).toEqual(readAt); // reading twice changes nothing
    expect(await get()).toBe(2);

    const all = await request(app).patch('/api/v1/notifications/read-all').set(bearer(user.token)).expect(200);
    expect(all.body.data.updated).toBe(2);
    expect(await get()).toBe(0);
    expect((await request(app).patch('/api/v1/notifications/read-all').set(bearer(user.token))).body.data.updated).toBe(0);
  });

  test('you only ever see and change your own', async () => {
    const a = await userWith(2);
    const b = await userWith(1);
    const aFirst = (await mine(a)).notifications[0];
    expect((await request(app).patch(`/api/v1/notifications/${aFirst.id}/read`).set(bearer(b.token))).status).toBe(404);
    expect((await mine(a)).unreadCount).toBe(2);
    await request(app).patch('/api/v1/notifications/read-all').set(bearer(b.token)).expect(200);
    expect((await mine(a)).unreadCount).toBe(2); // b's "read all" did not touch a's
    expect((await mine(b, '?limit=50')).notifications.map((n) => n.id)).not.toContain(aFirst.id);
  });

  test('needs a login, and bad input is rejected', async () => {
    const user = await userWith(1);
    expect((await request(app).get('/api/v1/notifications')).status).toBe(401);
    expect((await request(app).get('/api/v1/notifications/unread-count')).status).toBe(401);
    expect((await request(app).patch('/api/v1/notifications/read-all')).status).toBe(401);
    expect((await request(app).patch('/api/v1/notifications/not-an-id/read').set(bearer(user.token))).status).toBe(422);
    expect((await request(app).patch('/api/v1/notifications/aaaaaaaaaaaaaaaaaaaaaaaa/read').set(bearer(user.token))).status).toBe(404);
    expect((await request(app).get('/api/v1/notifications?limit=500').set(bearer(user.token))).status).toBe(422);
    expect((await request(app).get('/api/v1/notifications?cursor=zzz').set(bearer(user.token))).status).toBe(422);
  });
});
