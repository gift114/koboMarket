const backend = require('../helpers/backend'); // must come before the app (installs mocks)
const request = require('supertest');
const createApp = require('../../src/app');
const AppError = require('../../src/utils/AppError');
const { db } = require('../../src/config/postgres');
const productRepository = require('../../src/modules/products/product.repository');
const ledgerService = require('../../src/modules/wallet/ledger.service');
const checkoutService = require('../../src/modules/orders/checkout.service');
const { runAudit } = require('../../src/modules/audit/ledgerAudit.service');
const { createUserAndLogin, bearer } = require('../helpers/users');
const { createVendor, createProduct, patchProduct } = require('../helpers/catalog');
const { newKey, fundWallet, walletBalance, escrowBalance, countOrders, addToCart, checkout, productStock } = require('../helpers/orders');

const app = createApp();
let admin;
let vendorA;
let vendorB;
let vendorC;

beforeAll(async () => {
  await backend.start();
  admin = await createUserAndLogin(app, { roles: ['buyer', 'admin'] });
  [vendorA, vendorB, vendorC] = [await createVendor(app, admin), await createVendor(app, admin), await createVendor(app, admin)];
});
afterAll(async () => {
  await backend.stop();
  await db.destroy();
});

/** A buyer with a funded wallet and these cart lines: [[product, quantity], ...] */
async function buyerWithCart(lines, { fund = 10_000_000 } = {}) {
  const buyer = await createUserAndLogin(app);
  if (fund > 0) await fundWallet(buyer.id, fund);
  for (const [product, quantity] of lines) await addToCart(app, buyer, { productId: product.id, quantity }).expect(201);
  return buyer;
}
const cartItems = async (buyer) => (await request(app).get('/api/v1/cart').set(bearer(buyer.token))).body.data.cart.items;

describe('the happy path', () => {
  test('3 vendors become 1 parent order with 3 sub-orders; the buyer pays into escrow; stock is taken; the cart empties', async () => {
    const p1 = await createProduct(app, vendorA, { priceKobo: 100_000, stock: 10 });
    const p2 = await createProduct(app, vendorB, { priceKobo: 250_000, stock: 10 });
    const p3 = await createProduct(app, vendorC, { priceKobo: 40_000, stock: 10 });
    const buyer = await buyerWithCart([[p1, 2], [p2, 1], [p3, 3]], { fund: 1_000_000 });
    const escrowBefore = await escrowBalance();

    const res = await checkout(app, buyer);

    expect(res.status).toBe(201);
    const { order } = res.body.data;
    expect(order).toMatchObject({ status: 'PAID', totalKobo: 570_000, totalDisplay: 'N5,700.00' }); // 200k + 250k + 120k
    expect(order.subOrders).toHaveLength(3);
    const sub = (vendor) => order.subOrders.find((s) => s.vendorId === vendor.vendorId);
    expect(sub(vendorA)).toMatchObject({ status: 'PAID', subtotalKobo: 200_000, escrowHeldKobo: 200_000 });
    expect(sub(vendorB)).toMatchObject({ status: 'PAID', subtotalKobo: 250_000, escrowHeldKobo: 250_000 });
    expect(sub(vendorC)).toMatchObject({ status: 'PAID', subtotalKobo: 120_000, escrowHeldKobo: 120_000 });
    expect(sub(vendorC).items[0]).toMatchObject({ productId: p3.id, quantity: 3, unitPriceKobo: 40_000, lineTotalKobo: 120_000 });

    // money: buyer -> escrow, exactly the total
    expect(await walletBalance(buyer.id)).toBe(1_000_000 - 570_000);
    expect(await escrowBalance()).toBe(escrowBefore + 570_000);
    const row = await db('orders').where({ id: order.id }).first();
    expect(row.stock_status).toBe('RESERVED');
    const entries = await db('ledger_entries').where({ transaction_id: row.payment_transaction_id });
    expect(entries.map((e) => [e.direction, e.amount_kobo]).sort()).toEqual([['credit', 570_000], ['debit', 570_000]]);

    // stock taken in MongoDB, cart cleaned
    expect(await productStock(app, p1)).toBe(8);
    expect(await productStock(app, p2)).toBe(9);
    expect(await productStock(app, p3)).toBe(7);
    expect(await cartItems(buyer)).toEqual([]);
  });

  test('a variant purchase takes stock from that variant and from the product total', async () => {
    const p = await createProduct(app, vendorA, {
      priceKobo: undefined,
      stock: undefined,
      variants: [
        { attributes: { size: 'S' }, priceKobo: 100_000, stock: 5 },
        { attributes: { size: 'L' }, priceKobo: 150_000, stock: 5 },
      ],
    });
    const large = p.variants.find((v) => v.attributes.size === 'L');
    const buyer = await createUserAndLogin(app);
    await fundWallet(buyer.id, 1_000_000);
    await addToCart(app, buyer, { productId: p.id, variantId: large.id, quantity: 2 }).expect(201);

    const res = await checkout(app, buyer);

    expect(res.status).toBe(201);
    expect(res.body.data.order.subOrders[0].items[0]).toMatchObject({ variantId: large.id, unitPriceKobo: 150_000 });
    const page = (await request(app).get(`/api/v1/products/${p.slug}`)).body.data.product;
    expect(page.stock).toBe(8);
    expect(page.variants.find((v) => v.id === large.id).stock).toBe(3);
    expect(page.variants.find((v) => v.attributes.size === 'S').stock).toBe(5);
  });

  test('the buyer is charged the CURRENT price, not the price when the item was added', async () => {
    const p = await createProduct(app, vendorA, { priceKobo: 100_000, stock: 10 });
    const buyer = await buyerWithCart([[p, 2]], { fund: 1_000_000 });
    await patchProduct(app, vendorA, p.id, { priceKobo: 130_000 }).expect(200);

    const res = await checkout(app, buyer);

    expect(res.body.data.order.totalKobo).toBe(260_000);
    expect(res.body.data.order.subOrders[0].items[0].unitPriceKobo).toBe(130_000);
    expect(await walletBalance(buyer.id)).toBe(1_000_000 - 260_000);
  });

  test('the commission rate in force is copied onto each sub-order', async () => {
    const p = await createProduct(app, vendorA);
    const buyer = await buyerWithCart([[p, 1]]);
    const res = await checkout(app, buyer);
    const sub = await db('sub_orders').where({ order_id: res.body.data.order.id }).first();
    expect(sub.commission_rate_bps).toBe(500);
  });
});

describe('refusals leave no trace', () => {
  test('requires authentication and an Idempotency-Key', async () => {
    expect((await request(app).post('/api/v1/orders/checkout').set('Idempotency-Key', newKey())).status).toBe(401);
    const buyer = await createUserAndLogin(app);
    const res = await request(app).post('/api/v1/orders/checkout').set(bearer(buyer.token));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Idempotency-Key/);
  });

  test('an empty cart is 409 CART_EMPTY', async () => {
    const buyer = await createUserAndLogin(app);
    const res = await checkout(app, buyer);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CART_EMPTY');
  });

  test('insufficient funds: 409 with the numbers, and NO order, NO money moved, stock and cart untouched', async () => {
    const p = await createProduct(app, vendorA, { priceKobo: 100_000, stock: 5 });
    const buyer = await buyerWithCart([[p, 3]], { fund: 200_000 }); // needs 300,000
    const escrowBefore = await escrowBalance();

    const res = await checkout(app, buyer);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(res.body.error.details).toMatchObject({ availableKobo: 200_000, requiredKobo: 300_000 });
    expect(await countOrders(buyer.id)).toBe(0);
    expect(await walletBalance(buyer.id)).toBe(200_000);
    expect(await escrowBalance()).toBe(escrowBefore);
    expect(await productStock(app, p)).toBe(5);
    expect(await cartItems(buyer)).toHaveLength(1);
  });

  test('a buyer with no wallet at all is INSUFFICIENT_FUNDS, not a crash', async () => {
    const p = await createProduct(app, vendorA);
    const buyer = await buyerWithCart([[p, 1]], { fund: 0 });
    const res = await checkout(app, buyer);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await countOrders(buyer.id)).toBe(0);
  });

  test('stock that dropped after adding to the cart is CART_INVALID and nothing is charged', async () => {
    const p = await createProduct(app, vendorA, { stock: 10 });
    const buyer = await buyerWithCart([[p, 5]]);
    await patchProduct(app, vendorA, p.id, { stock: 2 }).expect(200);

    const res = await checkout(app, buyer);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CART_INVALID');
    expect(res.body.error.details.problems[0]).toMatchObject({ productId: p.id, issue: 'INSUFFICIENT_STOCK', availableStock: 2 });
    expect(await countOrders(buyer.id)).toBe(0);
    expect(await walletBalance(buyer.id)).toBe(10_000_000);
  });

  test('expectedTotalKobo that no longer matches is 409 PRICE_CHANGED; a matching one goes through', async () => {
    const p = await createProduct(app, vendorA, { priceKobo: 100_000, stock: 10 });
    const buyer = await buyerWithCart([[p, 1]]);
    await patchProduct(app, vendorA, p.id, { priceKobo: 120_000 }).expect(200);

    const stale = await checkout(app, buyer, { body: { expectedTotalKobo: 100_000 } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PRICE_CHANGED');
    expect(stale.body.error.details).toMatchObject({ expectedTotalKobo: 100_000, currentTotalKobo: 120_000 });
    expect(await countOrders(buyer.id)).toBe(0);

    const ok = await checkout(app, buyer, { body: { expectedTotalKobo: 120_000 } });
    expect(ok.status).toBe(201);
  });
});

describe('Idempotency-Key: the same key never creates two orders', () => {
  test('same key twice: one order, one charge, the original response replayed', async () => {
    const p = await createProduct(app, vendorA, { priceKobo: 100_000, stock: 10 });
    const buyer = await buyerWithCart([[p, 2]], { fund: 1_000_000 });
    const key = newKey();

    const first = await checkout(app, buyer, { key });
    const second = await checkout(app, buyer, { key });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(await countOrders(buyer.id)).toBe(1);
    expect(await walletBalance(buyer.id)).toBe(800_000);
    expect(await productStock(app, p)).toBe(8);
  });

  test('same key with a different body is 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const p = await createProduct(app, vendorA, { priceKobo: 100_000 });
    const buyer = await buyerWithCart([[p, 1]]);
    const key = newKey();
    await checkout(app, buyer, { key }).expect(201);
    const res = await checkout(app, buyer, { key, body: { expectedTotalKobo: 100_000 } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await countOrders(buyer.id)).toBe(1);
  });

  test('6 simultaneous requests with one key: one order, charged once', async () => {
    const p = await createProduct(app, vendorA, { priceKobo: 100_000, stock: 10 });
    const buyer = await buyerWithCart([[p, 1]], { fund: 1_000_000 });
    const key = newKey();

    const results = await Promise.all(Array.from({ length: 6 }, () => checkout(app, buyer, { key })));

    const created = results.filter((r) => r.status === 201);
    results.filter((r) => r.status !== 201).forEach((r) => expect(r.body.error.code).toBe('REQUEST_IN_PROGRESS'));
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(new Set(created.map((r) => r.body.data.order.id)).size).toBe(1);
    expect(await countOrders(buyer.id)).toBe(1);
    expect(await walletBalance(buyer.id)).toBe(900_000);
  });

  test('even if the middleware is bypassed (a request taken over after a crash), the database refuses a second order for the same key', async () => {
    const p = await createProduct(app, vendorA, { priceKobo: 100_000, stock: 10 });
    const buyer = await buyerWithCart([[p, 1]], { fund: 1_000_000 });
    const key = newKey();

    const first = await checkoutService.checkout({ id: buyer.id, email: buyer.email, roles: ['buyer'] }, { idempotencyKey: key });
    const again = await checkoutService.checkout({ id: buyer.id, email: buyer.email, roles: ['buyer'] }, { idempotencyKey: key });

    expect(again.id).toBe(first.id);
    expect(await countOrders(buyer.id)).toBe(1);
    expect(await walletBalance(buyer.id)).toBe(900_000);
  });
});

describe('concurrency', () => {
  test('a wallet that affords ONE order: two simultaneous checkouts (different keys) -> exactly one succeeds', async () => {
    const p = await createProduct(app, vendorA, { priceKobo: 100_000, stock: 10 });
    const buyer = await buyerWithCart([[p, 1]], { fund: 100_000 });

    const results = await Promise.all([checkout(app, buyer), checkout(app, buyer)]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409);
    expect(['INSUFFICIENT_FUNDS', 'CART_EMPTY']).toContain(loser.body.error.code);
    expect(await walletBalance(buyer.id)).toBe(0);
    expect(await countOrders(buyer.id)).toBe(1);
    expect(await productStock(app, p)).toBe(9);
  });

  test('the last unit: two buyers race for it, exactly one order is PAID, stock never goes negative, the books balance', async () => {
    const p = await createProduct(app, vendorA, { priceKobo: 100_000, stock: 1 });
    const b1 = await buyerWithCart([[p, 1]]);
    const b2 = await buyerWithCart([[p, 1]]);

    const results = await Promise.all([checkout(app, b1), checkout(app, b2)]);

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const loser = results.find((r) => r.status !== 201);
    expect(loser.status).toBe(409);
    expect(['STOCK_UNAVAILABLE', 'CART_INVALID']).toContain(loser.body.error.code);
    expect(await productStock(app, p)).toBe(0);
    const winnerIndex = results.findIndex((r) => r.status === 201);
    const [winner, loserBuyer] = winnerIndex === 0 ? [b1, b2] : [b2, b1];
    expect(await walletBalance(winner.id)).toBe(10_000_000 - 100_000);
    expect(await walletBalance(loserBuyer.id)).toBe(10_000_000); // loser has all their money
    expect((await runAudit()).pass).toBe(true);
  });
});

describe('compensation: the escrow is done but the MongoDB stock decrement fails', () => {
  async function twoItemCart() {
    const p1 = await createProduct(app, vendorA, { priceKobo: 100_000, stock: 10 });
    const p2 = await createProduct(app, vendorB, { priceKobo: 200_000, stock: 10 });
    const buyer = await buyerWithCart([[p1, 2], [p2, 1]], { fund: 1_000_000 });
    return { p1, p2, buyer };
  }
  const failSecondDecrement = () => {
    const real = productRepository.decrementStock;
    let calls = 0;
    return jest.spyOn(productRepository, 'decrementStock').mockImplementation(async (...args) => {
      calls += 1;
      return calls === 2 ? false : real(...args);
    });
  };

  test('the buyer is refunded, stock already taken is restored, the order is CANCELLED, and the client is told', async () => {
    const { p1, p2, buyer } = await twoItemCart();
    const escrowBefore = await escrowBalance();
    const spy = failSecondDecrement();

    const res = await checkout(app, buyer);
    spy.mockRestore();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STOCK_UNAVAILABLE');
    // money fully back
    expect(await walletBalance(buyer.id)).toBe(1_000_000);
    expect(await escrowBalance()).toBe(escrowBefore);
    // stock fully back
    expect(await productStock(app, p1)).toBe(10);
    expect(await productStock(app, p2)).toBe(10);
    // order cancelled, with a reversal in the ledger
    const order = await db('orders').where({ buyer_id: buyer.id }).first();
    expect(order).toMatchObject({ status: 'CANCELLED', cancel_reason: 'STOCK_UNAVAILABLE', stock_status: 'RELEASED' });
    const subs = await db('sub_orders').where({ order_id: order.id });
    subs.forEach((s) => expect(s).toMatchObject({ status: 'CANCELLED', escrow_held_kobo: 0 }));
    const reversal = await db('transactions').where({ reverses_transaction_id: order.payment_transaction_id }).first();
    expect(reversal.type).toBe('REVERSAL');
    expect((await db('transactions').where({ id: order.payment_transaction_id }).first()).status).toBe('REVERSED');
    expect(await cartItems(buyer)).toHaveLength(2); // the cart is kept so the buyer can try again
    expect((await runAudit()).pass).toBe(true);
  });

  test('retrying with the same key repeats the failure (no second order); a new key works once stock is there', async () => {
    const { p1, buyer } = await twoItemCart();
    const key = newKey();
    const spy = failSecondDecrement();
    await checkout(app, buyer, { key }).expect(409);
    spy.mockRestore();

    const retrySameKey = await checkout(app, buyer, { key });
    expect(retrySameKey.status).toBe(409);
    expect(retrySameKey.body.error.code).toBe('STOCK_UNAVAILABLE');
    expect(await countOrders(buyer.id)).toBe(1); // still only the cancelled one

    const fresh = await checkout(app, buyer, { key: newKey() });
    expect(fresh.status).toBe(201);
    expect(await productStock(app, p1)).toBe(8);
    expect(await countOrders(buyer.id)).toBe(2);
  });

  test('MongoDB itself failing (an exception) is also compensated, with a 503', async () => {
    const { p1, buyer } = await twoItemCart();
    const spy = jest.spyOn(productRepository, 'decrementStock').mockRejectedValue(new Error('mongo is down'));

    const res = await checkout(app, buyer);
    spy.mockRestore();

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('STOCK_SERVICE_UNAVAILABLE');
    expect(await walletBalance(buyer.id)).toBe(1_000_000);
    expect(await productStock(app, p1)).toBe(10);
    expect((await db('orders').where({ buyer_id: buyer.id }).first()).status).toBe('CANCELLED');
  });

  test('if the compensation itself fails (frozen wallet), the order stays PAID/PENDING and the recovery job refunds it later', async () => {
    const { p1, buyer } = await twoItemCart();
    const decrement = jest.spyOn(productRepository, 'decrementStock').mockRejectedValue(new Error('mongo is down'));
    const reverse = jest
      .spyOn(ledgerService, 'reverseTransaction')
      .mockRejectedValueOnce(new AppError(409, 'ACCOUNT_NOT_ACTIVE', 'frozen'));

    const res = await checkout(app, buyer);
    decrement.mockRestore();
    expect(res.status).toBe(503);
    let order = await db('orders').where({ buyer_id: buyer.id }).first();
    expect(order).toMatchObject({ status: 'PAID', stock_status: 'PENDING' });
    expect(await walletBalance(buyer.id)).toBe(1_000_000 - 400_000);

    // too fresh for the job to touch (it must not race a request that is still running)
    expect(await checkoutService.reconcileStuckOrders(3600)).toEqual({ found: 0, recovered: 0 });

    const job = await checkoutService.reconcileStuckOrders(0);
    reverse.mockRestore();
    expect(job).toMatchObject({ found: expect.any(Number), recovered: expect.any(Number) });
    order = await db('orders').where({ buyer_id: buyer.id }).first();
    expect(order).toMatchObject({ status: 'CANCELLED', cancel_reason: 'STOCK_INCOMPLETE' });
    expect(await walletBalance(buyer.id)).toBe(1_000_000);
    expect(await productStock(app, p1)).toBe(10);
    expect((await runAudit()).pass).toBe(true);
  });

  test('compensating an order that is fine (paid and reserved) does nothing: the recovery job can never refund a good order', async () => {
    const p = await createProduct(app, vendorA, { priceKobo: 100_000, stock: 10 });
    const buyer = await buyerWithCart([[p, 1]], { fund: 500_000 });
    const order = (await checkout(app, buyer).expect(201)).body.data.order;
    await db('orders').where({ id: order.id }).update({ stock_status: 'PENDING' }); // pretend it looked stuck
    await db('sub_orders').where({ order_id: order.id }).update({ status: 'SHIPPED' }); // ...but the vendor already shipped

    await expect(checkoutService.compensate(order.id, 'WRONGLY_FLAGGED')).resolves.toBeUndefined();

    expect(await walletBalance(buyer.id)).toBe(400_000); // not refunded
    expect(await productStock(app, p)).toBe(9); // and its stock was NOT given back
    expect((await db('orders').where({ id: order.id }).first()).status).toBe('PAID');
    await db('orders').where({ id: order.id }).update({ stock_status: 'RESERVED' });
  });

  test('compensating twice (job + request at once) refunds once', async () => {
    const { buyer } = await twoItemCart();
    const spy = failSecondDecrement();
    await checkout(app, buyer).expect(409);
    spy.mockRestore();
    const order = await db('orders').where({ buyer_id: buyer.id }).first();

    await Promise.all([checkoutService.compensate(order.id, 'AGAIN'), checkoutService.compensate(order.id, 'AGAIN')]);

    expect(await walletBalance(buyer.id)).toBe(1_000_000);
    expect(await db('transactions').where({ reverses_transaction_id: order.payment_transaction_id })).toHaveLength(1);
  });
});
