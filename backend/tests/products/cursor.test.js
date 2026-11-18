const sift = require('sift');
const { SORT_NAMES, mongoAfterCursor, isAfterCursor, comparator, encodeCursor, decodeCursor } = require('../../src/modules/products/product.query');

/**
 * The HTTP tests run the in-memory repository when MongoDB is unavailable, so this test checks
 * that the REAL MongoDB filter built by mongoAfterCursor selects exactly the same rows as the
 * plain-JavaScript rule the in-memory repository uses. `sift` evaluates MongoDB query objects.
 * Many ties are generated on purpose: ties are where keyset pagination usually breaks.
 */
function randomProducts(n) {
  const hex = () => [...Array(24)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
  return Array.from({ length: n }, () => ({
    id: hex(),
    priceKobo: 100 * (1 + Math.floor(Math.random() * 4)),
    ratingAvg: Math.floor(Math.random() * 3),
    createdAt: new Date(1_700_000_000_000 + 1000 * Math.floor(Math.random() * 4)),
  }));
}
// sift matches on `_id`, the real documents' field name
const asDoc = (p) => ({ ...p, _id: p.id });

describe.each(SORT_NAMES)('cursor rule, sort=%s', (sort) => {
  test('MongoDB filter and the in-memory rule select the same rows for every possible cursor', () => {
    const rows = randomProducts(60).sort(comparator(sort));
    for (const last of rows) {
      const after = decodeCursor(sort, encodeCursor(sort, last));
      const viaMongoFilter = rows.filter((r) => sift(mongoAfterCursor(sort, after))(asDoc(r))).map((r) => r.id);
      const viaMemoryRule = rows.filter((r) => isAfterCursor(sort, r, after)).map((r) => r.id);
      expect(viaMongoFilter).toEqual(viaMemoryRule);
      // ...and that set is exactly the rows that come after `last` in the sort order
      expect(viaMemoryRule).toEqual(rows.slice(rows.indexOf(last) + 1).map((r) => r.id));
    }
  });
});

test('a page walk with heavy ties returns every row exactly once', () => {
  const rows = randomProducts(40).sort(comparator('price_asc'));
  const seen = [];
  let after = null;
  for (;;) {
    const page = rows.filter((r) => !after || isAfterCursor('price_asc', r, after)).slice(0, 7);
    if (page.length === 0) break;
    seen.push(...page.map((r) => r.id));
    after = decodeCursor('price_asc', encodeCursor('price_asc', page[page.length - 1]));
  }
  expect(seen).toEqual(rows.map((r) => r.id));
});
