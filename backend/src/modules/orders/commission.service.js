const config = require('../../config');
const settingsRepository = require('../settings/settings.repository');

const KEY = 'commission_rate_bps';

/**
 * The commission rate (basis points: 500 = 5%) that applies to NEW orders: the admin's setting if
 * one exists, otherwise the configured default. It is copied onto each sub-order at checkout, so
 * a later change never alters an order already placed.
 */
async function getRateBps() {
  const setting = await settingsRepository.get(KEY);
  return setting ? setting.value : config.business.commissionRateBps;
}

async function getCommission() {
  const setting = await settingsRepository.get(KEY);
  return {
    rateBps: setting ? setting.value : config.business.commissionRateBps,
    ratePercent: (setting ? setting.value : config.business.commissionRateBps) / 100,
    source: setting ? 'admin' : 'default',
    updatedBy: setting ? setting.updatedBy : null,
    updatedAt: setting ? setting.updatedAt : null,
  };
}

async function setRateBps(admin, rateBps) {
  await settingsRepository.set(KEY, rateBps, admin.id);
  return getCommission();
}

module.exports = { getRateBps, getCommission, setRateBps };
