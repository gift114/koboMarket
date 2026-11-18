const config = require('../../../config');
const MockProvider = require('./mock.provider');
const PaystackProvider = require('./paystack.provider');

let provider;

/** The configured payment provider (PAYMENT_PROVIDER=paystack by default), created once. */
function getProvider() {
  if (!provider) {
    provider =
      config.payments.provider === 'paystack'
        ? new PaystackProvider({ secretKey: config.payments.paystackSecretKey, baseUrl: config.payments.paystackBaseUrl })
        : new MockProvider({ secret: config.payments.mockSecret, appBaseUrl: config.appBaseUrl });
  }
  return provider;
}

module.exports = { getProvider };
