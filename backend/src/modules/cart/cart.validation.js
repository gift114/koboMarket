const { z } = require('zod');
const { objectId } = require('../products/products.validation');

const quantity = z.number().int().min(1).max(99);

const addBody = z
  .object({ productId: objectId, variantId: objectId.optional(), quantity: quantity.default(1) })
  .strict();
const updateBody = z.object({ quantity }).strict();
const itemParams = z.object({ itemId: objectId });

module.exports = { addBody, updateBody, itemParams };
