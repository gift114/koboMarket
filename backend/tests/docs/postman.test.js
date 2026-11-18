const backend = require('../helpers/backend'); // must come before the app (installs mocks)
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const createApp = require('../../src/app');
const { db } = require('../../src/config/postgres');
const spec = require('../../src/docs/swagger');

const app = createApp();
const FILE = path.join(__dirname, '../../docs/KoboMarket.postman_collection.json');
const collection = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const requests = collection.item.flatMap((f) => f.item.map((i) => i.request));

const VARS = Object.fromEntries(collection.variable.map((v) => [v.key, v.value || '00000000-0000-4000-8000-000000000000']));
const fill = (s) => s.replace(/\{\{(\$guid|\w+)\}\}/g, (_, k) => (k === '$guid' ? `guid-${Math.random().toString(16).slice(2)}-padding` : VARS[k] ?? 'x'));

beforeAll(() => backend.start());
afterAll(async () => {
  await backend.stop();
  await db.destroy();
});

describe('Postman collection', () => {
  test('is in sync with the OpenAPI spec (run `npm run postman` after changing routes)', () => {
    const fromSpec = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p.replace(/\{(\w+)\}/g, '{{$1}}')}`)).sort();
    const fromFile = requests.map((r) => `${r.method} /${r.url.path.join('/')}`).sort();
    expect(fromFile).toEqual(fromSpec);
  });

  test('declares baseUrl, token and a fresh Idempotency-Key on every money endpoint', () => {
    const names = collection.variable.map((v) => v.key);
    expect(names).toEqual(expect.arrayContaining(['baseUrl', 'token', 'refreshToken', 'email', 'password']));
    for (const r of requests) {
      const needsKey = /\/(checkout|payouts|wallet\/fund)$/.test(r.url.path.join('/')) && r.method === 'POST';
      const hasKey = r.header.some((h) => h.key === 'Idempotency-Key' && h.value === '{{$guid}}');
      if (needsKey) expect([r.url.raw, hasKey]).toEqual([r.url.raw, true]);
    }
  });

  test('every request reaches a real route (no ROUTE_NOT_FOUND) and secured ones carry the bearer token', async () => {
    const lost = [];
    for (const r of requests) {
      const url = fill(r.url.raw).replace('http://localhost:3000/api/v1', '/api/v1');
      let req = request(app)[r.method.toLowerCase()](url);
      for (const h of r.header) req = req.set(h.key, fill(h.value));
      if (r.auth && r.auth.type === 'bearer') {
        expect(r.auth.bearer[0].value).toBe('{{token}}');
      }
      const res = await (r.body ? req.send(JSON.parse(fill(r.body.raw))) : req);
      if (res.body && res.body.error && res.body.error.code === 'ROUTE_NOT_FOUND') lost.push(`${r.method} ${url}`);
    }
    expect(lost).toEqual([]);
  });
});
