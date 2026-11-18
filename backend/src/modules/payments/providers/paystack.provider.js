const AppError = require('../../../utils/AppError');
const logger = require('../../../utils/logger');

/**
 * Paystack (test or live) over HTTPS. Amounts are integer kobo, exactly what Paystack's API
 * uses, so no conversion can introduce a rounding error. The secret key is only ever sent in
 * the Authorization header and never logged.
 */
/** Paystack transfer states -> success | failed | pending (anything not final stays pending). */
function normaliseTransferStatus(status) {
  if (status === 'success') return 'success';
  if (['failed', 'reversed', 'rejected', 'blocked', 'abandoned'].includes(status)) return 'failed';
  return 'pending';
}

class PaystackProvider {
  constructor({ secretKey, baseUrl, timeoutMs = 10000, fetchImpl = fetch }) {
    this.name = 'paystack';
    this.secret = secretKey; // also the webhook signing key
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async request(method, path, body) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      logger.error({ err: err.message, path }, 'Paystack request failed');
      throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider is unreachable, please try again');
    }
    const json = await response.json().catch(() => null);
    return { status: response.status, json };
  }

  async initializeTransaction({ reference, amountKobo, email, callbackUrl }) {
    const { status, json } = await this.request('POST', '/transaction/initialize', {
      email,
      amount: amountKobo,
      currency: 'NGN',
      reference,
      callback_url: callbackUrl,
    });
    if (status !== 200 || !json || json.status !== true || !json.data || !json.data.authorization_url) {
      logger.error({ status, message: json && json.message }, 'Paystack initialize was rejected');
      throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider could not start the payment');
    }
    return { authorizationUrl: json.data.authorization_url, accessCode: json.data.access_code };
  }

  async verifyTransaction(reference) {
    const { status, json } = await this.request('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    if (status === 404 || (status === 400 && json && /not found/i.test(json.message || ''))) {
      return { status: 'not_found' };
    }
    if (status !== 200 || !json || json.status !== true || !json.data) {
      logger.error({ status, message: json && json.message }, 'Paystack verify failed');
      throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider could not verify the payment');
    }
    const d = json.data;
    return {
      status: d.status, // success | failed | abandoned | ongoing | pending | ...
      reference: d.reference,
      amountKobo: d.amount,
      currency: d.currency,
      paidAt: d.paid_at || null,
    };
  }

  /** Paystack needs a bank CODE; vendors store the bank NAME, so look it up (and cache the list). */
  async resolveBankCode(bankName) {
    if (!this.banks) {
      const { status, json } = await this.request('GET', '/bank?country=nigeria&perPage=200');
      if (status !== 200 || !json || !Array.isArray(json.data)) {
        throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider could not list banks');
      }
      this.banks = json.data;
    }
    const wanted = String(bankName).trim().toLowerCase();
    const bank = this.banks.find((b) => b.name.toLowerCase() === wanted) || this.banks.find((b) => b.name.toLowerCase().includes(wanted) || wanted.includes(b.name.toLowerCase()));
    return bank ? bank.code : null;
  }

  /**
   * Pay out to a bank account. Idempotent on `reference` (Paystack refuses a reused reference, so
   * the payout job always calls verifyTransfer first). A definite refusal (4xx) is returned as
   * status "failed"; a network error or 5xx THROWS, because the transfer may or may not have
   * happened and must be retried, not given up.
   */
  async transfer({ reference, amountKobo, bank }) {
    const code = await this.resolveBankCode(bank.bankName);
    if (!code) return { status: 'failed', reason: `Unknown bank "${bank.bankName}"` };

    const recipient = await this.request('POST', '/transferrecipient', {
      type: 'nuban',
      name: bank.accountName,
      account_number: bank.accountNumber,
      bank_code: code,
      currency: 'NGN',
    });
    if (recipient.status >= 500) throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider is unavailable');
    if (recipient.status !== 200 && recipient.status !== 201) {
      return { status: 'failed', reason: (recipient.json && recipient.json.message) || 'The bank account was rejected' };
    }

    const res = await this.request('POST', '/transfer', {
      source: 'balance',
      amount: amountKobo,
      recipient: recipient.json.data.recipient_code,
      reason: 'KoboMarket payout',
      reference,
    });
    if (res.status >= 500) throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider is unavailable');
    if (res.status !== 200 && res.status !== 201) {
      return { status: 'failed', reason: (res.json && res.json.message) || 'The transfer was rejected' };
    }
    return { status: normaliseTransferStatus(res.json.data.status), providerReference: res.json.data.transfer_code, reason: null };
  }

  async verifyTransfer(reference) {
    const { status, json } = await this.request('GET', `/transfer/verify/${encodeURIComponent(reference)}`);
    if (status === 404 || (status === 400 && json && /not found/i.test(json.message || ''))) return { status: 'not_found' };
    if (status !== 200 || !json || json.status !== true || !json.data) {
      throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider could not verify the transfer');
    }
    return {
      status: normaliseTransferStatus(json.data.status),
      providerReference: json.data.transfer_code,
      reason: json.data.reason || null,
    };
  }
}

module.exports = PaystackProvider;
