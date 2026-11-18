const { canonical } = require('../../src/modules/idempotency/idempotency.middleware');

test('canonical JSON ignores key order but not values', () => {
  expect(canonical({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(canonical({ b: { d: [1, 2], c: 2 }, a: 1 }));
  expect(canonical({ a: 1 })).not.toBe(canonical({ a: 2 }));
  expect(canonical({ a: [1, 2] })).not.toBe(canonical({ a: [2, 1] }));
  expect(canonical(undefined)).toBe('null');
});
