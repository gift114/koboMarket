const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const controller = require('./cart.controller');
const v = require('./cart.validation');

const router = Router();
// A cart belongs to the logged-in user; there is no user id in any URL.
router.use(authenticate);

/**
 * @openapi
 * /cart:
 *   get:
 *     tags: [Cart]
 *     summary: My cart, priced at CURRENT prices with stock warnings
 *     description: |
 *       Each item shows the price when it was added (`addedPriceKobo`), the current price,
 *       `priceChanged`, and `issue` (PRODUCT_UNAVAILABLE, VARIANT_UNAVAILABLE, OUT_OF_STOCK,
 *       INSUFFICIENT_STOCK) when it cannot be bought as it is. `vendors` groups the purchasable
 *       items by vendor; `totalKobo` counts purchasable items only.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Cart }
 */
router.get('/', controller.get);

/**
 * @openapi
 * /cart/items:
 *   post:
 *     tags: [Cart]
 *     summary: Add a product (or variant) to the cart
 *     description: Adding something already in the cart increases its quantity. The total is checked against stock.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [productId]
 *             properties:
 *               productId: { type: string }
 *               variantId: { type: string, description: "required when the product has variants" }
 *               quantity: { type: integer, minimum: 1, maximum: 99, default: 1 }
 *     responses:
 *       201: { description: Updated cart }
 *       403: { description: Your own product }
 *       404: { description: Product not found or inactive }
 *       409: { description: Not enough stock, quantity limit, or cart full }
 *       422: { description: Validation failed }
 */
router.post('/items', validate({ body: v.addBody }), controller.add);

/**
 * @openapi
 * /cart/items/{itemId}:
 *   patch:
 *     tags: [Cart]
 *     summary: Set the quantity of a cart item
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: itemId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [quantity]
 *             properties:
 *               quantity: { type: integer, minimum: 1, maximum: 99 }
 *     responses:
 *       200: { description: Updated cart }
 *       404: { description: Item not in your cart }
 *       409: { description: Not enough stock, or the item is no longer available }
 *   delete:
 *     tags: [Cart]
 *     summary: Remove an item from the cart
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: itemId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Updated cart }
 *       404: { description: Item not in your cart }
 */
router.patch('/items/:itemId', validate({ params: v.itemParams, body: v.updateBody }), controller.update);
router.delete('/items/:itemId', validate({ params: v.itemParams }), controller.remove);

module.exports = router;
