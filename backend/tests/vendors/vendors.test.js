const backend = require('../helpers/backend'); // must come before the app (installs mocks)
const request = require('supertest');
const createApp = require('../../src/app');
const userRepository = require('../../src/modules/users/user.repository');
const vendorRepository = require('../../src/modules/vendors/vendor.repository');
const { createUserAndLogin, bearer } = require('../helpers/users');

const app = createApp();
let adminSeq = 0;
let storeSeq = 0;
let admin;

const application = (overrides = {}) => ({
  storeName: `Ade Fashion House ${Date.now()}-${(storeSeq += 1)}`,
  description: 'Ankara and lace, made in Lagos',
  bankDetails: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Ade Fashion Ltd' },
  ...overrides,
});

const apply = (token, body = application()) =>
  request(app).post('/api/v1/vendors/apply').set(bearer(token)).send(body);
const approve = (id) => request(app).patch(`/api/v1/admin/vendors/${id}/approve`).set(bearer(admin.token));
const reject = (id, reason = 'Bank details do not match') =>
  request(app).patch(`/api/v1/admin/vendors/${id}/reject`).set(bearer(admin.token)).send({ reason });
const me = (token) => request(app).get('/api/v1/users/me').set(bearer(token));

beforeAll(async () => {
  await backend.start();
  admin = await createUserAndLogin(app, { roles: ['buyer', 'admin'], email: `admin${Date.now()}${(adminSeq += 1)}@example.com` });
});
afterAll(() => backend.stop());

describe('Applying to become a vendor', () => {
  test('creates a pending application and masks the bank account number', async () => {
    const buyer = await createUserAndLogin(app);
    const res = await apply(buyer.token);

    expect(res.status).toBe(201);
    const { vendor } = res.body.data;
    expect(vendor.status).toBe('pending');
    expect(vendor.bankDetails).toEqual({
      bankName: 'GTBank',
      accountNumberMasked: '******6789',
      accountName: 'Ade Fashion Ltd',
    });
    expect(JSON.stringify(res.body)).not.toContain('0123456789');

    // The real number is stored for payouts.
    const stored = await vendorRepository.findByUserId(buyer.id);
    expect(stored.bankDetails.accountNumber).toBe('0123456789');
  });

  test('being pending does not grant the vendor role', async () => {
    const buyer = await createUserAndLogin(app);
    await apply(buyer.token).expect(201);
    expect((await me(buyer.token)).body.data.user.roles).toEqual(['buyer']);
  });

  test('requires login', async () => {
    expect((await request(app).post('/api/v1/vendors/apply').send(application())).status).toBe(401);
  });

  test('validates the body, including the 10-digit account number and unknown fields', async () => {
    const buyer = await createUserAndLogin(app);
    const bad = [
      application({ storeName: 'ab' }),
      application({ bankDetails: { bankName: 'GTBank', accountNumber: '12345', accountName: 'Ade' } }),
      application({ bankDetails: { bankName: 'GTBank', accountNumber: 'abcdefghij', accountName: 'Ade' } }),
      application({ status: 'approved' }),
      application({ bankDetails: undefined }),
    ];
    for (const body of bad) {
      const res = await apply(buyer.token, body);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  test('a user cannot have two applications', async () => {
    const buyer = await createUserAndLogin(app);
    await apply(buyer.token).expect(201);
    const again = await apply(buyer.token);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('APPLICATION_PENDING');
  });

  test('store names are unique regardless of case and spacing', async () => {
    const first = await createUserAndLogin(app);
    const second = await createUserAndLogin(app);
    const name = `Unique   Store ${Date.now()}`;
    await apply(first.token, application({ storeName: name })).expect(201);

    const res = await apply(second.token, application({ storeName: name.toUpperCase().replace(/ +/g, ' ') }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STORE_NAME_TAKEN');
  });

  test('two applications for the same store name at the same instant: exactly one wins', async () => {
    const a = await createUserAndLogin(app);
    const b = await createUserAndLogin(app);
    const body = application();
    const results = await Promise.all([apply(a.token, body), apply(b.token, body)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  test('GET /vendors/me shows my own application, or 404 if I never applied', async () => {
    const buyer = await createUserAndLogin(app);
    const none = await request(app).get('/api/v1/vendors/me').set(bearer(buyer.token));
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe('NO_APPLICATION');

    await apply(buyer.token).expect(201);
    const mine = await request(app).get('/api/v1/vendors/me').set(bearer(buyer.token));
    expect(mine.status).toBe(200);
    expect(mine.body.data.vendor.status).toBe('pending');
  });
});

describe('Admin approval', () => {
  test('approving grants the vendor role immediately, with the vendor\'s existing token', async () => {
    const buyer = await createUserAndLogin(app);
    const { vendor } = (await apply(buyer.token)).body.data;

    const res = await approve(vendor.id);
    expect(res.status).toBe(200);
    expect(res.body.data.vendor).toMatchObject({ status: 'approved', reviewedBy: admin.id, userId: buyer.id });

    expect((await me(buyer.token)).body.data.user.roles).toEqual(expect.arrayContaining(['buyer', 'vendor']));
  });

  test('approving twice is harmless and does not duplicate the role', async () => {
    const buyer = await createUserAndLogin(app);
    const { vendor } = (await apply(buyer.token)).body.data;
    await approve(vendor.id).expect(200);
    await approve(vendor.id).expect(200);
    const roles = (await me(buyer.token)).body.data.user.roles;
    expect(roles.filter((r) => r === 'vendor')).toHaveLength(1);
  });

  test('re-approving repairs an approval whose role grant was lost', async () => {
    const buyer = await createUserAndLogin(app);
    const { vendor } = (await apply(buyer.token)).body.data;

    // Simulate a crash between "status = approved" and "role added".
    await vendorRepository.transition(vendor.id, 'pending', { status: 'approved', reviewedBy: admin.id, reviewedAt: new Date() });
    expect((await me(buyer.token)).body.data.user.roles).toEqual(['buyer']);

    await approve(vendor.id).expect(200);
    expect((await me(buyer.token)).body.data.user.roles).toContain('vendor');
  });

  test('if granting the role fails, the approval is rolled back to pending', async () => {
    const buyer = await createUserAndLogin(app);
    const { vendor } = (await apply(buyer.token)).body.data;

    const spy = jest.spyOn(userRepository, 'addRole').mockRejectedValueOnce(new Error('mongo hiccup'));
    try {
      const res = await approve(vendor.id);
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }

    expect((await vendorRepository.findById(vendor.id)).status).toBe('pending');
    expect((await me(buyer.token)).body.data.user.roles).toEqual(['buyer']);
    await approve(vendor.id).expect(200); // and it can simply be retried
  });

  test('rejecting needs a reason, and the applicant sees it', async () => {
    const buyer = await createUserAndLogin(app);
    const { vendor } = (await apply(buyer.token)).body.data;

    const noReason = await request(app)
      .patch(`/api/v1/admin/vendors/${vendor.id}/reject`)
      .set(bearer(admin.token))
      .send({});
    expect(noReason.status).toBe(422);

    const res = await reject(vendor.id, 'Account name does not match the store owner');
    expect(res.status).toBe(200);
    expect(res.body.data.vendor.status).toBe('rejected');

    const mine = await request(app).get('/api/v1/vendors/me').set(bearer(buyer.token));
    expect(mine.body.data.vendor).toMatchObject({
      status: 'rejected',
      rejectionReason: 'Account name does not match the store owner',
    });
    expect((await me(buyer.token)).body.data.user.roles).toEqual(['buyer']);
  });

  test('only pending applications can be decided', async () => {
    const buyer = await createUserAndLogin(app);
    const { vendor } = (await apply(buyer.token)).body.data;
    await reject(vendor.id).expect(200);

    const approveRejected = await approve(vendor.id);
    expect(approveRejected.status).toBe(409);
    expect(approveRejected.body.error.code).toBe('INVALID_STATE');
    expect((await reject(vendor.id)).status).toBe(409);

    const other = await createUserAndLogin(app);
    const second = (await apply(other.token)).body.data.vendor;
    await approve(second.id).expect(200);
    expect((await reject(second.id)).status).toBe(409); // cannot reject an approved vendor
  });

  test('approve and reject racing: exactly one decision is applied', async () => {
    const buyer = await createUserAndLogin(app);
    const { vendor } = (await apply(buyer.token)).body.data;

    const [a, r] = await Promise.all([approve(vendor.id), reject(vendor.id)]);
    expect([a.status, r.status].sort()).toEqual([200, 409]);

    const final = await vendorRepository.findById(vendor.id);
    const roles = (await me(buyer.token)).body.data.user.roles;
    expect(roles.includes('vendor')).toBe(final.status === 'approved');
  });

  test('a rejected applicant can fix the application and apply again', async () => {
    const buyer = await createUserAndLogin(app);
    const { vendor } = (await apply(buyer.token)).body.data;
    await reject(vendor.id).expect(200);

    const retry = await apply(buyer.token, application({ storeName: 'Ade Fashion House Reloaded' }));
    expect(retry.status).toBe(201);
    expect(retry.body.data.vendor).toMatchObject({ id: vendor.id, status: 'pending', rejectionReason: null });

    await approve(vendor.id).expect(200);
    const again = await apply(buyer.token);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_A_VENDOR');
  });

  test('unknown or malformed ids', async () => {
    expect((await approve('b'.repeat(24))).status).toBe(404);
    expect((await approve('not-an-id')).status).toBe(422);
  });

  test('the admin list filters by status and pages with a cursor', async () => {
    const buyers = await Promise.all([1, 2, 3].map(() => createUserAndLogin(app)));
    for (const b of buyers) await apply(b.token).expect(201);

    const pageOne = await request(app)
      .get('/api/v1/admin/vendors?status=pending&limit=2')
      .set(bearer(admin.token));
    expect(pageOne.status).toBe(200);
    expect(pageOne.body.data.vendors).toHaveLength(2);
    expect(pageOne.body.data.nextCursor).toEqual(expect.any(String));
    pageOne.body.data.vendors.forEach((v) => expect(v.status).toBe('pending'));

    const pageTwo = await request(app)
      .get(`/api/v1/admin/vendors?status=pending&limit=2&cursor=${pageOne.body.data.nextCursor}`)
      .set(bearer(admin.token));
    const idsOne = pageOne.body.data.vendors.map((v) => v.id);
    pageTwo.body.data.vendors.forEach((v) => expect(idsOne).not.toContain(v.id));

    // Admins see the owner's id but still never the full account number.
    expect(JSON.stringify(pageOne.body)).not.toContain('0123456789');
    expect((await request(app).get('/api/v1/admin/vendors?limit=1000').set(bearer(admin.token))).status).toBe(422);
  });
});

describe('Public store page', () => {
  test('shows approved vendors only, without bank details or status', async () => {
    const buyer = await createUserAndLogin(app);
    const { vendor } = (await apply(buyer.token)).body.data;

    const whilePending = await request(app).get(`/api/v1/vendors/${vendor.id}`);
    expect(whilePending.status).toBe(404);
    expect(whilePending.body.error.code).toBe('VENDOR_NOT_FOUND');

    await approve(vendor.id).expect(200);
    const res = await request(app).get(`/api/v1/vendors/${vendor.id}`); // no login needed
    expect(res.status).toBe(200);
    expect(res.body.data.vendor).toEqual({
      id: vendor.id,
      storeName: vendor.storeName,
      description: 'Ankara and lace, made in Lagos',
      createdAt: expect.any(String),
    });
    expect(JSON.stringify(res.body)).not.toMatch(/bank|account|userId|status/i);
  });

  test('rejected and unknown vendors are indistinguishable (404)', async () => {
    const buyer = await createUserAndLogin(app);
    const { vendor } = (await apply(buyer.token)).body.data;
    await reject(vendor.id).expect(200);
    expect((await request(app).get(`/api/v1/vendors/${vendor.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/vendors/${'c'.repeat(24)}`)).status).toBe(404);
    expect((await request(app).get('/api/v1/vendors/not-an-id')).status).toBe(422);
  });
});
