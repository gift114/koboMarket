const backend = require('../helpers/backend'); // must come before the app (installs mocks)
const request = require('supertest');
const createApp = require('../../src/app');
const { createUserAndLogin, bearer } = require('../helpers/users');
const { createVendor, createProduct, patchProduct } = require('../helpers/catalog');

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
afterAll(() => backend.stop());

const getCart = (user) => request(app).get('/api/v1/cart').set(bearer(user.token));
const add = (user, body) => request(app).post('/api/v1/cart/items').set(bearer(user.token)).send(body);
const setQty = (user, itemId, quantity) => request(app).patch(`/api/v1/cart/items/${itemId}`).set(bearer(user.token)).send({ quantity });
const remove = (user, itemId) => request(app).delete(`/api/v1/cart/items/${itemId}`).set(bearer(user.token));
const cartOf = (res) => res.body.data.cart;
const newBuyer = () => createUserAndLogin(app);

describe('basics', () => {
  test('every cart route needs authentication', async () => {
    expect((await request(app).get('/api/v1/cart')).status).toBe(401);
    expect((await request(app).post('/api/v1/cart/items').send({})).status).toBe(401);
  });

  test('a new user has an empty cart', async () => {
    const buyer = await newBuyer();
    expect(cartOf(await getCart(buyer))).toMatchObject({ items: [], vendors: [], itemCount: 0, totalKobo: 0, hasIssues: false });
  });

  test('adding a product shows it at its current price with the line total in integer kobo', async () => {
    const buyer = await newBuyer();
    const p = await createProduct(app, vendorA, { priceKobo: 250_000, stock: 5 });

    const res = await add(buyer, { productId: p.id, quantity: 2 });

    expect(res.status).toBe(201);
    const cart = cartOf(res);
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]).toMatchObject({
      productId: p.id,
      name: p.name,
      quantity: 2,
      addedPriceKobo: 250_000,
      currentPriceKobo: 250_000,
      lineTotalKobo: 500_000,
      priceChanged: false,
      available: true,
      issue: null,
      vendorId: vendorA.vendorId,
    });
    expect(cart.totalKobo).toBe(500_000);
    expect(cart.totalDisplay).toBe('N5,000.00');
  });

  test('adding the same product again merges into one line', async () => {
    const buyer = await newBuyer();
    const p = await createProduct(app, vendorA, { stock: 10 });
    await add(buyer, { productId: p.id, quantity: 2 }).expect(201);
    const cart = cartOf(await add(buyer, { productId: p.id, quantity: 3 }));
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].quantity).toBe(5);
  });

  test('quantity defaults to 1', async () => {
    const buyer = await newBuyer();
    const p = await createProduct(app, vendorA);
    expect(cartOf(await add(buyer, { productId: p.id })).items[0].quantity).toBe(1);
  });

  test("a user never sees someone else's cart", async () => {
    const a = await newBuyer();
    const b = await newBuyer();
    const p = await createProduct(app, vendorA);
    await add(a, { productId: p.id }).expect(201);
    expect(cartOf(await getCart(b)).items).toEqual([]);
  });
});

describe('multi-vendor carts', () => {
  test('items from 3 vendors are grouped by vendor with correct subtotals', async () => {
    const buyer = await newBuyer();
    const p1 = await createProduct(app, vendorA, { priceKobo: 100_000 });
    const p2 = await createProduct(app, vendorA, { priceKobo: 50_000 });
    const p3 = await createProduct(app, vendorB, { priceKobo: 200_000 });
    const p4 = await createProduct(app, vendorC, { priceKobo: 75_000 });
    await add(buyer, { productId: p1.id, quantity: 2 }).expect(201); // A 200,000
    await add(buyer, { productId: p2.id, quantity: 1 }).expect(201); // A  50,000
    await add(buyer, { productId: p3.id, quantity: 1 }).expect(201); // B 200,000
    await add(buyer, { productId: p4.id, quantity: 4 }).expect(201); // C 300,000

    const cart = cartOf(await getCart(buyer));

    expect(cart.vendors).toHaveLength(3);
    const subtotal = (vendor) => cart.vendors.find((g) => g.vendorId === vendor.vendorId);
    expect(subtotal(vendorA)).toMatchObject({ itemCount: 3, subtotalKobo: 250_000 });
    expect(subtotal(vendorB)).toMatchObject({ itemCount: 1, subtotalKobo: 200_000 });
    expect(subtotal(vendorC)).toMatchObject({ itemCount: 4, subtotalKobo: 300_000 });
    expect(cart.totalKobo).toBe(750_000);
    expect(cart.totalKobo).toBe(cart.vendors.reduce((sum, g) => sum + g.subtotalKobo, 0));
  });
});

describe('variants', () => {
  const variants = [
    { attributes: { size: 'S' }, priceKobo: 100_000, stock: 2 },
    { attributes: { size: 'L' }, priceKobo: 180_000, stock: 5 },
  ];

  test('a product with variants needs a variantId, and the line uses that variant price and stock', async () => {
    const buyer = await newBuyer();
    const p = await createProduct(app, vendorA, { priceKobo: undefined, stock: undefined, variants });
    const large = p.variants.find((v) => v.attributes.size === 'L');

    expect((await add(buyer, { productId: p.id })).status).toBe(422);
    const res = await add(buyer, { productId: p.id, variantId: large.id, quantity: 2 });

    expect(res.status).toBe(201);
    expect(cartOf(res).items[0]).toMatchObject({ variantId: large.id, attributes: { size: 'L' }, currentPriceKobo: 180_000, lineTotalKobo: 360_000 });
  });

  test('different variants of one product are separate lines; stock is per variant', async () => {
    const buyer = await newBuyer();
    const p = await createProduct(app, vendorA, { priceKobo: undefined, stock: undefined, variants });
    const [small, large] = [p.variants.find((v) => v.attributes.size === 'S'), p.variants.find((v) => v.attributes.size === 'L')];

    await add(buyer, { productId: p.id, variantId: small.id, quantity: 2 }).expect(201);
    await add(buyer, { productId: p.id, variantId: large.id, quantity: 5 }).expect(201);
    const tooMany = await add(buyer, { productId: p.id, variantId: small.id, quantity: 1 }); // S has only 2

    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(cartOf(await getCart(buyer)).items).toHaveLength(2);
  });

  test('a variant id of another product, or on a product without variants, is rejected', async () => {
    const buyer = await newBuyer();
    const withVariants = await createProduct(app, vendorA, { priceKobo: undefined, stock: undefined, variants });
    const plain = await createProduct(app, vendorA);
    expect((await add(buyer, { productId: plain.id, variantId: withVariants.variants[0].id })).status).toBe(422);
    const other = await createProduct(app, vendorA, { priceKobo: undefined, stock: undefined, variants });
    expect((await add(buyer, { productId: withVariants.id, variantId: other.variants[0].id })).status).toBe(422);
  });
});

describe('stock and quantity rules', () => {
  test('more than the stock is 409 INSUFFICIENT_STOCK and tells how many are left', async () => {
    const buyer = await newBuyer();
    const p = await createProduct(app, vendorA, { stock: 3 });
    const res = await add(buyer, { productId: p.id, quantity: 4 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.error.details).toMatchObject({ availableStock: 3, requestedQuantity: 4 });
    expect(cartOf(await getCart(buyer)).items).toEqual([]);
  });

  test('the TOTAL in the cart counts: 2 + 2 against a stock of 3 is refused', async () => {
    const buyer = await newBuyer();
    const p = await createProduct(app, vendorA, { stock: 3 });
    await add(buyer, { productId: p.id, quantity: 2 }).expect(201);
    expect((await add(buyer, { productId: p.id, quantity: 2 })).status).toBe(409);
    expect(cartOf(await getCart(buyer)).items[0].quantity).toBe(2);
  });

  test('a product with no stock is 409 OUT_OF_STOCK', async () => {
    const buyer = await newBuyer();
    const p = await createProduct(app, vendorA, { stock: 0 });
    const res = await add(buyer, { productId: p.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OUT_OF_STOCK');
  });

  test.each([
    ['zero', { quantity: 0 }],
    ['negative', { quantity: -1 }],
    ['fractional', { quantity: 1.5 }],
    ['a string', { quantity: '2' }],
    ['over 99', { quantity: 100 }],
  ])('a %s quantity is 422', async (_n, body) => {
    const buyer = await newBuyer();
    const p = await createProduct(app, vendorA, { stock: 500 });
    expect((await add(buyer, { productId: p.id, ...body })).status).toBe(422);
  });

  test('unknown fields (like a client-sent price) are rejected, not trusted', async () => {
    const buyer = await newBuyer();
    const p = await createProduct(app, vendorA);
    const res = await add(buyer, { productId: p.id, quantity: 1, priceKobo: 1 });
    expect(res.status).toBe(422);
  });

  test('you cannot buy your own product', async () => {
    const p = await createProduct(app, vendorA);
    const res = await add(vendorA, { productId: p.id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CANNOT_BUY_OWN_PRODUCT');
  });

  test('unknown, inactive and deleted products are 404', async () => {
    const buyer = await newBuyer();
    const inactive = await createProduct(app, vendorA, { isActive: false });
    const deleted = await createProduct(app, vendorA);
    await request(app).delete(`/api/v1/products/${deleted.id}`).set(bearer(vendorA.token)).expect(200);

    expect((await add(buyer, { productId: '000000000000000000000000' })).status).toBe(404);
    expect((await add(buyer, { productId: inactive.id })).status).toBe(404);
    expect((await add(buyer, { productId: deleted.id })).status).toBe(404);
  });

  test('a cart holds at most 50 different items', async () => {
    const buyer = await newBuyer();
    for (let i = 0; i < 50; i += 1) {
      const p = await createProduct(app, vendorA);
      await add(buyer, { productId: p.id }).expect(201);
    }
    const extra = await createProduct(app, vendorA);
    const res = await add(buyer, { productId: extra.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CART_FULL');
  }, 60_000);
});

describe('updating and removing', () => {
  test('PATCH sets the quantity and re-checks stock', async () => {
    const buyer = await newBuyer();
    const p = await createProduct(app, vendorA, { stock: 4 });
    const itemId = cartOf(await add(buyer, { productId: p.id })).items[0].id;

    const ok = await setQty(buyer, itemId, 4);
    expect(cartOf(ok).items[0].quantity).toBe(4);
    const tooMany = await setQty(buyer, itemId, 5);
    expect(tooMany.status).toBe(409);
    expect(cartOf(await getCart(buyer)).items[0].quantity).toBe(4);
    expect((await setQty(buyer, itemId, 0)).status).toBe(422);
  });

  test('DELETE removes the line and the totals follow', async () => {
    const buyer = await newBuyer();
    const p1 = await createProduct(app, vendorA, { priceKobo: 100_000 });
    const p2 = await createProduct(app, vendorB, { priceKobo: 200_000 });
    const first = cartOf(await add(buyer, { productId: p1.id })).items[0].id;
    await add(buyer, { productId: p2.id }).expect(201);

    const cart = cartOf(await remove(buyer, first));

    expect(cart.items).toHaveLength(1);
    expect(cart.totalKobo).toBe(200_000);
    expect(cart.vendors).toHaveLength(1);
    expect((await remove(buyer, first)).status).toBe(404); // already gone
  });

  test("another user's item id is 404 and nothing changes (no IDOR)", async () => {
    const owner = await newBuyer();
    const intruder = await newBuyer();
    const p = await createProduct(app, vendorA, { stock: 5 });
    const itemId = cartOf(await add(owner, { productId: p.id, quantity: 2 })).items[0].id;

    expect((await setQty(intruder, itemId, 5)).status).toBe(404);
    expect((await remove(intruder, itemId)).status).toBe(404);
    expect(cartOf(await getCart(owner)).items[0].quantity).toBe(2);
  });

  test('a malformed item id is 422', async () => {
    const buyer = await newBuyer();
    expect((await remove(buyer, 'not-an-id')).status).toBe(422);
  });
});

describe('stale prices and changing products (the cart must not trust its own snapshot)', () => {
  test('a price change is shown: current price, priceChanged, and the line total uses the CURRENT price', async () => {
    const buyer = await newBuyer();
    const p = await createProduct(app, vendorA, { priceKobo: 100_000 });
    await add(buyer, { productId: p.id, quantity: 3 }).expect(201);

    await patchProduct(app, vendorA, p.id, { priceKobo: 150_000 }).expect(200);
    const cart = cartOf(await getCart(buyer));

    expect(cart.items[0]).toMatchObject({ addedPriceKobo: 100_000, currentPriceKobo: 150_000, priceChanged: true, lineTotalKobo: 450_000 });
    expect(cart.totalKobo).toBe(450_000);
    expect(cart.hasIssues).toBe(true);
  });

  test('adding or changing a line refreshes its price snapshot (the buyer has just seen the current price)', async () => {
    const buyer = await newBuyer();
    const p = await createProduct(app, vendorA, { priceKobo: 100_000, stock: 10 });
    await add(buyer, { productId: p.id }).expect(201);
    await patchProduct(app, vendorA, p.id, { priceKobo: 120_000 }).expect(200);
    expect(cartOf(await getCart(buyer)).items[0].priceChanged).toBe(true);

    const cart = cartOf(await add(buyer, { productId: p.id }));

    expect(cart.items[0]).toMatchObject({ quantity: 2, addedPriceKobo: 120_000, priceChanged: false, lineTotalKobo: 240_000 });
  });

  test('a deactivated product is flagged PRODUCT_UNAVAILABLE and left out of the total', async () => {
    const buyer = await newBuyer();
    const keep = await createProduct(app, vendorA, { priceKobo: 100_000 });
    const gone = await createProduct(app, vendorB, { priceKobo: 300_000 });
    await add(buyer, { productId: keep.id }).expect(201);
    await add(buyer, { productId: gone.id }).expect(201);

    await patchProduct(app, vendorB, gone.id, { isActive: false }).expect(200);
    const cart = cartOf(await getCart(buyer));

    const line = cart.items.find((i) => i.productId === gone.id);
    expect(line).toMatchObject({ available: false, issue: 'PRODUCT_UNAVAILABLE' });
    expect(cart.totalKobo).toBe(100_000);
    expect(cart.vendors).toHaveLength(1);
  });

  test('a deleted product is flagged too, and can be removed from the cart', async () => {
    const buyer = await newBuyer();
    const p = await createProduct(app, vendorA);
    const itemId = cartOf(await add(buyer, { productId: p.id })).items[0].id;
    await request(app).delete(`/api/v1/products/${p.id}`).set(bearer(vendorA.token)).expect(200);

    expect(cartOf(await getCart(buyer)).items[0].issue).toBe('PRODUCT_UNAVAILABLE');
    expect(cartOf(await remove(buyer, itemId)).items).toEqual([]);
  });

  test('stock dropping below the quantity is flagged INSUFFICIENT_STOCK; to zero is OUT_OF_STOCK', async () => {
    const buyer = await newBuyer();
    const p = await createProduct(app, vendorA, { stock: 10 });
    await add(buyer, { productId: p.id, quantity: 5 }).expect(201);

    await patchProduct(app, vendorA, p.id, { stock: 2 }).expect(200);
    const short = cartOf(await getCart(buyer));
    expect(short.items[0]).toMatchObject({ issue: 'INSUFFICIENT_STOCK', availableStock: 2, available: false });
    expect(short.totalKobo).toBe(0); // a line that cannot be bought is not in the total
    expect(short.vendors).toEqual([]);

    await patchProduct(app, vendorA, p.id, { stock: 0 }).expect(200);
    expect(cartOf(await getCart(buyer)).items[0].issue).toBe('OUT_OF_STOCK');
  });

  test('a variant the vendor removed is flagged VARIANT_UNAVAILABLE', async () => {
    const buyer = await newBuyer();
    const p = await createProduct(app, vendorA, {
      priceKobo: undefined,
      stock: undefined,
      variants: [
        { attributes: { size: 'S' }, priceKobo: 100_000, stock: 5 },
        { attributes: { size: 'M' }, priceKobo: 120_000, stock: 5 },
      ],
    });
    const small = p.variants.find((v) => v.attributes.size === 'S');
    const medium = p.variants.find((v) => v.attributes.size === 'M');
    await add(buyer, { productId: p.id, variantId: small.id }).expect(201);

    await patchProduct(app, vendorA, p.id, { variants: [{ id: medium.id, attributes: { size: 'M' }, priceKobo: 120_000, stock: 5 }] }).expect(200);

    expect(cartOf(await getCart(buyer)).items[0].issue).toBe('VARIANT_UNAVAILABLE');
  });

  test("PATCH on a line whose product became unavailable is 409, not a silent success", async () => {
    const buyer = await newBuyer();
    const p = await createProduct(app, vendorA);
    const itemId = cartOf(await add(buyer, { productId: p.id })).items[0].id;
    await patchProduct(app, vendorA, p.id, { isActive: false }).expect(200);
    const res = await setQty(buyer, itemId, 2);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PRODUCT_UNAVAILABLE');
  });
});

describe('concurrency', () => {
  test('10 simultaneous "add 1" against a stock of 5: exactly 5 succeed, the cart holds exactly 5', async () => {
    const buyer = await newBuyer();
    const p = await createProduct(app, vendorA, { stock: 5 });

    const results = await Promise.all(Array.from({ length: 10 }, () => add(buyer, { productId: p.id, quantity: 1 })));

    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    const failed = results.filter((r) => r.status !== 201);
    expect(failed).toHaveLength(5);
    failed.forEach((r) => expect(r.body.error.code).toBe('INSUFFICIENT_STOCK'));
    const cart = cartOf(await getCart(buyer));
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].quantity).toBe(5);
  });

  test('8 different products added at the same moment: none is lost', async () => {
    const buyer = await newBuyer();
    const products = await Promise.all(Array.from({ length: 8 }, () => createProduct(app, vendorA)));

    const results = await Promise.all(products.map((p) => add(buyer, { productId: p.id })));

    expect(results.every((r) => r.status === 201)).toBe(true);
    const cart = cartOf(await getCart(buyer));
    expect(cart.items.map((i) => i.productId).sort()).toEqual(products.map((p) => p.id).sort());
  });
});

describe('prepareCheckout (used by checkout on Day 9)', () => {
  const cartService = require('../../src/modules/cart/cart.service');

  test('an empty cart is CART_EMPTY', async () => {
    const buyer = await newBuyer();
    await expect(cartService.prepareCheckout(buyer.id)).rejects.toMatchObject({ code: 'CART_EMPTY', statusCode: 409 });
  });

  test('prices every line at the CURRENT price, never the stale one in the cart', async () => {
    const buyer = await newBuyer();
    const a = await createProduct(app, vendorA, { priceKobo: 100_000 });
    const b = await createProduct(app, vendorB, { priceKobo: 200_000 });
    await add(buyer, { productId: a.id, quantity: 2 }).expect(201);
    await add(buyer, { productId: b.id, quantity: 1 }).expect(201);
    await patchProduct(app, vendorA, a.id, { priceKobo: 130_000 }).expect(200); // goes up after adding

    const prepared = await cartService.prepareCheckout(buyer.id);

    const lineA = prepared.lines.find((l) => l.productId === a.id);
    expect(lineA).toMatchObject({ quantity: 2, unitPriceKobo: 130_000, lineTotalKobo: 260_000, vendorId: vendorA.vendorId, vendorUserId: vendorA.id });
    expect(prepared.totalKobo).toBe(460_000);
    expect(prepared.priceChanges).toEqual([{ itemId: expect.any(String), name: a.name, addedPriceKobo: 100_000, currentPriceKobo: 130_000 }]);
    expect(prepared.lines.every((l) => Number.isSafeInteger(l.unitPriceKobo) && Number.isSafeInteger(l.lineTotalKobo))).toBe(true);
  });

  test('refuses (CART_INVALID) when any line is unavailable or over stock, listing every problem', async () => {
    const buyer = await newBuyer();
    const ok = await createProduct(app, vendorA, { stock: 10 });
    const lowStock = await createProduct(app, vendorB, { stock: 10 });
    const gone = await createProduct(app, vendorC, { stock: 10 });
    await add(buyer, { productId: ok.id }).expect(201);
    await add(buyer, { productId: lowStock.id, quantity: 5 }).expect(201);
    await add(buyer, { productId: gone.id }).expect(201);
    await patchProduct(app, vendorB, lowStock.id, { stock: 1 }).expect(200);
    await patchProduct(app, vendorC, gone.id, { isActive: false }).expect(200);

    const err = await cartService.prepareCheckout(buyer.id).catch((e) => e);

    expect(err).toMatchObject({ code: 'CART_INVALID', statusCode: 409 });
    expect(err.details.problems.map((p) => [p.productId, p.issue]).sort()).toEqual(
      [[lowStock.id, 'INSUFFICIENT_STOCK'], [gone.id, 'PRODUCT_UNAVAILABLE']].sort(),
    );
  });
});
