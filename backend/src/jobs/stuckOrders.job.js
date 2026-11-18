const config = require('../config');
const checkoutService = require('../modules/orders/checkout.service');

module.exports = {
  name: 'stuck-orders',
  run: () => checkoutService.reconcileStuckOrders(config.business.checkoutStuckSeconds),
};
