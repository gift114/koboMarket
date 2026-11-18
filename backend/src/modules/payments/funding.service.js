const { randomUUID } = require('crypto');
const { db } = require('../../config/postgres');
const config = require('../../config');
const AppError = require('../../utils/AppError');
const logger = require('../../utils/logger');
const { formatNaira } = require('../../utils/money');
const { DIRECTION, SYSTEM_ACCOUNT, TRANSACTION_TYPE } = require('../../db/constants');
const accountRepository = require('../wallet/account.repository');
const ledgerService = require('../wallet/ledger.service');
const paymentRepository = require('./payment.repository');
const { getProvider } = require('./providers');

const toView = (p) => ({
  id: p.id,
  reference: p.reference,
  amountKobo: p.amountKobo,
  amountDisplay: formatNaira(p.amountKobo),
  currency: p.currency,
  status: p.status,
  authorizationUrl: p.authorizationUrl,
  failureReason: p.failureReason,
  paidAt: p.paidAt,
  createdAt: p.createdAt,
});

/**
 * Start a top-up: record a PENDING payment, ask the provider for a checkout URL, return it.
 * NO money moves here. The wallet is credited only when the provider confirms payment
 * (webhook, or the status endpoint below), and only after we verify it ourselves.
 */
async function initiate(user, { amountKobo }) {
  const provider = getProvider();
  const reference = `KM-${randomUUID()}`;
  const payment = await paymentRepository.insert({ userId: user.id, reference, provider: provider.name, amountKobo });

  try {
    const { authorizationUrl } = await provider.initializeTransaction({
      reference,
      amountKobo,
      email: user.email,
      callbackUrl: `${config.appBaseUrl}/api/v1/wallet/fund/${reference}`,
    });
    await paymentRepository.setAuthorizationUrl(reference, authorizationUrl);
    return toView({ ...payment, authorizationUrl });
  } catch (err) {
    await paymentRepository.markFailed(reference, 'PROVIDER_INIT_FAILED').catch(() => {});
    throw err;
  }
}

/**
 * Credit the wallet for a payment, exactly once. Called for webhooks and for the status check.
 *
 * Defence in depth, three independent layers, so a duplicate can never pay twice:
 *   1. the payment row is locked FOR UPDATE and only a PENDING one is credited;
 *   2. the ledger transaction has the idempotency key "fund:<reference>" (UNIQUE);
 *   3. payments.ledger_transaction_id is UNIQUE and status can never leave SUCCEEDED (trigger).
 *
 * The webhook body is NOT trusted: we ask the provider's verify endpoint what really happened
 * and compare the amount to what we asked for. That call is made BEFORE the database
 * transaction, so no row lock is held while waiting on the network.
 *
 * Returns a short outcome string (logged and stored with the webhook event).
 */
async function settleByReference(reference) {
  const payment = await paymentRepository.findByReference(reference);
  if (!payment) return 'unknown_payment';
  if (payment.status === 'SUCCEEDED') return 'already_credited';
  if (payment.status === 'FAILED') return 'payment_failed';

  const verified = await getProvider().verifyTransaction(reference);
  if (verified.status !== 'success') return 'not_successful';

  if (verified.amountKobo !== payment.amountKobo || verified.currency !== payment.currency) {
    logger.error(
      { reference, expectedKobo: payment.amountKobo, paidKobo: verified.amountKobo, currency: verified.currency },
      'Payment amount does not match what was requested: NOT crediting, needs manual review',
    );
    await paymentRepository.markFailed(reference, 'AMOUNT_MISMATCH');
    return 'amount_mismatch';
  }

  try {
    return await db.transaction(async (trx) => {
      const locked = await paymentRepository.lockByReference(trx, reference);
      if (locked.status !== 'PENDING') return 'already_credited';

      const account = await accountRepository.createUserAccountIfMissing(locked.userId, trx);
      const externalId = await accountRepository.getSystemAccountId(SYSTEM_ACCOUNT.EXTERNAL, trx);

      const { transaction } = await ledgerService.postTransaction({
        trx,
        type: TRANSACTION_TYPE.WALLET_FUNDING,
        reference: `FUND-${reference}`,
        idempotencyKey: `fund:${reference}`,
        entries: [
          { accountId: externalId, direction: DIRECTION.DEBIT, amountKobo: locked.amountKobo },
          { accountId: account.id, direction: DIRECTION.CREDIT, amountKobo: locked.amountKobo },
        ],
        metadata: { description: 'Wallet top-up', paymentReference: reference, provider: locked.provider },
      });
      await paymentRepository.markSucceeded(trx, locked.id, transaction.id);
      return 'credited';
    });
  } catch (err) {
    if (err instanceof AppError && err.code === 'ACCOUNT_NOT_ACTIVE') {
      // The customer paid but their wallet is frozen. Do not make the provider retry forever:
      // the payment stays PENDING and is credited by the status check once the wallet is active.
      logger.error({ reference }, 'Paid, but the wallet is not active: payment left PENDING');
      return 'account_not_active';
    }
    throw err;
  }
}

/** Status of one of MY payments. If it is still pending, ask the provider (webhook fallback). */
async function getStatus(userId, reference) {
  let payment = await paymentRepository.findByReference(reference);
  if (!payment || payment.userId !== userId) throw AppError.notFound('Payment not found', 'PAYMENT_NOT_FOUND');

  if (payment.status === 'PENDING') {
    try {
      await settleByReference(reference);
    } catch (err) {
      logger.warn({ err: err.message, reference }, 'Could not check the payment with the provider right now');
    }
    payment = await paymentRepository.findByReference(reference);
  }
  return toView(payment);
}

module.exports = { initiate, settleByReference, getStatus };
