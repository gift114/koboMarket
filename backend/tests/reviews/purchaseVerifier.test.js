const { db } = require('../../src/config/postgres');
const { hasCompletedPurchase } = require('../../src/modules/reviews/purchaseVerifier');

afterAll(() => db.destroy());

const BUYER = 'a'.repeat(24);
const PRODUCT = 'b'.repeat(24);

describe('purchase verifier (real PostgreSQL)', () => {
  test('with no orders, nobody has a completed purchase', async () => {
    expect(await hasCompletedPurchase(BUYER, PRODUCT)).toBe(false);
  });

  test('returns false (not an error) when the orders tables do not exist yet', async () => {
    let result;
    await db
      .transaction(async (trx) => {
        await trx.raw('ALTER TABLE order_items RENAME TO order_items_hidden');
        result = await hasCompletedPurchase(BUYER, PRODUCT, trx);
        throw new Error('ROLLBACK_ON_PURPOSE');
      })
      .catch((e) => {
        if (e.message !== 'ROLLBACK_ON_PURPOSE') throw e;
      });
    expect(result).toBe(false);
  });
});
