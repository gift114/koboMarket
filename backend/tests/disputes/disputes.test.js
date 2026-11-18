const backend = require('../helpers/backend'); // must come before the app (installs mocks)
const request = require('supertest');
const createApp = require('../../src/app');
const { db } = require('../../src/config/postgres');
const { runAudit } = require('../../src/modules/audit/ledgerAudit.service');
const fulfilmentService = require('../../src/modules/orders/fulfilment.service');
const { createUserAndLogin, bearer } = require('../helpers/users');
const { createVendor, createProduct } = require('../helpers/catalog');
const { fundWallet, walletBalance, escrowBalance, addToCart, checkout } = require('../helpers/orders');

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
const REASON = 'The parcel arrived empty and the courier cannot explain it.';

/** A funded buyer + vendor and one SHIPPED sub-order worth priceKobo x quantity. */
async function shipped({ priceKobo = 100_000, quantity = 2 } = {}) {
  const vendor = await createVendor(app, admin);
  const buyer = await createUserAndLogin(app);
  await fundWallet(buyer.id, 10_000_000);
  const product = await createProduct(app, vendor, { priceKobo, stock: 20 });
  await addToCart(app, buyer, { productId: product.id, quantity }).expect(201);
  const order = (await checkout(app, buyer).expect(201)).body.data.order;
  const subId = order.subOrders[0].id;
  await post(vendor, subId, 'ship').expect(200);
  return { vendor, buyer, order, subId };
}

const post = (user, subId, action, body) => request(app).post(`/api/v1/orders/sub-orders/${subId}/${action}`).set(bearer(user.token)).send(body);
const openDispute = (buyer, subId, body = { reason: REASON, evidence: [{ type: 'text', value: 'Box was light' }] }) => post(buyer, subId, 'dispute', body);
const resolve = (user, id, body) => request(app).post(`/api/v1/disputes/${id}/resolve`).set(bearer(user.token)).send(body);
const getSub = (subId) => db('sub_orders').where({ id: subId }).first();
const getDispute = (id) => db('disputes').where({ id }).first();
const disputed = async (opts) => {
  const ctx = await shipped(opts);
  const res = await openDispute(ctx.buyer, ctx.subId).expect(201);
  return { ...ctx, disputeId: res.body.data.dispute.id };
};

describe('opening a dispute', () => {
  test('the buyer disputes a SHIPPED sub-order: it becomes DISPUTED and the escrow stays frozen', async () => {
    const { buyer, subId } = await shipped();
    const escrow0 = await escrowBalance();
    const res = await openDispute(buyer, subId, {
      reason: REASON,
      evidence: [{ type: 'text', value: 'Box was light' }, { type: 'image', value: 'https://img.example.com/box.jpg' }],
    }).expect(201);

    const d = res.body.data.dispute;
    expect(d).toMatchObject({ status: 'OPEN', subOrderId: subId, escrowKobo: 200_000, resolution: null, resolvedBy: null });
    expect(d.evidence).toHaveLength(2);
    const sub = await getSub(subId);
    expect(sub.status).toBe('DISPUTED');
    expect(sub.escrow_held_kobo).toBe(200_000);
    expect(await escrowBalance()).toBe(escrow0); // nothing moved
    expect((await runAudit()).pass).toBe(true);
  });

  test('only a shipped sub-order: PAID, COMPLETED and CANCELLED ones are refused', async () => {
    const paid = await shipped();
    const other = await shipped();
    const another = await shipped();
    // a PAID one
    const p = await createProduct(app, paid.vendor, { priceKobo: 10_000 });
    await addToCart(app, paid.buyer, { productId: p.id, quantity: 1 }).expect(201);
    const paidOrder = (await checkout(app, paid.buyer).expect(201)).body.data.order;
    const r1 = await openDispute(paid.buyer, paidOrder.subOrders[0].id);
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('CANNOT_DISPUTE');
    // a COMPLETED one
    await post(other.buyer, other.subId, 'confirm-delivery').expect(200);
    expect((await openDispute(other.buyer, other.subId)).body.error.code).toBe('CANNOT_DISPUTE');
    // a CANCELLED one
    const q = await createProduct(app, another.vendor, { priceKobo: 10_000 });
    await addToCart(app, another.buyer, { productId: q.id, quantity: 1 }).expect(201);
    const o = (await checkout(app, another.buyer).expect(201)).body.data.order;
    await post(another.buyer, o.subOrders[0].id, 'cancel').expect(200);
    expect((await openDispute(another.buyer, o.subOrders[0].id)).body.error.code).toBe('CANNOT_DISPUTE');
  });

  test('only the buyer; and bad input is rejected', async () => {
    const { vendor, buyer, subId } = await shipped();
    const stranger = await createUserAndLogin(app);
    expect((await request(app).post(`/api/v1/orders/sub-orders/${subId}/dispute`).send({ reason: REASON })).status).toBe(401);
    expect((await openDispute(vendor, subId)).status).toBe(404);
    expect((await openDispute(stranger, subId)).status).toBe(404);
    expect((await openDispute(buyer, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await openDispute(buyer, subId, { reason: 'bad' })).status).toBe(422);
    expect((await openDispute(buyer, subId, { reason: REASON, evidence: [{ type: 'video', value: 'x' }] })).status).toBe(422);
    expect((await openDispute(buyer, subId, { reason: REASON, evidence: [{ type: 'image', value: 'javascript:alert(1)' }] })).status).toBe(422);
    expect((await openDispute(buyer, subId, { reason: REASON, evidence: [{ type: 'image', value: 'not a url' }] })).status).toBe(422);
    expect((await openDispute(buyer, subId, { reason: REASON, evidence: Array.from({ length: 11 }, () => ({ type: 'text', value: 'x' })) })).status).toBe(422);
    expect((await getSub(subId)).status).toBe('SHIPPED'); // nothing above changed it
  });

  test('a second dispute on the same sub-order is refused', async () => {
    const { buyer, subId } = await disputed();
    const again = await openDispute(buyer, subId);
    expect(again.status).toBe(409);
    expect(await db('disputes').where({ sub_order_id: subId })).toHaveLength(1);
  });

  test('five simultaneous attempts create exactly one dispute', async () => {
    const { buyer, subId } = await shipped();
    const results = await Promise.all(Array.from({ length: 5 }, () => openDispute(buyer, subId)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await db('disputes').where({ sub_order_id: subId })).toHaveLength(1);
  });

  test('dispute racing the buyer\'s own confirmation: exactly one wins, money is consistent', async () => {
    for (let i = 0; i < 3; i += 1) {
      const { vendor, buyer, subId } = await shipped({ priceKobo: 100_000, quantity: 1 });
      const vendor0 = await walletBalance(vendor.id);
      const [a, b] = await Promise.all([openDispute(buyer, subId), post(buyer, subId, 'confirm-delivery')]);
      // either the dispute wins (201, confirm refused 409) or the confirmation wins (200, dispute refused 409)
      expect([[a.status, b.status].join()]).toContain(a.status === 201 ? '201,409' : '409,200');
      const sub = await getSub(subId);
      if (a.status === 201) {
        expect(sub.status).toBe('DISPUTED');
        expect(await walletBalance(vendor.id)).toBe(vendor0);
      } else {
        expect(sub.status).toBe('COMPLETED');
        expect(await walletBalance(vendor.id)).toBe(vendor0 + 95_000);
      }
    }
    expect((await runAudit()).pass).toBe(true);
  });
});

describe('a dispute freezes the escrow', () => {
  test('ship, confirm, cancel and the auto-complete job can no longer move it', async () => {
    const { vendor, buyer, subId } = await disputed({ priceKobo: 100_000, quantity: 1 });
    await db('sub_orders').where({ id: subId }).update({ shipped_at: db.raw("now() - interval '200 hours'") });
    const [vendor0, buyer0, escrow0] = [await walletBalance(vendor.id), await walletBalance(buyer.id), await escrowBalance()];

    expect((await post(buyer, subId, 'confirm-delivery')).status).toBe(409);
    expect((await post(buyer, subId, 'cancel')).status).toBe(409);
    expect((await post(vendor, subId, 'ship')).status).toBe(409);
    await fulfilmentService.autoCompleteOverdue(72);

    expect((await getSub(subId)).status).toBe('DISPUTED');
    expect((await getSub(subId)).escrow_held_kobo).toBe(100_000);
    expect(await walletBalance(vendor.id)).toBe(vendor0);
    expect(await walletBalance(buyer.id)).toBe(buyer0);
    expect(await escrowBalance()).toBe(escrow0);
  });
});

describe('resolving a dispute', () => {
  test('only an admin', async () => {
    const { vendor, buyer, disputeId } = await disputed();
    const body = { resolution: 'FULL_REFUND', note: 'Refund approved' };
    expect((await request(app).post(`/api/v1/disputes/${disputeId}/resolve`).send(body)).status).toBe(401);
    expect((await resolve(buyer, disputeId, body)).status).toBe(403);
    expect((await resolve(vendor, disputeId, body)).status).toBe(403);
    expect((await getDispute(disputeId)).status).toBe('OPEN');
  });

  test('FULL_REFUND: the buyer gets everything back, the vendor and the platform get nothing', async () => {
    const { vendor, buyer, order, subId, disputeId } = await disputed({ priceKobo: 100_000, quantity: 2 });
    const [buyer0, vendor0, rev0, escrow0] = [await walletBalance(buyer.id), await walletBalance(vendor.id), await revenueBalance(), await escrowBalance()];

    const res = await resolve(admin, disputeId, { resolution: 'FULL_REFUND', note: 'Seller could not show proof of contents' }).expect(200);
    expect(res.body.data.dispute).toMatchObject({
      status: 'RESOLVED', resolution: 'FULL_REFUND', refundKobo: 200_000, vendorGrossKobo: 0, commissionKobo: 0,
      resolvedBy: admin.id, resolutionNote: 'Seller could not show proof of contents',
    });
    expect(res.body.data.dispute.resolvedAt).toBeTruthy();
    expect(await walletBalance(buyer.id)).toBe(buyer0 + 200_000);
    expect(await walletBalance(vendor.id)).toBe(vendor0);
    expect(await revenueBalance()).toBe(rev0);
    expect(await escrowBalance()).toBe(escrow0 - 200_000);
    const sub = await getSub(subId);
    expect(sub.status).toBe('REFUNDED');
    expect(sub.escrow_held_kobo).toBe(0);
    expect((await db('orders').where({ id: order.id }).first()).status).toBe('COMPLETED');
    expect((await runAudit()).pass).toBe(true);
  });

  test('PARTIAL_REFUND: buyer gets the refund, vendor the rest minus commission on THAT part only', async () => {
    const { vendor, buyer, subId, disputeId } = await disputed({ priceKobo: 100_000, quantity: 2 }); // 200,000 in dispute
    const [buyer0, vendor0, rev0, escrow0] = [await walletBalance(buyer.id), await walletBalance(vendor.id), await revenueBalance(), await escrowBalance()];

    const res = await resolve(admin, disputeId, { resolution: 'PARTIAL_REFUND', refundKobo: 50_000, note: 'One of two items was missing' }).expect(200);
    expect(res.body.data.dispute).toMatchObject({ resolution: 'PARTIAL_REFUND', refundKobo: 50_000, vendorGrossKobo: 150_000, commissionKobo: 7_500 });
    expect(await walletBalance(buyer.id)).toBe(buyer0 + 50_000);
    expect(await walletBalance(vendor.id)).toBe(vendor0 + 142_500); // 150,000 - 5% of 150,000
    expect(await revenueBalance()).toBe(rev0 + 7_500); // NOT 10,000: no commission on the refunded part
    expect(await escrowBalance()).toBe(escrow0 - 200_000);

    const tx = await db('transactions').where({ idempotency_key: `dispute:${disputeId}` }).first();
    expect(tx.type).toBe('DISPUTE_RESOLUTION');
    const entries = await db('ledger_entries').where({ transaction_id: tx.id });
    expect(entries).toHaveLength(4); // one atomic transaction: escrow out, buyer, vendor, revenue in
    const sub = await getSub(subId);
    expect(sub.status).toBe('COMPLETED');
    expect(sub.escrow_held_kobo).toBe(0);
    expect((await runAudit()).pass).toBe(true);
  });

  test('REJECT: the vendor is paid as for a normal completion', async () => {
    const { vendor, buyer, subId, disputeId } = await disputed({ priceKobo: 100_000, quantity: 2 });
    const [buyer0, vendor0, rev0] = [await walletBalance(buyer.id), await walletBalance(vendor.id), await revenueBalance()];

    const res = await resolve(admin, disputeId, { resolution: 'REJECT', note: 'Courier confirms full delivery' }).expect(200);
    expect(res.body.data.dispute).toMatchObject({ resolution: 'REJECTED', refundKobo: 0, vendorGrossKobo: 200_000, commissionKobo: 10_000, resolvedBy: admin.id });
    expect(await walletBalance(buyer.id)).toBe(buyer0);
    expect(await walletBalance(vendor.id)).toBe(vendor0 + 190_000);
    expect(await revenueBalance()).toBe(rev0 + 10_000);
    expect((await getSub(subId)).status).toBe('COMPLETED');
    expect((await runAudit()).pass).toBe(true);
  });

  test('partial-refund rounding: commission rounds down on the vendor part and every kobo is accounted for', async () => {
    const { vendor, buyer, disputeId } = await disputed({ priceKobo: 33_333, quantity: 1 });
    const [buyer0, vendor0, rev0] = [await walletBalance(buyer.id), await walletBalance(vendor.id), await revenueBalance()];
    await resolve(admin, disputeId, { resolution: 'PARTIAL_REFUND', refundKobo: 1_001, note: 'Partial credit' }).expect(200);
    // vendor part 32,332 -> commission floor(1,616.6) = 1,616; vendor 30,716
    expect(await walletBalance(buyer.id)).toBe(buyer0 + 1_001);
    expect(await revenueBalance()).toBe(rev0 + 1_616);
    expect(await walletBalance(vendor.id)).toBe(vendor0 + 30_716);
    expect((await runAudit()).pass).toBe(true);
  });

  test('input is validated: the refund must be a positive amount below the escrow, and a note is required', async () => {
    const { disputeId } = await disputed({ priceKobo: 100_000, quantity: 1 });
    const bad = [
      { resolution: 'PARTIAL_REFUND', note: 'no amount' },
      { resolution: 'PARTIAL_REFUND', refundKobo: 100_000, note: 'that is a full refund' },
      { resolution: 'PARTIAL_REFUND', refundKobo: 100_001, note: 'more than the escrow' },
      { resolution: 'PARTIAL_REFUND', refundKobo: 0, note: 'zero' },
      { resolution: 'PARTIAL_REFUND', refundKobo: 10.5, note: 'a float' },
      { resolution: 'FULL_REFUND', refundKobo: 5_000, note: 'amount not allowed here' },
      { resolution: 'REJECT', refundKobo: 5_000, note: 'amount not allowed here' },
      { resolution: 'FULL_REFUND' },
      { resolution: 'FULL_REFUND', note: ' ' },
      { resolution: 'SPLIT', note: 'unknown' },
    ];
    for (const body of bad) expect([body, (await resolve(admin, disputeId, body)).status]).toEqual([body, 422]);
    expect((await getDispute(disputeId)).status).toBe('OPEN');
    expect((await resolve(admin, '00000000-0000-4000-8000-000000000000', { resolution: 'REJECT', note: 'nothing here' })).status).toBe(404);
  });

  test('a dispute resolves once: later attempts get 409 and move no money', async () => {
    const { buyer, disputeId } = await disputed({ priceKobo: 100_000, quantity: 1 });
    await resolve(admin, disputeId, { resolution: 'FULL_REFUND', note: 'First decision' }).expect(200);
    const buyer1 = await walletBalance(buyer.id);
    for (const body of [{ resolution: 'FULL_REFUND', note: 'Again' }, { resolution: 'REJECT', note: 'Changed my mind' }]) {
      const res = await resolve(admin, disputeId, body);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DISPUTE_ALREADY_RESOLVED');
    }
    expect(await walletBalance(buyer.id)).toBe(buyer1);
    expect((await getDispute(disputeId)).resolution).toBe('FULL_REFUND');
  });

  test('four admins resolving at once (different decisions): exactly one applies, money moves once', async () => {
    const { vendor, buyer, disputeId } = await disputed({ priceKobo: 100_000, quantity: 1 });
    const [buyer0, vendor0] = [await walletBalance(buyer.id), await walletBalance(vendor.id)];
    const results = await Promise.all([
      resolve(admin, disputeId, { resolution: 'FULL_REFUND', note: 'Decision A' }),
      resolve(admin, disputeId, { resolution: 'REJECT', note: 'Decision B' }),
      resolve(admin, disputeId, { resolution: 'PARTIAL_REFUND', refundKobo: 40_000, note: 'Decision C' }),
      resolve(admin, disputeId, { resolution: 'FULL_REFUND', note: 'Decision D' }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    const moved = (await walletBalance(buyer.id)) - buyer0 + ((await walletBalance(vendor.id)) - vendor0);
    expect(moved).toBeGreaterThan(0);
    expect(await db('transactions').where({ idempotency_key: `dispute:${disputeId}` })).toHaveLength(1);
    expect((await runAudit()).pass).toBe(true);
  });

  test('a failed settlement rolls back completely (frozen buyer wallet): dispute stays OPEN', async () => {
    const { buyer, subId, disputeId } = await disputed({ priceKobo: 100_000, quantity: 1 });
    await db('accounts').where({ owner_type: 'USER', owner_id: buyer.id }).update({ status: 'FROZEN' });
    const res = await resolve(admin, disputeId, { resolution: 'FULL_REFUND', note: 'Refund approved' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_ACTIVE');
    expect((await getDispute(disputeId)).status).toBe('OPEN');
    expect((await getSub(subId)).status).toBe('DISPUTED');
    expect((await getSub(subId)).escrow_held_kobo).toBe(100_000);
    await db('accounts').where({ owner_type: 'USER', owner_id: buyer.id }).update({ status: 'ACTIVE' });
    await resolve(admin, disputeId, { resolution: 'FULL_REFUND', note: 'Refund approved' }).expect(200);
  });

  test('a multi-vendor order finishes when its last sub-order is settled', async () => {
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
    await post(v1, sub1, 'ship').expect(200);
    await post(v2, sub2, 'ship').expect(200);
    const d = (await openDispute(buyer, sub1).expect(201)).body.data.dispute;
    await post(buyer, sub2, 'confirm-delivery').expect(200);
    expect((await db('orders').where({ id: order.id }).first()).status).toBe('PAID'); // still waiting on the dispute
    await resolve(admin, d.id, { resolution: 'FULL_REFUND', note: 'Refund approved' }).expect(200);
    expect((await db('orders').where({ id: order.id }).first()).status).toBe('COMPLETED');
    expect((await runAudit()).pass).toBe(true);
  });
});

describe('reading disputes', () => {
  test('the buyer, the vendor and an admin can read it; a stranger gets 404', async () => {
    const { vendor, buyer, disputeId } = await disputed();
    const stranger = await createUserAndLogin(app);
    for (const u of [buyer, vendor, admin]) {
      const res = await request(app).get(`/api/v1/disputes/${disputeId}`).set(bearer(u.token)).expect(200);
      expect(res.body.data.dispute.reason).toBe(REASON);
    }
    expect((await request(app).get(`/api/v1/disputes/${disputeId}`).set(bearer(stranger.token))).status).toBe(404);
    expect((await request(app).get(`/api/v1/disputes/${disputeId}`)).status).toBe(401);
    expect((await request(app).get('/api/v1/disputes/not-a-uuid').set(bearer(buyer.token))).status).toBe(422);
  });

  test('lists are scoped to the user, filter by status and paginate', async () => {
    const vendor = await createVendor(app, admin);
    const buyer = await createUserAndLogin(app);
    await fundWallet(buyer.id, 5_000_000);
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const p = await createProduct(app, vendor, { priceKobo: 10_000 });
      await addToCart(app, buyer, { productId: p.id, quantity: 1 }).expect(201);
      const o = (await checkout(app, buyer).expect(201)).body.data.order;
      await post(vendor, o.subOrders[0].id, 'ship').expect(200);
      ids.push((await openDispute(buyer, o.subOrders[0].id).expect(201)).body.data.dispute.id);
    }
    await shipped().then(({ buyer: b, subId }) => openDispute(b, subId).expect(201)); // someone else's

    const page1 = await request(app).get('/api/v1/disputes?limit=2').set(bearer(buyer.token)).expect(200);
    expect(page1.body.data.disputes.map((d) => d.id)).toEqual([ids[2], ids[1]]);
    const page2 = await request(app).get(`/api/v1/disputes?limit=2&cursor=${page1.body.data.nextCursor}`).set(bearer(buyer.token)).expect(200);
    expect(page2.body.data.disputes.map((d) => d.id)).toEqual([ids[0]]);
    expect(page2.body.data.nextCursor).toBeNull();

    const asVendor = await request(app).get('/api/v1/disputes').set(bearer(vendor.token)).expect(200);
    expect(asVendor.body.data.disputes).toHaveLength(3);

    await resolve(admin, ids[0], { resolution: 'REJECT', note: 'Delivery confirmed' }).expect(200);
    const open = await request(app).get('/api/v1/disputes?status=OPEN').set(bearer(buyer.token)).expect(200);
    expect(open.body.data.disputes).toHaveLength(2);
    const allAdmin = await request(app).get('/api/v1/disputes?status=OPEN&limit=50').set(bearer(admin.token)).expect(200);
    expect(allAdmin.body.data.disputes.length).toBeGreaterThanOrEqual(3);
    expect((await request(app).get('/api/v1/disputes?status=BOGUS').set(bearer(buyer.token))).status).toBe(422);
  });
});

describe('the database and the audit enforce the rules too', () => {
  test('complaint is immutable, a resolved dispute is final, nothing is deleted', async () => {
    const { disputeId } = await disputed({ priceKobo: 100_000, quantity: 1 });
    await expect(db('disputes').where({ id: disputeId }).update({ reason: 'I changed my story completely' })).rejects.toThrow(/DISPUTE_IMMUTABLE/);
    await expect(db('disputes').where({ id: disputeId }).update({ escrow_kobo: 1 })).rejects.toThrow(/DISPUTE_IMMUTABLE/);
    await expect(db('disputes').where({ id: disputeId }).update({ evidence: '[]' })).rejects.toThrow(/DISPUTE_IMMUTABLE/);
    await expect(db('disputes').where({ id: disputeId }).delete()).rejects.toThrow(/DISPUTE_NO_DELETE/);

    // a resolution without an admin, a note or a matching split is refused by CHECK constraints
    await expect(db('disputes').where({ id: disputeId }).update({ status: 'RESOLVED', resolution: 'REJECTED', refund_kobo: 0, vendor_gross_kobo: 100_000, commission_kobo: 5_000 }))
      .rejects.toThrow(/disputes_resolved_shape_chk/);

    await resolve(admin, disputeId, { resolution: 'REJECT', note: 'Delivery confirmed' }).expect(200);
    await expect(db('disputes').where({ id: disputeId }).update({ resolution_note: 'rewritten' })).rejects.toThrow(/DISPUTE_RESOLVED/);
    await expect(db('disputes').where({ id: disputeId }).update({ status: 'OPEN' })).rejects.toThrow(/DISPUTE_RESOLVED/);
  });

  test('the audit notices a DISPUTED sub-order whose escrow was tampered with', async () => {
    const { subId } = await disputed({ priceKobo: 100_000, quantity: 1 });
    let result;
    await db
      .transaction(async (trx) => {
        await trx.raw('ALTER TABLE sub_orders DISABLE TRIGGER USER');
        await trx('sub_orders').where({ id: subId }).update({ escrow_held_kobo: 1 });
        result = await runAudit(trx);
        throw new Error('ROLLBACK_ON_PURPOSE');
      })
      .catch((e) => {
        if (e.message !== 'ROLLBACK_ON_PURPOSE') throw e;
      });
    expect(result.pass).toBe(false);
    expect(result.checks.filter((c) => !c.pass).map((c) => c.name)).toEqual(
      expect.arrayContaining(['Every dispute matches its sub-order and the ledger entries that settled it']),
    );
  });

  test('the audit notices a DISPUTED sub-order with no dispute behind it', async () => {
    const { subId } = await shipped();
    let result;
    await db
      .transaction(async (trx) => {
        await trx('sub_orders').where({ id: subId }).update({ status: 'DISPUTED' });
        result = await runAudit(trx);
        throw new Error('ROLLBACK_ON_PURPOSE');
      })
      .catch((e) => {
        if (e.message !== 'ROLLBACK_ON_PURPOSE') throw e;
      });
    expect(result.checks.find((c) => c.name.startsWith('Every dispute')).pass).toBe(false);
  });
});
