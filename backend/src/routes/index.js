const { Router } = require('express');
const config = require('../config');
const healthRoutes = require('./health.routes');

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', require('../modules/auth/auth.routes'));
router.use('/users', require('../modules/users/users.routes'));
router.use('/vendors', require('../modules/vendors/vendors.routes'));
router.use('/admin', require('../modules/admin/admin.routes'));
const payments = require('../modules/payments/payments.routes');
router.use('/wallet', payments.walletFunding); // POST /wallet/fund, GET /wallet/fund/:reference
router.use('/wallet', require('../modules/wallet/wallet.routes'));
router.use('/webhooks', payments.webhooks);
if (config.payments.provider === 'mock' && !config.isProd) router.use('/dev', payments.mockGateway);
router.use('/products', require('../modules/products/products.routes'));
router.use('/cart', require('../modules/cart/cart.routes'));
router.use('/orders', require('../modules/orders/orders.routes'));
router.use('/notifications', require('../modules/notifications/notifications.routes'));
router.use('/payouts', require('../modules/payouts/payouts.routes'));
router.use('/disputes', require('../modules/disputes/disputes.routes'));

// Further module routers are mounted here as each module is built.

module.exports = router;
