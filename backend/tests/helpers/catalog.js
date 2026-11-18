const request = require('supertest');
const { createUserAndLogin, bearer } = require('./users');

let seq = 0;

/** A logged-in user whose vendor application an admin has approved. */
async function createVendor(app, admin) {
  const user = await createUserAndLogin(app);
  seq += 1;
  const applied = await request(app)
    .post('/api/v1/vendors/apply')
    .set(bearer(user.token))
    .send({
      storeName: `Catalog Store ${Date.now()}-${seq}`,
      bankDetails: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Catalog Store' },
    })
    .expect(201);
  await request(app).patch(`/api/v1/admin/vendors/${applied.body.data.vendor.id}/approve`).set(bearer(admin.token)).expect(200);
  return { ...user, vendorId: applied.body.data.vendor.id };
}

async function createProduct(app, vendor, overrides = {}) {
  seq += 1;
  const res = await request(app)
    .post('/api/v1/products')
    .set(bearer(vendor.token))
    .send({ name: `Catalog Item ${Date.now()}-${seq}`, category: 'misc', priceKobo: 100_000, stock: 10, ...overrides })
    .expect(201);
  return res.body.data.product;
}

const patchProduct = (app, vendor, id, body) =>
  request(app).patch(`/api/v1/products/${id}`).set(bearer(vendor.token)).send(body);

module.exports = { createVendor, createProduct, patchProduct };
