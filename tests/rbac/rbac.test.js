const backend = require('../helpers/backend'); // must come before the app (installs mocks)
const express = require('express');
const request = require('supertest');
const createApp = require('../../src/app');
const authenticate = require('../../src/middlewares/authenticate');
const authorize = require('../../src/middlewares/authorize');
const { errorHandler } = require('../../src/middlewares/errorHandler');
const userRepository = require('../../src/modules/users/user.repository');
const { createUserAndLogin, bearer } = require('../helpers/users');

const app = createApp();

// A tiny app that uses the middleware exactly the way the routes do, so every combination of
// roles can be tested without depending on which feature routes exist yet.
const probe = express();
probe.get('/public', (req, res) => res.json({ ok: true }));
probe.get('/any-user', authenticate, (req, res) => res.json({ ok: true }));
probe.get('/vendor-only', authenticate, authorize('vendor'), (req, res) => res.json({ ok: true }));
probe.get('/admin-only', authenticate, authorize('admin'), (req, res) => res.json({ ok: true }));
probe.get('/vendor-or-admin', authenticate, authorize('vendor', 'admin'), (req, res) => res.json({ ok: true }));
probe.use(errorHandler);

const get = (path, token) => {
  const req = request(probe).get(path);
  return token ? req.set(bearer(token)) : req;
};

beforeAll(() => backend.start());
afterAll(() => backend.stop());

describe('authorize() middleware', () => {
  test('no token: 401, not 403', async () => {
    const res = await get('/vendor-only');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MISSING_TOKEN');
  });

  test('a buyer is refused vendor-only and admin-only routes with 403 INSUFFICIENT_ROLE', async () => {
    const buyer = await createUserAndLogin(app, { roles: ['buyer'] });
    for (const path of ['/vendor-only', '/admin-only', '/vendor-or-admin']) {
      const res = await get(path, buyer.token);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'INSUFFICIENT_ROLE', message: expect.stringContaining('requires one of'), details: null },
      });
    }
    expect((await get('/any-user', buyer.token)).status).toBe(200);
  });

  test('a vendor reaches vendor routes but not admin routes', async () => {
    const vendor = await createUserAndLogin(app, { roles: ['buyer', 'vendor'] });
    expect((await get('/vendor-only', vendor.token)).status).toBe(200);
    expect((await get('/admin-only', vendor.token)).status).toBe(403);
  });

  test('an admin reaches admin routes but not vendor-only routes', async () => {
    const admin = await createUserAndLogin(app, { roles: ['buyer', 'admin'] });
    expect((await get('/admin-only', admin.token)).status).toBe(200);
    expect((await get('/vendor-only', admin.token)).status).toBe(403);
  });

  test('a user can hold several roles at once (buyer and vendor)', async () => {
    const both = await createUserAndLogin(app, { roles: ['buyer', 'vendor'] });
    expect((await get('/any-user', both.token)).status).toBe(200);
    expect((await get('/vendor-only', both.token)).status).toBe(200);
  });

  test('listing several roles means ANY of them is enough', async () => {
    const vendor = await createUserAndLogin(app, { roles: ['vendor'] });
    const admin = await createUserAndLogin(app, { roles: ['admin'] });
    const buyer = await createUserAndLogin(app, { roles: ['buyer'] });
    expect((await get('/vendor-or-admin', vendor.token)).status).toBe(200);
    expect((await get('/vendor-or-admin', admin.token)).status).toBe(200);
    expect((await get('/vendor-or-admin', buyer.token)).status).toBe(403);
  });

  test('roles are read live: a role granted after login works with the SAME token', async () => {
    const user = await createUserAndLogin(app, { roles: ['buyer'] });
    expect((await get('/vendor-only', user.token)).status).toBe(403);

    await userRepository.addRole(user.id, 'vendor');

    expect((await get('/vendor-only', user.token)).status).toBe(200); // no re-login needed
  });

  test('authorize() with no roles is a programming error caught at startup', () => {
    expect(() => authorize()).toThrow(/at least one role/);
  });
});

describe('Real admin routes are protected', () => {
  const anId = 'a'.repeat(24);

  test('anonymous callers get 401', async () => {
    expect((await request(app).get('/api/v1/admin/vendors')).status).toBe(401);
    expect((await request(app).patch(`/api/v1/admin/vendors/${anId}/approve`)).status).toBe(401);
  });

  test('a buyer cannot list, approve or reject vendor applications', async () => {
    const buyer = await createUserAndLogin(app, { roles: ['buyer'] });
    const calls = [
      request(app).get('/api/v1/admin/vendors'),
      request(app).patch(`/api/v1/admin/vendors/${anId}/approve`),
      request(app).patch(`/api/v1/admin/vendors/${anId}/reject`).send({ reason: 'nope' }),
    ];
    for (const call of calls) {
      const res = await call.set(bearer(buyer.token));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_ROLE');
    }
  });

  test('a vendor cannot use admin routes either', async () => {
    const vendor = await createUserAndLogin(app, { roles: ['buyer', 'vendor'] });
    const res = await request(app).get('/api/v1/admin/vendors').set(bearer(vendor.token));
    expect(res.status).toBe(403);
  });

  test('an admin can', async () => {
    const admin = await createUserAndLogin(app, { roles: ['buyer', 'admin'] });
    const res = await request(app).get('/api/v1/admin/vendors').set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('vendors');
  });
});
