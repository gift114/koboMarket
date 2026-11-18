const payoutsService = require('../modules/payouts/payouts.service');

module.exports = {
  name: 'payouts',
  run: () => payoutsService.processPending(),
};
