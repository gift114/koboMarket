const { randomBytes } = require('crypto');
const { db } = require('../../src/config/postgres');
const { runAudit } = require('../../src/modules/audit/ledgerAudit.service');
const { hasCompletedPurchase } = require('../../src/modules/reviews/purchaseVerifier');

afterAll(() => db.destroy());

const hex = () => randomBytes(12).toString('hex');

/** Insert a consistent order (1 sub-order, 1 item of quantity 2 x 50,000) in `trx`. */
async function insertOrder(trx, { buyerId = hex(), productId = hex(), total = 100_000, subtotal = 100_000, lineTotal = 100_000, key } = {}) {
  const [order] = await trx('orders').insert({ buyer_id: buyerId, idempotency_key: key || `k-${hex()}`, total_kobo: total }).returning('*');
  const [sub] = await trx('sub_orders')
    .insert({ order_id: order.id, buyer_id: buyerId, vendor_id: hex(), vendor_user_id: hex(), subtotal_kobo: subtotal, commission_rate_bps: 500 })
    .returning('*');
  const [item] = await trx('order_items')
    .insert({ sub_order_id: sub.id, product_id: productId, name: 'Thing', quantity: 2, unit_price_kobo: 50_000, line_total_kobo: lineTotal })
    .returning('*');
  return { order, sub, item, buyerId, productId };
}

/** Run `work` in a transaction that is ALWAYS rolled back; returns what work returned. */
async function rolledBack(work) {
  let out;
  await db
    .transaction(async (trx) => {
      out = await work(trx);
      throw new Error('ROLLBACK_ON_PURPOSE');
    })
    .catch((e) => {
      if (e.message !== 'ROLLBACK_ON_PURPOSE') throw e;
    });
  return out;
}

/** Create one committed order to run guard tests against. */
async function committedOrder() {
  return db.transaction((trx) => insertOrder(trx));
}

describe('totals are checked by the database at COMMIT', () => {
  test('a consistent order commits', async () => {
    await expect(committedOrder()).resolves.toBeTruthy();
  });

  test('a sub-order whose subtotal differs from the sum of its items is refused', async () => {
    await expect(db.transaction((trx) => insertOrder(trx, { subtotal: 99_999, total: 99_999 }))).rejects.toThrow(/ORDER_TOTAL_MISMATCH/);
  });

  test('an order whose total differs from the sum of its sub-orders is refused', async () => {
    await expect(db.transaction((trx) => insertOrder(trx, { total: 100_001 }))).rejects.toThrow(/ORDER_TOTAL_MISMATCH/);
  });

  test.each([
    ['a line total that is not quantity x price', { lineTotal: 99_999, subtotal: 99_999, total: 99_999 }, /order_items_line_total_chk/],
  ])('%s is refused', async (_n, overrides, pattern) => {
    await expect(db.transaction((trx) => insertOrder(trx, overrides))).rejects.toThrow(pattern);
  });

  test('bad amounts and ids are refused by CHECK constraints', async () => {
    await rolledBack(async (trx) => {
      const { sub } = await insertOrder(trx);
      const item = { sub_order_id: sub.id, product_id: hex(), name: 'x', quantity: 1, unit_price_kobo: 10, line_total_kobo: 10 };
      await expect(trx.transaction((t) => t('order_items').insert({ ...item, unit_price_kobo: 0, line_total_kobo: 0 }))).rejects.toThrow(/order_items_price_chk/);
      await expect(trx.transaction((t) => t('order_items').insert({ ...item, quantity: 100, line_total_kobo: 1000 }))).rejects.toThrow(/order_items_quantity_chk/);
      await expect(trx.transaction((t) => t('order_items').insert({ ...item, product_id: 'not-an-id' }))).rejects.toThrow(/order_items_ids_chk/);
      await expect(trx.transaction((t) => t('orders').insert({ buyer_id: hex(), idempotency_key: 'k-neg-123456', total_kobo: -5 }))).rejects.toThrow(/orders_total_chk/);
    });
  });

  test('the same buyer cannot reuse an idempotency key; a different buyer can', async () => {
    const buyerId = hex();
    const key = `k-${hex()}`;
    await db.transaction((trx) => insertOrder(trx, { buyerId, key }));
    await expect(db.transaction((trx) => insertOrder(trx, { buyerId, key }))).rejects.toThrow(/orders_buyer_key_unique/);
    await expect(db.transaction((trx) => insertOrder(trx, { key }))).resolves.toBeTruthy();
  });

  test('an order cannot be PAID without a payment transaction', async () => {
    const { order } = await committedOrder();
    await expect(db('orders').where({ id: order.id }).update({ status: 'PAID' })).rejects.toThrow(/orders_paid_has_payment_chk/);
  });
});

describe('nothing that identifies or prices an order can change, and nothing is deleted', () => {
  test('order: buyer, total and key are immutable', async () => {
    const { order } = await committedOrder();
    await expect(db('orders').where({ id: order.id }).update({ total_kobo: 1 })).rejects.toThrow(/ORDER_IMMUTABLE/);
    await expect(db('orders').where({ id: order.id }).update({ buyer_id: hex() })).rejects.toThrow(/ORDER_IMMUTABLE/);
    await expect(db('orders').where({ id: order.id }).update({ idempotency_key: 'another-key-1' })).rejects.toThrow(/ORDER_IMMUTABLE/);
  });

  test('sub-order: vendor, subtotal and commission rate are immutable; escrow can only go down', async () => {
    const { sub } = await committedOrder();
    await expect(db('sub_orders').where({ id: sub.id }).update({ subtotal_kobo: 1 })).rejects.toThrow(/SUB_ORDER_IMMUTABLE/);
    await expect(db('sub_orders').where({ id: sub.id }).update({ vendor_user_id: hex() })).rejects.toThrow(/SUB_ORDER_IMMUTABLE/);
    await expect(db('sub_orders').where({ id: sub.id }).update({ commission_rate_bps: 0 })).rejects.toThrow(/SUB_ORDER_IMMUTABLE/);
    await db('sub_orders').where({ id: sub.id }).update({ status: 'PAID', escrow_held_kobo: 100_000 }); // set once, when paid
    await db('sub_orders').where({ id: sub.id }).update({ escrow_held_kobo: 40_000 }); // can go down
    await expect(db('sub_orders').where({ id: sub.id }).update({ escrow_held_kobo: 90_000 })).rejects.toThrow(/SUB_ORDER_ESCROW_INCREASE/);
    await expect(db('sub_orders').where({ id: sub.id }).update({ escrow_held_kobo: 100_001 })).rejects.toThrow(/sub_orders_escrow_chk|SUB_ORDER_ESCROW_INCREASE/);
    await db('sub_orders').where({ id: sub.id }).update({ escrow_held_kobo: 0 }); // leave no escrow behind: the audit must still balance
  });

  test('order item: price, quantity and product are immutable; stock flags only move forward', async () => {
    const { item } = await committedOrder();
    await expect(db('order_items').where({ id: item.id }).update({ unit_price_kobo: 1, line_total_kobo: 2 })).rejects.toThrow(/ORDER_ITEM_IMMUTABLE/);
    await expect(db('order_items').where({ id: item.id }).update({ product_id: hex() })).rejects.toThrow(/ORDER_ITEM_IMMUTABLE/);
    await db('order_items').where({ id: item.id }).update({ stock_decremented: true });
    await expect(db('order_items').where({ id: item.id }).update({ stock_decremented: false })).rejects.toThrow(/ORDER_ITEM_IMMUTABLE/);
    await expect(db('order_items').where({ id: item.id }).update({ stock_restored: true })).resolves.toBeDefined();
  });

  test('restoring stock that was never taken is refused', async () => {
    const { item } = await committedOrder();
    await expect(db('order_items').where({ id: item.id }).update({ stock_restored: true })).rejects.toThrow(/order_items_restored_chk/);
  });

  test('orders, sub-orders and items are never deleted', async () => {
    const { order, sub, item } = await committedOrder();
    await expect(db('order_items').where({ id: item.id }).del()).rejects.toThrow(/ORDER_UNDELETABLE/);
    await expect(db('sub_orders').where({ id: sub.id }).del()).rejects.toThrow(/ORDER_UNDELETABLE/);
    await expect(db('orders').where({ id: order.id }).del()).rejects.toThrow(/ORDER_UNDELETABLE/);
  });
});

describe('the order state machine (enforced by the database)', () => {
  const setStatus = (id, status) => db('sub_orders').where({ id }).update({ status });
  const statusOf = async (id) => (await db('sub_orders').where({ id }).first()).status;

  test('the happy path PENDING_PAYMENT -> PAID -> SHIPPED -> DELIVERED -> COMPLETED is allowed', async () => {
    const { sub } = await committedOrder();
    for (const next of ['PAID', 'SHIPPED', 'DELIVERED', 'COMPLETED']) {
      await setStatus(sub.id, next);
      expect(await statusOf(sub.id)).toBe(next);
    }
  });

  test.each([
    ['PENDING_PAYMENT', 'SHIPPED'],
    ['PENDING_PAYMENT', 'COMPLETED'],
    ['PAID', 'COMPLETED'], // the brief's example: you cannot jump to completed
    ['PAID', 'DELIVERED'],
    ['PAID', 'DISPUTED'],
    ['SHIPPED', 'PAID'],
    ['SHIPPED', 'CANCELLED'], // cancel only before shipping
    ['DELIVERED', 'SHIPPED'],
    ['DELIVERED', 'CANCELLED'],
  ])('%s -> %s is refused', async (from, to) => {
    const { sub } = await committedOrder();
    const path = { PENDING_PAYMENT: [], PAID: ['PAID'], SHIPPED: ['PAID', 'SHIPPED'], DELIVERED: ['PAID', 'SHIPPED', 'DELIVERED'] }[from];
    for (const step of path) await setStatus(sub.id, step);
    await expect(setStatus(sub.id, to)).rejects.toThrow(/SUB_ORDER_INVALID_TRANSITION/);
    expect(await statusOf(sub.id)).toBe(from);
  });

  test('DISPUTED is reachable from SHIPPED and DELIVERED, and only resolves to COMPLETED or REFUNDED', async () => {
    const a = await committedOrder();
    for (const s of ['PAID', 'SHIPPED', 'DISPUTED', 'REFUNDED']) await setStatus(a.sub.id, s);
    const b = await committedOrder();
    for (const s of ['PAID', 'SHIPPED', 'DELIVERED', 'DISPUTED', 'COMPLETED']) await setStatus(b.sub.id, s);
    const c = await committedOrder();
    for (const s of ['PAID', 'SHIPPED', 'DISPUTED']) await setStatus(c.sub.id, s);
    await expect(setStatus(c.sub.id, 'SHIPPED')).rejects.toThrow(/SUB_ORDER_INVALID_TRANSITION/);
    await setStatus(c.sub.id, 'COMPLETED'); // do not leave a DISPUTED sub-order with no dispute behind it (the audit would flag it)
  });

  test('SHIPPED -> COMPLETED is allowed (auto-complete), and PAID -> CANCELLED too', async () => {
    const a = await committedOrder();
    for (const s of ['PAID', 'SHIPPED', 'COMPLETED']) await setStatus(a.sub.id, s);
    const b = await committedOrder();
    for (const s of ['PAID', 'CANCELLED']) await setStatus(b.sub.id, s);
  });

  test.each(['COMPLETED', 'CANCELLED', 'REFUNDED'])('%s is terminal', async (terminal) => {
    const { sub } = await committedOrder();
    const path = { COMPLETED: ['PAID', 'SHIPPED', 'DELIVERED', 'COMPLETED'], CANCELLED: ['PAID', 'CANCELLED'], REFUNDED: ['PAID', 'SHIPPED', 'DISPUTED', 'REFUNDED'] }[terminal];
    for (const step of path) await setStatus(sub.id, step);
    for (const next of ['PAID', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'DISPUTED', 'REFUNDED']) {
      if (next !== terminal) await expect(setStatus(sub.id, next)).rejects.toThrow(/SUB_ORDER_INVALID_TRANSITION/);
    }
  });

  test('the parent order only moves PENDING_PAYMENT -> PAID | CANCELLED -> ...', async () => {
    const { order } = await committedOrder();
    await expect(db('orders').where({ id: order.id }).update({ status: 'COMPLETED' })).rejects.toThrow(/ORDER_INVALID_TRANSITION/);
    await db('orders').where({ id: order.id }).update({ status: 'CANCELLED' });
    await expect(db('orders').where({ id: order.id }).update({ status: 'PAID' })).rejects.toThrow(/ORDER_INVALID_TRANSITION/);
  });
});

describe('audit and the review check', () => {
  test('the escrow audit passes on the real data', async () => {
    const result = await runAudit();
    expect(result.checks.filter((c) => !c.pass)).toEqual([]);
  });

  test('the escrow audit FAILS when the held escrow of sub-orders and the escrow account disagree (rolled back)', async () => {
    const result = await rolledBack(async (trx) => {
      await trx.raw('ALTER TABLE sub_orders DISABLE TRIGGER USER');
      const { sub } = await insertOrder(trx);
      await trx('sub_orders').where({ id: sub.id }).update({ escrow_held_kobo: 70_000 }); // escrow account holds nothing for it
      return runAudit(trx);
    });
    expect(result.pass).toBe(false);
    expect(result.checks.filter((c) => !c.pass).map((c) => c.name).join('|')).toMatch(/PLATFORM_ESCROW balance/);
  });

  test('hasCompletedPurchase now reads the real tables: only a COMPLETED sub-order of that buyer for that product counts', async () => {
    const outcomes = await rolledBack(async (trx) => {
      const { sub, buyerId, productId } = await insertOrder(trx);
      const out = [];
      out.push(await hasCompletedPurchase(buyerId, productId, trx)); // PENDING_PAYMENT
      for (const s of ['PAID', 'SHIPPED', 'DELIVERED']) await trx('sub_orders').where({ id: sub.id }).update({ status: s });
      out.push(await hasCompletedPurchase(buyerId, productId, trx)); // delivered but not completed
      await trx('sub_orders').where({ id: sub.id }).update({ status: 'COMPLETED' });
      out.push(await hasCompletedPurchase(buyerId, productId, trx)); // completed
      out.push(await hasCompletedPurchase(hex(), productId, trx)); // someone else
      out.push(await hasCompletedPurchase(buyerId, hex(), trx)); // another product
      return out;
    });
    expect(outcomes).toEqual([false, false, true, false, false]);
  });
});
