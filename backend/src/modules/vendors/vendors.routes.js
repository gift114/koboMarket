const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const controller = require('./vendors.controller');
const v = require('./vendors.validation');

const router = Router();

/**
 * @openapi
 * /vendors/apply:
 *   post:
 *     tags: [Vendors]
 *     summary: Apply to become a vendor (status starts as pending; an admin decides)
 *     description: A rejected applicant may apply again with corrected details.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [storeName, bankDetails]
 *             properties:
 *               storeName: { type: string, example: "Ade Fashion House" }
 *               description: { type: string }
 *               bankDetails:
 *                 type: object
 *                 required: [bankName, accountNumber, accountName]
 *                 properties:
 *                   bankName: { type: string, example: "GTBank" }
 *                   accountNumber: { type: string, example: "0123456789" }
 *                   accountName: { type: string }
 *     responses:
 *       201: { description: Application submitted (bank account number is masked in the response) }
 *       409: { description: Already pending, already a vendor, or store name taken }
 *       422: { description: Validation failed }
 */
router.post('/apply', authenticate, validate({ body: v.applyBody }), controller.apply);

/**
 * @openapi
 * /vendors/me:
 *   get:
 *     tags: [Vendors]
 *     summary: My own vendor application / store, with its status
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: My application }
 *       404: { description: I have not applied }
 */
// Declared before "/:id" so "me" is not treated as an id.
router.get('/me', authenticate, controller.getMine);

/**
 * @openapi
 * /vendors/{id}:
 *   get:
 *     tags: [Vendors]
 *     summary: Public store page (approved vendors only)
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Store }
 *       404: { description: Not found, or not approved }
 */
router.get('/:id', validate({ params: v.idParams }), controller.getPublicStore);

module.exports = router;
