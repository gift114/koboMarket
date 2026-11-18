const { createHmac, timingSafeEqual } = require('crypto');

/** Paystack signs the RAW request body with HMAC SHA512 using the secret key; hex digest. */
const sign = (rawBody, secret) => createHmac('sha512', secret).update(rawBody).digest('hex');

/** Constant-time comparison, false for anything missing or malformed. */
function isValidSignature(rawBody, signature, secret) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{128}$/i.test(signature)) return false;
  const expected = Buffer.from(sign(rawBody, secret), 'hex');
  const received = Buffer.from(signature, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

module.exports = { sign, isValidSignature };
