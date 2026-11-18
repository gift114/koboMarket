const { randomBytes } = require('crypto');
const { sign } = require('../signature');

/**
 * A stand-in for Paystack that behaves the same way: initialise returns a checkout URL, verify
 * reports the real state of the transaction, and webhooks are signed with HMAC SHA512 and can
 * be delivered more than once. Only used when PAYMENT_PROVIDER=mock is explicitly selected.
 *
 * Its transactions live in memory: restarting the API forgets them (a verify then says
 * "not_found"). That is fine for development and the demo.
 */
class MockProvider {
  constructor({ secret, appBaseUrl }) {
    this.name = 'mock';
    this.secret = secret;
    this.appBaseUrl = appBaseUrl;
    this.transactions = new Map();
    this.nextId = 1000;
    // Payouts ("transfers"). Same reference -> same transfer, like a real provider.
    this.transfers = new Map();
    this.transferOutcome = 'success'; // what the next NEW transfer does: success | failed | pending | error
  }

  /** Send money to a bank account. Idempotent on `reference`. */
  async transfer({ reference, amountKobo, bank }) {
    const existing = this.transfers.get(reference);
    if (existing) return { status: existing.status, providerReference: existing.providerReference, reason: existing.reason };
    if (this.transferOutcome === 'error') throw new Error('Mock provider is unreachable');
    const failedByAccount = bank && bank.accountNumber === '0000000000';
    const status = failedByAccount ? 'failed' : this.transferOutcome;
    const record = {
      status,
      reference,
      amountKobo,
      bank,
      providerReference: `mock_tr_${(this.nextId += 1)}`,
      reason: status === 'failed' ? 'Account could not be verified by the bank' : null,
    };
    this.transfers.set(reference, record);
    return { status: record.status, providerReference: record.providerReference, reason: record.reason };
  }

  async verifyTransfer(reference) {
    const t = this.transfers.get(reference);
    if (!t) return { status: 'not_found' };
    return { status: t.status, providerReference: t.providerReference, reason: t.reason };
  }

  /** Test/demo hook: a pending transfer finishes at the bank. */
  settleTransfer(reference, status) {
    const t = this.transfers.get(reference);
    if (!t) throw new Error(`Unknown mock transfer ${reference}`);
    t.status = status;
    if (status === 'failed') t.reason = 'Rejected by the receiving bank';
  }

  async initializeTransaction({ reference, amountKobo, email }) {
    this.transactions.set(reference, { reference, amountKobo, email, currency: 'NGN', status: 'pending', id: (this.nextId += 1) });
    return {
      authorizationUrl: `${this.appBaseUrl}/api/v1/dev/mock-payments/${reference}`,
      accessCode: `mock_${randomBytes(6).toString('hex')}`,
    };
  }

  async verifyTransaction(reference) {
    const t = this.transactions.get(reference);
    if (!t) return { status: 'not_found' };
    return {
      status: t.status,
      reference,
      amountKobo: t.amountKobo,
      currency: t.currency,
      paidAt: t.paidAt || null,
    };
  }

  // ---- the "customer's side" of the gateway, used by the dev endpoint and by tests ----

  /** The customer pays (optionally a different amount than asked, to test mismatch handling). */
  markPaid(reference, { amountKobo } = {}) {
    const t = this.transactions.get(reference);
    if (!t) throw new Error(`Unknown mock transaction ${reference}`);
    t.status = 'success';
    t.paidAt = new Date().toISOString();
    if (amountKobo !== undefined) t.amountKobo = amountKobo;
    return t;
  }

  markFailed(reference) {
    const t = this.transactions.get(reference);
    if (!t) throw new Error(`Unknown mock transaction ${reference}`);
    t.status = 'failed';
    return t;
  }

  /** A signed webhook exactly as Paystack would send it: { rawBody, signature }. */
  buildWebhook(reference, event = 'charge.success') {
    const t = this.transactions.get(reference);
    if (!t) throw new Error(`Unknown mock transaction ${reference}`);
    const rawBody = Buffer.from(
      JSON.stringify({
        event,
        data: {
          id: t.id,
          domain: 'test',
          status: t.status,
          reference,
          amount: t.amountKobo,
          currency: t.currency,
          paid_at: t.paidAt || null,
          customer: { email: t.email },
        },
      }),
    );
    return { rawBody, signature: sign(rawBody, this.secret) };
  }
}

module.exports = MockProvider;
