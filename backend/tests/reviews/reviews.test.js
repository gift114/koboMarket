const backend = require('../helpers/backend'); // must come before the app (installs mocks)
const request = require('supertest');

// Orders do not exist until Days 9-10, so "has a completed order" is controlled here.
const mockCompleted = new Set(); // `${buyerId}:${productId}`
jest.mock('../../src/modules/reviews/purchaseVerifier', () => ({
  hasCompletedPurchase: jest.fn(async (buyerId, productId) => mockCompleted.has(`${buyerId}:${productId}`)),
}));

const createApp = require('../../src/app');
const { createUserAndLogin, bearer } = require('../helpers/users');

const app = createApp();
let admin;
let vendor;
let seq = 0;

beforeAll(async () => {
  await backend.start();
  admin = await createUserAndLogin(app, { roles: ['buyer', 'admin'] });
  vendor = await createUserAndLogin(app);
  const applied = await request(app)
    .post('/api/v1/vendors/apply')
    .set(bearer(vendor.token))
    .send({
      storeName: `Review Store ${Date.now()}`,
      bankDetails: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Review Store' },
    })
    .expect(201);
  await request(app).patch(`/api/v1/admin/vendors/${applied.body.data.vendor.id}/approve`).set(bearer(admin.token)).expect(200);
});
afterAll(() => backend.stop());

async function newProduct() {
  seq += 1;
  const res = await request(app)
    .post('/api/v1/products')
    .set(bearer(vendor.token))
    .send({ name: `Reviewed Item ${Date.now()}-${seq}`, category: 'misc', priceKobo: 500_000, stock: 5 })
    .expect(201);
  return res.body.data.product;
}
async function buyerWhoReceived(product) {
  const buyer = await createUserAndLogin(app);
  mockCompleted.add(`${buyer.id}:${product.id}`);
  return buyer;
}
const review = (token, productId, body = { rating: 5 }) =>
  request(app).post(`/api/v1/products/${productId}/reviews`).set(bearer(token)).send(body);
const productPage = async (p) => (await request(app).get(`/api/v1/products/${p.slug}`)).body.data.product;

describe('who may review', () => {
  test('a buyer with a completed order reviews, and the average and count update', async () => {
    const p = await newProduct();
    const buyer = await buyerWhoReceived(p);

    const res = await review(buyer.token, p.id, { rating: 4, title: 'Nice', comment: 'Good quality' });

    expect(res.status).toBe(201);
    expect(res.body.data.review).toMatchObject({ rating: 4, title: 'Nice', comment: 'Good quality' });
    expect(res.body.data.rating).toEqual({ average: 4, count: 1 });
    expect((await productPage(p)).rating).toEqual({ average: 4, count: 1 });
  });

  test('a buyer WITHOUT a completed order is refused (403) and the rating is untouched', async () => {
    const p = await newProduct();
    const stranger = await createUserAndLogin(app);

    const res = await review(stranger.token, p.id);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PURCHASE_REQUIRED');
    expect((await productPage(p)).rating.count).toBe(0);
  });

  test('having completed an order for a DIFFERENT product does not allow reviewing this one', async () => {
    const owned = await newProduct();
    const other = await newProduct();
    const buyer = await buyerWhoReceived(owned);
    expect((await review(buyer.token, other.id)).status).toBe(403);
  });

  test('anonymous is 401; unknown product is 404', async () => {
    const p = await newProduct();
    expect((await request(app).post(`/api/v1/products/${p.id}/reviews`).send({ rating: 5 })).status).toBe(401);
    const buyer = await createUserAndLogin(app);
    expect((await review(buyer.token, '000000000000000000000000')).status).toBe(404);
  });
});

describe('one review per buyer per product', () => {
  test('a second review by the same buyer is 409 and does not change the rating', async () => {
    const p = await newProduct();
    const buyer = await buyerWhoReceived(p);
    await review(buyer.token, p.id, { rating: 5 }).expect(201);

    const again = await review(buyer.token, p.id, { rating: 1 });

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_REVIEWED');
    expect((await productPage(p)).rating).toEqual({ average: 5, count: 1 });
  });

  test('5 simultaneous reviews from the SAME buyer: exactly one is stored and counted', async () => {
    const p = await newProduct();
    const buyer = await buyerWhoReceived(p);

    const results = await Promise.all(Array.from({ length: 5 }, () => review(buyer.token, p.id, { rating: 3 })));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect((await productPage(p)).rating).toEqual({ average: 3, count: 1 });
  });
});

describe('rating average', () => {
  test('is the mean of all ratings, rounded to 2 decimals', async () => {
    const p = await newProduct();
    for (const rating of [5, 4, 4]) {
      const buyer = await buyerWhoReceived(p);
      await review(buyer.token, p.id, { rating }).expect(201);
    }
    expect((await productPage(p)).rating).toEqual({ average: 4.33, count: 3 });
  });

  test('8 buyers reviewing at the same moment: no rating is lost', async () => {
    const p = await newProduct();
    const buyers = await Promise.all(Array.from({ length: 8 }, () => buyerWhoReceived(p)));
    const ratings = [5, 4, 3, 5, 2, 4, 5, 1];

    const results = await Promise.all(buyers.map((b, i) => review(b.token, p.id, { rating: ratings[i] })));

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect((await productPage(p)).rating).toEqual({ average: 3.63, count: 8 }); // 29 / 8
  });

  test('the rating filter and sort use it', async () => {
    const good = await newProduct();
    const bad = await newProduct();
    await review((await buyerWhoReceived(good)).token, good.id, { rating: 5 }).expect(201);
    await review((await buyerWhoReceived(bad)).token, bad.id, { rating: 2 }).expect(201);

    const res = await request(app).get('/api/v1/products?minRating=4&sort=rating&limit=50');
    const ids = res.body.data.products.map((x) => x.id);
    expect(ids).toContain(good.id);
    expect(ids).not.toContain(bad.id);
  });
});

describe('failure between the two writes', () => {
  test('if updating the rating fails, the review is removed again (never stored but uncounted)', async () => {
    const productRepository = require('../../src/modules/products/product.repository');
    const reviewRepository = require('../../src/modules/reviews/review.repository');
    const p = await newProduct();
    const buyer = await buyerWhoReceived(p);

    const spy = jest.spyOn(productRepository, 'addRating').mockRejectedValueOnce(new Error('mongo hiccup'));
    const failed = await review(buyer.token, p.id, { rating: 5 });
    spy.mockRestore();

    expect(failed.status).toBe(500);
    expect(await reviewRepository.listByProduct(p.id, { limit: 10 })).toHaveLength(0);
    expect((await productPage(p)).rating.count).toBe(0);
    // and the buyer can simply try again
    expect((await review(buyer.token, p.id, { rating: 5 })).status).toBe(201);
  });
});

describe('validation and listing', () => {
  test.each([
    ['rating 0', { rating: 0 }],
    ['rating 6', { rating: 6 }],
    ['a fractional rating', { rating: 4.5 }],
    ['a string rating', { rating: '5' }],
    ['no rating', {}],
    ['an unknown field', { rating: 5, productId: 'x' }],
  ])('rejects %s with 422', async (_n, body) => {
    const p = await newProduct();
    const buyer = await buyerWhoReceived(p);
    expect((await review(buyer.token, p.id, body)).status).toBe(422);
  });

  test('reviews are listed newest first with cursor pagination', async () => {
    const p = await newProduct();
    for (let i = 1; i <= 3; i += 1) {
      await review((await buyerWhoReceived(p)).token, p.id, { rating: i, comment: `review ${i}` }).expect(201);
    }

    const first = await request(app).get(`/api/v1/products/${p.id}/reviews?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.data.rating).toEqual({ average: 2, count: 3 });
    expect(first.body.data.reviews).toHaveLength(2);
    expect(first.body.data.nextCursor).not.toBeNull();

    const second = await request(app).get(`/api/v1/products/${p.id}/reviews?limit=2&cursor=${first.body.data.nextCursor}`);
    expect(second.body.data.reviews).toHaveLength(1);
    expect(second.body.data.nextCursor).toBeNull();
    const all = [...first.body.data.reviews, ...second.body.data.reviews];
    expect(new Set(all.map((r) => r.id)).size).toBe(3);
  });

  test('review output never exposes the buyer id or email', async () => {
    const p = await newProduct();
    const buyer = await buyerWhoReceived(p);
    await review(buyer.token, p.id).expect(201);
    const body = JSON.stringify((await request(app).get(`/api/v1/products/${p.id}/reviews`)).body);
    expect(body).not.toContain(buyer.id);
    expect(body).not.toContain(buyer.email);
  });
});
