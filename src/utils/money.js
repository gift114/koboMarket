/**
 * Money helpers. ALL money in this project is an integer number of kobo (N1 = 100 kobo).
 * Never use floats for money. These helpers refuse anything that is not a safe integer.
 */
const AppError = require('./AppError');

const BPS_DENOMINATOR = 10000;

function assertKobo(value, label = 'amount') {
  if (!Number.isSafeInteger(value)) {
    throw AppError.badRequest(`${label} must be an integer number of kobo`);
  }
  return value;
}

/**
 * Commission on an amount, in kobo, using integer basis points (500 = 5%).
 * Rounds DOWN so the vendor never loses a fraction of a kobo to rounding;
 * vendor share is always amount - commission, so the two parts always sum exactly.
 */
function commissionKobo(amountKobo, rateBps) {
  assertKobo(amountKobo, 'amountKobo');
  assertKobo(rateBps, 'rateBps');
  // BigInt avoids overflow on very large amounts; result fits back into a Number.
  return Number((BigInt(amountKobo) * BigInt(rateBps)) / BigInt(BPS_DENOMINATOR));
}

function splitCommission(amountKobo, rateBps) {
  const commission = commissionKobo(amountKobo, rateBps);
  return { commissionKobo: commission, vendorKobo: amountKobo - commission };
}

function nairaToKobo(naira) {
  // Accepts a string like "1500.50" to avoid float math. Used only for display input/seed data.
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(naira));
  if (!match) throw AppError.badRequest('Invalid naira amount');
  const whole = BigInt(match[1]) * 100n;
  const frac = BigInt((match[2] || '0').padEnd(2, '0'));
  return Number(whole + frac);
}

function formatNaira(kobo) {
  assertKobo(kobo, 'kobo');
  const sign = kobo < 0 ? '-' : '';
  const abs = Math.abs(kobo);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}N${whole}.${frac}`;
}

module.exports = { assertKobo, commissionKobo, splitCommission, nairaToKobo, formatNaira, BPS_DENOMINATOR };
