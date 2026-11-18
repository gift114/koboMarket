const config = require('../config');
const fulfilmentService = require('../modules/orders/fulfilment.service');

module.exports = {
  name: 'escrow-auto-complete',
  run: () => fulfilmentService.autoCompleteOverdue(config.business.escrowAutoCompleteHours),
};
