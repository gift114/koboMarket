const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const controller = require('./products.controller');
const v = require('./products.validation');
const reviewValidation = require('../reviews/reviews.validation');

const router = Router();

/**
 * @openapi
 * /products:
 *   get:
 *     tags: [Products]
 *     summary: Search and list products (public)
 *     description: |
 *       Full-text search on name and description, filters, sorting and **cursor** pagination.
 *       Pass the returned `nextCursor` back as `cursor` (with the same `sort`) to get the next page.
 *       Money is integer kobo.
 *     parameters:
 *       - { name: q, in: query, description: Full-text search, schema: { type: string } }
 *       - { name: category, in: query, schema: { type: string } }
 *       - { name: tag, in: query, schema: { type: string } }
 *       - { name: vendor, in: query, description: Vendor id, schema: { type: string } }
 *       - { name: minPrice, in: query, description: kobo, schema: { type: integer } }
 *       - { name: maxPrice, in: query, description: kobo, schema: { type: integer } }
 *       - { name: minRating, in: query, schema: { type: number, minimum: 0, maximum: 5 } }
 *       - { name: sort, in: query, schema: { type: string, enum: [newest, price_asc, price_desc, rating], default: newest } }
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
 *       - { name: cursor, in: query, schema: { type: string } }
 *     responses:
 *       200: { description: "{ products: [...], nextCursor }" }
 *       422: { description: Invalid query or cursor }
 */
router.get('/', validate({ query: v.listQuery }), controller.list);

/**
 * @openapi
 * /products:
 *   post:
 *     tags: [Products]
 *     summary: Create a product (approved vendors only)
 *     description: |
 *       Without variants send `priceKobo` (and `stock`). With variants, each variant has its own
 *       `priceKobo` and `stock`; the product price becomes the lowest variant price and the
 *       stock the total. The slug is generated from the name.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, category]
 *             properties:
 *               name: { type: string, example: "Ankara Tote Bag" }
 *               description: { type: string }
 *               category: { type: string, example: bags }
 *               priceKobo: { type: integer, example: 1500000 }
 *               stock: { type: integer, example: 20 }
 *               images: { type: array, items: { type: string } }
 *               tags: { type: array, items: { type: string } }
 *               variants:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     sku: { type: string }
 *                     attributes: { type: object, example: { size: M, colour: red } }
 *                     priceKobo: { type: integer }
 *                     stock: { type: integer }
 *               isActive: { type: boolean, default: true }
 *     responses:
 *       201: { description: Created }
 *       403: { description: Not an approved vendor }
 *       422: { description: Validation failed }
 */
router.post('/', authenticate, authorize('vendor'), validate({ body: v.createBody }), controller.create);

/**
 * @openapi
 * /products/mine:
 *   get:
 *     tags: [Products]
 *     summary: My own products, including paused ones (approved vendors only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
 *       - { name: cursor, in: query, schema: { type: string } }
 *     responses:
 *       200: { description: "{ products: [...], nextCursor }" }
 *       403: { description: Not an approved vendor }
 */
router.get('/mine', authenticate, authorize('vendor'), validate({ query: v.mineQuery }), controller.listMine);

/**
 * @openapi
 * /products/{slug}:
 *   get:
 *     tags: [Products]
 *     summary: Product page by slug (public; inactive or deleted products are 404)
 *     parameters:
 *       - { name: slug, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Product }
 *       404: { description: Not found }
 */
router.get('/:slug', validate({ params: v.slugParams }), controller.getBySlug);

/**
 * @openapi
 * /products/{id}:
 *   patch:
 *     tags: [Products]
 *     summary: Update my product (vendor who owns it)
 *     description: Send only the fields to change. `variants` replaces the whole list; keep a variant by sending its `id`.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Updated }
 *       403: { description: Not your product }
 *       404: { description: Not found }
 *       422: { description: Validation failed }
 *   delete:
 *     tags: [Products]
 *     summary: Soft-delete my product (vendor who owns it)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deleted (the record is kept for order history) }
 *       403: { description: Not your product }
 *       404: { description: Not found }
 */
router.patch('/:id', authenticate, authorize('vendor'), validate({ params: v.idParams, body: v.updateBody }), controller.update);
router.delete('/:id', authenticate, authorize('vendor'), validate({ params: v.idParams }), controller.remove);

/**
 * @openapi
 * /products/{id}/reviews:
 *   post:
 *     tags: [Reviews]
 *     summary: Review a product (only buyers with a completed order for it; one review each)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rating]
 *             properties:
 *               rating: { type: integer, minimum: 1, maximum: 5 }
 *               title: { type: string }
 *               comment: { type: string }
 *     responses:
 *       201: { description: "Created; returns the product's new rating average and count" }
 *       403: { description: No completed order for this product }
 *       409: { description: Already reviewed }
 *   get:
 *     tags: [Reviews]
 *     summary: Reviews of a product, newest first (public)
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *       - { name: limit, in: query, schema: { type: integer } }
 *       - { name: cursor, in: query, schema: { type: string } }
 *     responses:
 *       200: { description: "{ reviews, rating, nextCursor }" }
 */
router.post('/:id/reviews', authenticate, validate({ params: v.idParams, body: reviewValidation.createBody }), controller.addReview);
router.get('/:id/reviews', validate({ params: v.idParams, query: reviewValidation.listQuery }), controller.listReviews);

module.exports = router;
