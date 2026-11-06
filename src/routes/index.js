const { Router } = require('express');
const healthRoutes = require('./health.routes');

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', require('../modules/auth/auth.routes'));
router.use('/users', require('../modules/users/users.routes'));
router.use('/vendors', require('../modules/vendors/vendors.routes'));
router.use('/admin', require('../modules/admin/admin.routes'));

// Further module routers are mounted here as each module is built.

module.exports = router;
