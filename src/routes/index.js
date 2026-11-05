const { Router } = require('express');
const healthRoutes = require('./health.routes');

const router = Router();

router.use('/health', healthRoutes);

// Module routers are mounted here as each module is built, e.g.:
// router.use('/auth', require('../modules/auth/auth.routes'));

module.exports = router;
