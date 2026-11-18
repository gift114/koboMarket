/* Builds docs/KoboMarket.postman_collection.json from the OpenAPI spec (the single source of truth),
 * so the collection can never drift from /api-docs. Run: npm run postman */
const fs = require('fs');
const path = require('path');
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
const spec = require('../src/docs/swagger');

const OUT = path.join(__dirname, '../docs/KoboMarket.postman_collection.json');

// Path parameters become collection variables ({{orderId}}), saved by hand or by the scripts below.
const toPostmanPath = (p) => p.replace(/\{(\w+)\}/g, (_, n) => `{{${n}}}`);

function exampleOf(schema) {
  if (!schema) return undefined;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case 'object': {
      const out = {};
      for (const [k, v] of Object.entries(schema.properties || {})) {
        const required = (schema.required || []).includes(k);
        const ex = exampleOf(v);
        if (required && ex !== undefined) out[k] = ex;
        else if (!required && ex !== undefined && out && Object.keys(schema.properties).length <= 3) out[k] = ex;
      }
      return out;
    }
    case 'array': return schema.items ? [exampleOf(schema.items)].filter((x) => x !== undefined) : [];
    case 'integer': case 'number': return schema.minimum ?? 1;
    case 'boolean': return true;
    case 'string':
      if (schema.format === 'email') return '{{email}}';
      if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
      return schema.minLength ? 'x'.repeat(schema.minLength) : 'string';
    default: return undefined;
  }
}

// Hand-tuned bodies for the requests people run first, so the demo flow works with no editing.
const BODIES = {
  'POST /auth/register': { email: '{{email}}', password: '{{password}}', fullName: 'Demo User' },
  'POST /auth/login': { email: '{{email}}', password: '{{password}}' },
  'POST /auth/refresh': { refreshToken: '{{refreshToken}}' },
  'POST /auth/logout': { refreshToken: '{{refreshToken}}' },
  'POST /wallet/fund': { amountKobo: 500000 },
  'POST /cart/items': { productId: '{{productId}}', quantity: 1 },
  'POST /payouts': { amountKobo: 100000 },
};

const SAVE_SESSION = [
  'const j = pm.response.json();',
  'if (j.success && j.data && j.data.accessToken) {',
  "  pm.collectionVariables.set('token', j.data.accessToken);",
  "  pm.collectionVariables.set('refreshToken', j.data.refreshToken);",
  '}',
];
const SAVE_FIRST_ID = (varName, pathInBody) => [
  'const j = pm.response.json();',
  `try { const v = ${pathInBody}; if (v) pm.collectionVariables.set('${varName}', v); } catch (e) {}`,
];
const SAVERS = {
  'POST /auth/login': SAVE_SESSION,
  'POST /auth/refresh': SAVE_SESSION,
  'POST /products': SAVE_FIRST_ID('productId', 'j.data.product.id'),
  'POST /orders/checkout': SAVE_FIRST_ID('subOrderId', 'j.data.order.subOrders[0].id'),
  'POST /wallet/fund': SAVE_FIRST_ID('reference', 'j.data.payment.reference'),
  'POST /vendors/apply': SAVE_FIRST_ID('vendorId', 'j.data.vendor.id'),
  'POST /payouts': SAVE_FIRST_ID('payoutId', 'j.data.payout.id'),
};

const items = new Map();
for (const [p, ops] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(ops)) {
    const key = `${method.toUpperCase()} ${p}`;
    const tag = (op.tags && op.tags[0]) || 'Other';
    const header = [];
    const query = [];
    for (const prm of op.parameters || []) {
      if (prm.in === 'header' && prm.name === 'Idempotency-Key') header.push({ key: 'Idempotency-Key', value: '{{$guid}}', description: 'New value per logical request; reuse it to see the replay.' });
      else if (prm.in === 'query') query.push({ key: prm.name, value: String(exampleOf(prm.schema) ?? ''), disabled: !prm.required, description: prm.description || '' });
    }
    let body;
    const json = op.requestBody && op.requestBody.content && op.requestBody.content['application/json'];
    if (json) {
      header.push({ key: 'Content-Type', value: 'application/json' });
      const ex = BODIES[key] ?? exampleOf(json.schema) ?? {};
      body = { mode: 'raw', raw: JSON.stringify(ex, null, 2), options: { raw: { language: 'json' } } };
    }
    const secured = Array.isArray(op.security) && op.security.length > 0;
    const events = [];
    if (SAVERS[key]) events.push({ listen: 'test', script: { type: 'text/javascript', exec: SAVERS[key] } });
    const path = toPostmanPath(p);
    const item = {
      name: `${method.toUpperCase()} ${p} - ${(op.summary || '').replace(/^"|"$/g, '')}`.slice(0, 140),
      event: events,
      request: {
        method: method.toUpperCase(),
        header,
        ...(body ? { body } : {}),
        ...(secured ? { auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] } } : { auth: { type: 'noauth' } }),
        url: { raw: `{{baseUrl}}${path}${query.length ? '?' + query.filter((q) => !q.disabled).map((q) => `${q.key}=${q.value}`).join('&') : ''}`, host: ['{{baseUrl}}'], path: path.split('/').filter(Boolean), query },
        description: op.description || op.summary || '',
      },
    };
    if (!items.has(tag)) items.set(tag, []);
    items.get(tag).push(item);
  }
}

const tagOrder = (spec.tags || []).map((t) => t.name);
const folders = [...items.entries()]
  .sort((a, b) => (tagOrder.indexOf(a[0]) + 1 || 99) - (tagOrder.indexOf(b[0]) + 1 || 99))
  .map(([name, item]) => ({ name, item }));

const collection = {
  info: {
    name: 'KoboMarket API',
    description: 'Generated from the OpenAPI spec (npm run postman). Start with Auth -> register, verify, login (the login request stores {{token}}). Money is integer kobo. Every state-changing money request has an Idempotency-Key header filled with {{$guid}}.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    { key: 'baseUrl', value: 'http://localhost:3000/api/v1' },
    { key: 'email', value: 'demo.buyer@example.com' },
    { key: 'password', value: 'ChangeMe123!' },
    { key: 'token', value: '' },
    { key: 'refreshToken', value: '' },
    ...['id', 'userId', 'productId', 'vendorId', 'subOrderId', 'reference', 'payoutId', 'slug'].map((key) => ({ key, value: '' })),
  ],
  item: folders,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(collection, null, 2) + '\n');
const count = folders.reduce((n, f) => n + f.item.length, 0);
console.log(`Wrote ${path.relative(process.cwd(), OUT)}: ${folders.length} folders, ${count} requests`);
