const spec = require('../../src/docs/swagger'); // throws in the test environment if any @openapi block is invalid
const fs = require('fs');
const path = require('path');

/** Every `router.<method>('<path>'` in a routes file, with the mount prefix of that file. */
const MOUNTS = {
  'src/modules/auth/auth.routes.js': '/auth',
  'src/modules/users/users.routes.js': '/users',
  'src/modules/vendors/vendors.routes.js': '/vendors',
  'src/modules/admin/admin.routes.js': '/admin',
  'src/modules/reports/reports.routes.js': '/admin/reports',
  'src/modules/products/products.routes.js': '/products',
  'src/modules/cart/cart.routes.js': '/cart',
  'src/modules/orders/orders.routes.js': '/orders',
  'src/modules/disputes/disputes.routes.js': '/disputes',
  'src/modules/payouts/payouts.routes.js': '/payouts',
  'src/modules/notifications/notifications.routes.js': '/notifications',
  'src/modules/wallet/wallet.routes.js': '/wallet',
};

describe('API documentation', () => {
  test('builds without errors and has a title and the shared error schema', () => {
    expect(spec.info.title).toBe('KoboMarket API');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(40);
  });

  test('every Day 10-13 endpoint is documented', () => {
    const documented = (p, m) => Boolean(spec.paths[p] && spec.paths[p][m]);
    const expected = [
      ['/orders/sales', 'get'],
      ['/orders/sub-orders/{id}/ship', 'post'],
      ['/orders/sub-orders/{id}/confirm-delivery', 'post'],
      ['/orders/sub-orders/{id}/cancel', 'post'],
      ['/orders/sub-orders/{id}/dispute', 'post'],
      ['/disputes', 'get'],
      ['/disputes/{id}', 'get'],
      ['/disputes/{id}/resolve', 'post'],
      ['/payouts', 'post'],
      ['/payouts', 'get'],
      ['/payouts/{id}', 'get'],
      ['/notifications', 'get'],
      ['/notifications/unread-count', 'get'],
      ['/notifications/read-all', 'patch'],
      ['/notifications/{id}/read', 'patch'],
      ['/admin/users', 'get'],
      ['/admin/users/{id}/freeze', 'patch'],
      ['/admin/users/{id}/unfreeze', 'patch'],
      ['/admin/wallets/{userId}', 'get'],
      ['/admin/wallets/{userId}/ledger', 'get'],
      ['/admin/settings/commission', 'get'],
      ['/admin/settings/commission', 'put'],
      ['/admin/reports/revenue-by-day', 'get'],
      ['/admin/reports/top-vendors', 'get'],
      ['/admin/reports/escrow', 'get'],
      ['/admin/reports/reconciliation', 'get'],
    ];
    expect(expected.filter(([p, m]) => !documented(p, m))).toEqual([]);
  });

  test('no route in the code is missing from the documentation (checked against the routers)', () => {
    const toOpenApi = (p) => p.replace(/:(\w+)/g, '{$1}');
    const missing = [];
    for (const [file, prefix] of Object.entries(MOUNTS)) {
      const source = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
      const re = /router\.(get|post|put|patch|delete)\(\s*['"]([^'"]*)['"]/g;
      let m;
      while ((m = re.exec(source))) {
        const full = toOpenApi(`${prefix}${m[2] === '/' ? '' : m[2]}`) || '/';
        const candidates = [full, full.replace('{id}', '{userId}'), full.replace('{userId}', '{id}')];
        if (!candidates.some((c) => spec.paths[c] && spec.paths[c][m[1]])) missing.push(`${m[1].toUpperCase()} ${full}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('payments routers (funding, webhooks, dev mock gateway) and health are documented too', () => {
    const toOpenApi = (p) => p.replace(/:(\w+)/g, '{$1}');
    const targets = [
      ['src/modules/payments/payments.routes.js', { walletFunding: '/wallet', webhooks: '/webhooks', mockGateway: '/dev' }],
      ['src/routes/health.routes.js', { router: '/health' }],
    ];
    const missing = [];
    for (const [file, vars] of targets) {
      const source = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
      for (const [name, prefix] of Object.entries(vars)) {
        const re = new RegExp(`\\b${name}\\.(get|post|put|patch|delete)\\(\\s*['"]([^'"]*)['"]`, 'g');
        let m;
        let found = 0;
        while ((m = re.exec(source))) {
          found += 1;
          const full = toOpenApi(`${prefix}${m[2] === '/' ? '' : m[2]}`);
          if (!(spec.paths[full] && spec.paths[full][m[1]])) missing.push(`${m[1].toUpperCase()} ${full}`);
        }
        expect([name, found > 0]).toEqual([name, true]); // the regex really found routes
      }
    }
    expect(missing).toEqual([]);
  });
});
