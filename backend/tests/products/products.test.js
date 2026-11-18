const backend = require('../helpers/backend'); // must come before the app (installs mocks)
const request = require('supertest');
const createApp = require('../../src/app');
const { createUserAndLogin, bearer } = require('../helpers/users');

const app = createApp();
let admin;
let seq = 0;

beforeAll(async () => {
  await backend.start();
  admin = await createUserAndLogin(app, { roles: ['buyer', 'admin'] });
});
afterAll(() => backend.stop());

/** A logged-in user whose vendor application an admin has approved. */
async function createVendor() {
  const user = await createUserAndLogin(app);
  seq += 1;
  const applied = await request(app)
    .post('/api/v1/vendors/apply')
    .set(bearer(user.token))
    .send({
      storeName: `Test Store ${Date.now()}-${seq}`,
      bankDetails: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Test Store Ltd' },
    })
    .expect(201);
  await request(app).patch(`/api/v1/admin/vendors/${applied.body.data.vendor.id}/approve`).set(bearer(admin.token)).expect(200);
  return { ...user, vendorId: applied.body.data.vendor.id };
}

const product = (overrides = {}) => ({
  name: `Ankara Tote Bag ${(seq += 1)}`,
  description: 'Handmade in Lagos',
  category: 'bags',
  priceKobo: 1_500_000,
  stock: 10,
  ...overrides,
});
const create = (vendor, body = product()) => request(app).post('/api/v1/products').set(bearer(vendor.token)).send(body);
const list = (query = '') => request(app).get(`/api/v1/products${query}`);

describe('creating products', () => {
  test('an approved vendor creates a product: slug generated, money in integer kobo', async () => {
    const vendor = await createVendor();
    const res = await create(vendor, product({ name: 'Ankara Tote Bag', tags: ['Bag', 'bag', 'Ankara'] }));

    expect(res.status).toBe(201);
    const p = res.body.data.product;
    expect(p).toMatchObject({
      name: 'Ankara Tote Bag',
      slug: expect.stringMatching(/^ankara-tote-bag/),
      priceKobo: 1_500_000,
      priceDisplay: 'N15,000.00',
      stock: 10,
      isActive: true,
      vendorId: vendor.vendorId,
      rating: { average: 0, count: 0 },
    });
    expect(p.tags).toEqual(['bag', 'ankara']); // lower-cased and de-duplicated
  });

  test('two products with the same name get different, unique slugs', async () => {
    const vendor = await createVendor();
    const body = product({ name: 'Identical Name Shoes' });
    const a = (await create(vendor, body)).body.data.product;
    const b = (await create(vendor, body)).body.data.product;
    expect(a.slug).not.toBe(b.slug);
  });

  test('a buyer who is not a vendor gets 403, and anonymous gets 401', async () => {
    const buyer = await createUserAndLogin(app);
    expect((await create(buyer)).status).toBe(403);
    expect((await request(app).post('/api/v1/products').send(product())).status).toBe(401);
  });

  test.each([
    ['a float price', { priceKobo: 10.5 }],
    ['a zero price', { priceKobo: 0 }],
    ['a negative price', { priceKobo: -5 }],
    ['a string price', { priceKobo: '1500' }],
    ['negative stock', { stock: -1 }],
    ['a missing price', { priceKobo: undefined }],
    ['an unknown field', { vendorId: '000000000000000000000000' }],
    ['a bad image url', { images: ['not a url'] }],
  ])('rejects %s with 422', async (_n, bad) => {
    const vendor = await createVendor();
    const res = await create(vendor, { ...product(), ...bad });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('listing my products', () => {
  test('returns paused products and paginates without being matched as a product slug', async () => {
    const vendor = await createVendor();
    const active = (await create(vendor, product({ name: 'Active listing' }))).body.data.product;
    const paused = (await create(vendor, product({ name: 'Paused listing', isActive: false }))).body.data.product;

    const first = await request(app)
      .get('/api/v1/products/mine?limit=1')
      .set(bearer(vendor.token))
      .expect(200);
    expect(first.body.data.products).toHaveLength(1);
    expect(first.body.data.nextCursor).toEqual(expect.any(String));

    const second = await request(app)
      .get(`/api/v1/products/mine?limit=1&cursor=${first.body.data.nextCursor}`)
      .set(bearer(vendor.token))
      .expect(200);
    expect(second.body.data.products).toHaveLength(1);
    expect(second.body.data.nextCursor).toBeNull();
    expect([...first.body.data.products, ...second.body.data.products].map((p) => p.id).sort())
      .toEqual([active.id, paused.id].sort());
    expect([...first.body.data.products, ...second.body.data.products].some((p) => !p.isActive)).toBe(true);
  });
});

describe('variants', () => {
  const variants = [
    { sku: 'TB-S', attributes: { size: 'S' }, priceKobo: 1_200_000, stock: 3 },
    { sku: 'TB-M', attributes: { size: 'M' }, priceKobo: 1_500_000, stock: 5 },
  ];

  test('each variant has its own price and stock; product price = lowest, stock = total', async () => {
    const vendor = await createVendor();
    const res = await create(vendor, { name: 'Variant Bag', category: 'bags', variants });
    expect(res.status).toBe(201);
    const p = res.body.data.product;
    expect(p.priceKobo).toBe(1_200_000);
    expect(p.stock).toBe(8);
    expect(p.variants).toHaveLength(2);
    expect(p.variants[0].id).toMatch(/^[a-f0-9]{24}$/);
    expect(p.variants[1]).toMatchObject({ sku: 'TB-M', priceKobo: 1_500_000, stock: 5 });
  });

  test('a product with variants cannot also set its own price or stock', async () => {
    const vendor = await createVendor();
    const res = await create(vendor, { name: 'Confused Bag', category: 'bags', variants, priceKobo: 5_000 });
    expect(res.status).toBe(422);
  });

  test('updating variants keeps the ids of kept variants, re-derives price and stock', async () => {
    const vendor = await createVendor();
    const p = (await create(vendor, { name: 'Update Bag', category: 'bags', variants })).body.data.product;
    const [s, m] = p.variants;

    const res = await request(app)
      .patch(`/api/v1/products/${p.id}`)
      .set(bearer(vendor.token))
      .send({
        variants: [
          { id: m.id, sku: 'TB-M', attributes: { size: 'M' }, priceKobo: 1_400_000, stock: 9 },
          { attributes: { size: 'L' }, priceKobo: 1_800_000, stock: 1 },
        ],
      });

    expect(res.status).toBe(200);
    const updated = res.body.data.product;
    expect(updated.variants.map((v) => v.id)).toContain(m.id);
    expect(updated.variants.map((v) => v.id)).not.toContain(s.id);
    expect(updated.priceKobo).toBe(1_400_000);
    expect(updated.stock).toBe(10);
  });

  test("a variant id from someone else's product is rejected", async () => {
    const vendor = await createVendor();
    const a = (await create(vendor, { name: 'Bag A', category: 'bags', variants })).body.data.product;
    const b = (await create(vendor, { name: 'Bag B', category: 'bags', variants })).body.data.product;
    const res = await request(app)
      .patch(`/api/v1/products/${a.id}`)
      .set(bearer(vendor.token))
      .send({ variants: [{ id: b.variants[0].id, priceKobo: 1_000, stock: 1 }] });
    expect(res.status).toBe(422);
  });

  test('removing all variants needs a price again', async () => {
    const vendor = await createVendor();
    const p = (await create(vendor, { name: 'Bag C', category: 'bags', variants })).body.data.product;
    const patch = (body) => request(app).patch(`/api/v1/products/${p.id}`).set(bearer(vendor.token)).send(body);

    expect((await patch({ variants: [] })).status).toBe(422);
    const ok = await patch({ variants: [], priceKobo: 900_000, stock: 4 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.product).toMatchObject({ priceKobo: 900_000, stock: 4, variants: [] });
  });
});

describe('updating and deleting', () => {
  test('the owner can update fields; the slug stays the same', async () => {
    const vendor = await createVendor();
    const p = (await create(vendor)).body.data.product;
    const res = await request(app)
      .patch(`/api/v1/products/${p.id}`)
      .set(bearer(vendor.token))
      .send({ name: 'Renamed Bag', priceKobo: 2_000_000, stock: 0 });
    expect(res.status).toBe(200);
    expect(res.body.data.product).toMatchObject({ name: 'Renamed Bag', priceKobo: 2_000_000, stock: 0, slug: p.slug });
  });

  test("another vendor cannot update or delete my product (403), and nothing changes", async () => {
    const owner = await createVendor();
    const other = await createVendor();
    const p = (await create(owner)).body.data.product;

    const patch = await request(app).patch(`/api/v1/products/${p.id}`).set(bearer(other.token)).send({ priceKobo: 1 });
    const del = await request(app).delete(`/api/v1/products/${p.id}`).set(bearer(other.token));
    expect(patch.status).toBe(403);
    expect(patch.body.error.code).toBe('NOT_YOUR_PRODUCT');
    expect(del.status).toBe(403);

    const page = await request(app).get(`/api/v1/products/${p.slug}`);
    expect(page.body.data.product.priceKobo).toBe(1_500_000);
  });

  test('an empty update is rejected', async () => {
    const vendor = await createVendor();
    const p = (await create(vendor)).body.data.product;
    expect((await request(app).patch(`/api/v1/products/${p.id}`).set(bearer(vendor.token)).send({})).status).toBe(422);
  });

  test('soft delete hides the product everywhere and cannot be repeated', async () => {
    const vendor = await createVendor();
    const p = (await create(vendor, product({ name: 'Doomed Satchel Unique' }))).body.data.product;

    const del = await request(app).delete(`/api/v1/products/${p.id}`).set(bearer(vendor.token));
    expect(del.status).toBe(200);

    expect((await request(app).get(`/api/v1/products/${p.slug}`)).status).toBe(404);
    const found = await list('?q=Doomed&limit=50');
    expect(found.body.data.products.find((x) => x.id === p.id)).toBeUndefined();
    expect((await request(app).delete(`/api/v1/products/${p.id}`).set(bearer(vendor.token))).status).toBe(404);
    expect((await request(app).patch(`/api/v1/products/${p.id}`).set(bearer(vendor.token)).send({ stock: 1 })).status).toBe(404);
  });

  test('an inactive product is hidden from the public but can be switched back on', async () => {
    const vendor = await createVendor();
    const p = (await create(vendor, product({ isActive: false }))).body.data.product;
    expect((await request(app).get(`/api/v1/products/${p.slug}`)).status).toBe(404);

    await request(app).patch(`/api/v1/products/${p.id}`).set(bearer(vendor.token)).send({ isActive: true }).expect(200);
    expect((await request(app).get(`/api/v1/products/${p.slug}`)).status).toBe(200);
  });
});

describe('search, filters and sorting', () => {
  let vendorA;
  let vendorB;
  const tag = `t${Date.now()}`; // isolates this block's products from every other test

  beforeAll(async () => {
    vendorA = await createVendor();
    vendorB = await createVendor();
    const rows = [
      [vendorA, 'Red Ankara Dress', 'dresses', 3_000_000, 'Bright red ankara fabric'],
      [vendorA, 'Blue Lace Dress', 'dresses', 5_000_000, 'Elegant blue lace'],
      [vendorA, 'Leather Sandals', 'shoes', 1_000_000, 'Hand stitched leather'],
      [vendorB, 'Ankara Shirt', 'shirts', 2_000_000, 'Casual ankara shirt'],
      [vendorB, 'Gold Chain', 'jewellery', 8_000_000, 'Plated gold chain'],
    ];
    for (const [vendor, name, category, priceKobo, description] of rows) {
      await create(vendor, { name, category, priceKobo, description, stock: 5, tags: [tag] }).expect(201);
    }
  });

  const names = (res) => res.body.data.products.map((p) => p.name);

  test('full-text search matches name and description', async () => {
    expect((await list(`?tag=${tag}&q=ankara`)).body.data.products.map((p) => p.name).sort()).toEqual([
      'Ankara Shirt',
      'Red Ankara Dress',
    ]);
    expect(names(await list(`?tag=${tag}&q=leather`))).toEqual(['Leather Sandals']); // description match
    expect(names(await list(`?tag=${tag}&q=nonexistentword`))).toEqual([]);
  });

  test('filters: category, vendor, price range', async () => {
    expect(names(await list(`?tag=${tag}&category=shoes`))).toEqual(['Leather Sandals']);
    expect((await list(`?tag=${tag}&vendor=${vendorB.vendorId}`)).body.data.products).toHaveLength(2);
    expect(names(await list(`?tag=${tag}&minPrice=2000000&maxPrice=5000000&sort=price_asc`))).toEqual([
      'Ankara Shirt',
      'Red Ankara Dress',
      'Blue Lace Dress',
    ]);
  });

  test('sorting by price ascending and descending', async () => {
    const asc = (await list(`?tag=${tag}&sort=price_asc`)).body.data.products.map((p) => p.priceKobo);
    const desc = (await list(`?tag=${tag}&sort=price_desc`)).body.data.products.map((p) => p.priceKobo);
    expect(asc).toEqual([1_000_000, 2_000_000, 3_000_000, 5_000_000, 8_000_000]);
    expect(desc).toEqual([...asc].reverse());
  });

  test('minRating only returns products rated at least that high', async () => {
    expect((await list(`?tag=${tag}&minRating=4`)).body.data.products).toHaveLength(0);
    expect((await list(`?tag=${tag}&minRating=0`)).body.data.products).toHaveLength(5);
  });

  test.each([
    '?minPrice=100&maxPrice=50',
    '?minPrice=1.5',
    '?sort=cheapest',
    '?limit=0',
    '?limit=51',
    '?minRating=6',
    '?vendor=nope',
  ])('rejects invalid query %s with 422', async (query) => {
    expect((await list(query)).status).toBe(422);
  });

  describe('cursor pagination', () => {
    async function walk(sort, limit) {
      const seen = [];
      let cursor = null;
      let pages = 0;
      do {
        const res = await list(`?tag=${tag}&sort=${sort}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.status).toBe(200);
        seen.push(...res.body.data.products);
        cursor = res.body.data.nextCursor;
        pages += 1;
      } while (cursor);
      return { seen, pages };
    }

    test.each(['newest', 'price_asc', 'price_desc', 'rating'])(
      'sort=%s: pages cover every product exactly once, in the same order as one big page',
      async (sort) => {
        const everything = (await list(`?tag=${tag}&sort=${sort}&limit=50`)).body.data.products.map((p) => p.id);
        const { seen, pages } = await walk(sort, 2);
        expect(pages).toBe(3);
        expect(seen.map((p) => p.id)).toEqual(everything);
        expect(new Set(seen.map((p) => p.id)).size).toBe(5);
      },
    );

    test('the last page has no cursor, and an exact-fit page does not invent a next one', async () => {
      const res = await list(`?tag=${tag}&limit=5`);
      expect(res.body.data.products).toHaveLength(5);
      expect(res.body.data.nextCursor).toBeNull();
    });

    test('a product added while paging does not shift or duplicate rows (unlike skip/limit)', async () => {
      const first = await list(`?tag=${tag}&sort=price_asc&limit=2`);
      await create(vendorA, { name: 'Brand New Cheapest', category: 'misc', priceKobo: 100, stock: 1, tags: [tag] }).expect(201);
      const second = await list(`?tag=${tag}&sort=price_asc&limit=2&cursor=${first.body.data.nextCursor}`);

      const firstIds = first.body.data.products.map((p) => p.id);
      expect(second.body.data.products.map((p) => p.id).filter((id) => firstIds.includes(id))).toEqual([]);
      expect(second.body.data.products.map((p) => p.priceKobo)).toEqual([3_000_000, 5_000_000]);
    });

    test('tampered, garbage and wrong-sort cursors are 422, not a crash or a wrong page', async () => {
      const page = await list(`?tag=${tag}&sort=price_asc&limit=2`);
      const cursor = page.body.data.nextCursor;
      expect((await list(`?tag=${tag}&sort=price_asc&cursor=garbage`)).status).toBe(422);
      expect((await list(`?tag=${tag}&sort=price_desc&cursor=${cursor}`)).status).toBe(422); // issued for another sort
      const forged = Buffer.from(JSON.stringify({ s: 'price_asc', v: { $gt: '' }, id: { $ne: null } })).toString('base64url');
      expect((await list(`?tag=${tag}&sort=price_asc&cursor=${forged}`)).status).toBe(422);
    });
  });
});

describe('public product page', () => {
  test('is fetched by slug without logging in; unknown slug is 404', async () => {
    const vendor = await createVendor();
    const p = (await create(vendor)).body.data.product;
    const res = await request(app).get(`/api/v1/products/${p.slug}`);
    expect(res.status).toBe(200);
    expect(res.body.data.product.id).toBe(p.id);
    expect((await request(app).get('/api/v1/products/no-such-product')).status).toBe(404);
  });
});
