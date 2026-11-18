const { randomUUID } = require('crypto');
const { db } = require('../../config/postgres');
const AppError = require('../../utils/AppError');
const { assertNotFrozen } = require('../../utils/guards');
const logger = require('../../utils/logger');
const config = require('../../config');
const { formatNaira } = require('../../utils/money');
const { SYSTEM_ACCOUNT, TRANSACTION_TYPE } = require('../../db/constants');
const accountRepository = require('../wallet/account.repository');
const ledgerService = require('../wallet/ledger.service');
const vendorRepository = require('../vendors/vendor.repository');
const { maskAccountNumber } = require('../vendors/vendor.mapper');
const { getProvider } = require('../payments/providers');
const { encodeCursor, decodeCursor } = require('../orders/orders.service');
const payoutRepository = require('./payout.repository');
const bus = require('../../events/bus');
const EVENTS = require('../../events/events');

/**
 * Vendor payouts (Module H).
 *
 *   request   one PostgreSQL transaction: vendor wallet -> PLATFORM_PAYOUT_CLEARING (ledger) and a
 *             PENDING payout row. The money leaves the wallet at once, so it cannot be spent twice.
 *   process   a background job asks the provider to send it. On success: CLEARING -> EXTERNAL and
 *             SUCCESS. On failure: CLEARING -> vendor wallet and FAILED (the vendor may retry).
 *
 * Safety:
 *   - overdraft: the ledger locks the wallet row before reading the balance, so two requests in
 *     the same millisecond cannot both spend it;
 *   - one PENDING payout per vendor: checked here and enforced by a partial unique index;
 *   - never pay twice: the job first asks the provider about our reference (verifyTransfer) and only
 *     sends if the provider has never heard of it, and the provider treats the reference as
 *     idempotent; settlement/reversal are guarded by a row lock, a status check and ledger keys;
 *   - never give up on an unknown outcome: a timeout or 5xx leaves the payout PENDING and the job
 *     retries it (a payout is only reversed when the provider says it FAILED).
 */

const toView = (p) => ({
  id: p.id,
  reference: p.reference,
  amountKobo: p.amountKobo,
  amountDisplay: formatNaira(p.amountKobo),
  status: p.status,
  bank: { bankName: p.bank.bankName, accountNumberMasked: maskAccountNumber(p.bank.accountNumber), accountName: p.bank.accountName },
  failureReason: p.failureReason,
  createdAt: p.createdAt,
  processedAt: p.processedAt,
});

/** Vendor: withdraw `amountKobo` from my wallet to my bank account. */
async function request(user, { amountKobo }) {
  assertNotFrozen(user);
  const min = config.business.payoutMinimumKobo;
  if (amountKobo < min) {
    throw AppError.validation(
      [{ path: 'amountKobo', message: `The minimum payout is ${formatNaira(min)}`, minimumKobo: min }],
      'Amount is below the minimum payout',
    );
  }
  const vendor = await vendorRepository.findByUserId(user.id);
  if (!vendor || vendor.status !== 'approved') {
    throw AppError.forbidden('Only an approved vendor can request a payout', 'VENDOR_NOT_APPROVED');
  }

  const id = randomUUID();
  try {
    const payout = await db.transaction(async (trx) => {
      if (await payoutRepository.findPendingForUser(trx, user.id)) throw pendingExists();
      const wallet = await accountRepository.createUserAccountIfMissing(user.id, trx);
      const clearingId = await accountRepository.getSystemAccountId(SYSTEM_ACCOUNT.PAYOUT_CLEARING, trx);
      // Locks the wallet and the clearing account, checks the balance, posts: INSUFFICIENT_FUNDS rolls everything back.
      const { transaction } = await ledgerService.transfer({
        trx,
        fromAccountId: wallet.id,
        toAccountId: clearingId,
        amountKobo,
        type: TRANSACTION_TYPE.PAYOUT_REQUEST,
        idempotencyKey: `payout-request:${id}`,
        reference: `PAYOUT-REQ-${id}`,
        metadata: { description: 'Payout requested', payoutId: id },
      });
      return payoutRepository.insert(trx, {
        id,
        userId: user.id,
        vendorId: vendor.id,
        reference: `payout-${id}`,
        amountKobo,
        bank: vendor.bankDetails,
        requestTransactionId: transaction.id,
      });
    });
    return toView(payout);
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'payouts_one_pending_per_user') throw pendingExists();
    throw err;
  }
}

const pendingExists = () =>
  AppError.conflict('You already have a payout in progress. Wait for it to finish before requesting another.', 'PAYOUT_PENDING_EXISTS');

async function getOne(user, payoutId) {
  const payout = await payoutRepository.findById(payoutId);
  if (!payout || (payout.userId !== user.id && !user.roles.includes('admin'))) {
    throw AppError.notFound('Payout not found', 'PAYOUT_NOT_FOUND');
  }
  return toView(payout);
}

async function listMine(user, { status, limit, cursor }) {
  const rows = await payoutRepository.listByUser(user.id, { status, limit: limit + 1, cursor: cursor ? decodeCursor(cursor) : null });
  const page = rows.slice(0, limit);
  return { payouts: page.map(toView), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null };
}

// ---- the background job -----------------------------------------------------------------------

/** CLEARING -> EXTERNAL; SUCCESS. A no-op if the payout is no longer PENDING (someone else finished it). */
async function settle(payoutId, provider) {
  const done = await db.transaction(async (trx) => {
    const locked = await payoutRepository.lockById(trx, payoutId);
    if (!locked || locked.status !== 'PENDING') return false;
    const clearingId = await accountRepository.getSystemAccountId(SYSTEM_ACCOUNT.PAYOUT_CLEARING, trx);
    const externalId = await accountRepository.getSystemAccountId(SYSTEM_ACCOUNT.EXTERNAL, trx);
    const { transaction } = await ledgerService.transfer({
      trx,
      fromAccountId: clearingId,
      toAccountId: externalId,
      amountKobo: locked.amountKobo,
      type: TRANSACTION_TYPE.PAYOUT_SETTLEMENT,
      idempotencyKey: `payout-settle:${payoutId}`,
      reference: `PAYOUT-OK-${payoutId}`,
      metadata: { description: 'Payout sent to bank', payoutId },
    });
    await payoutRepository.markSuccess(trx, payoutId, { settlementTransactionId: transaction.id, provider });
    return locked;
  });
  if (!done) return false;
  bus.publish(EVENTS.PAYOUT_SUCCESS, { payoutId: done.id, userId: done.userId, amountKobo: done.amountKobo });
  return true;
}

/** CLEARING -> vendor wallet; FAILED. The vendor gets the money back and may request again. */
async function fail(payoutId, provider, reason) {
  const done = await db.transaction(async (trx) => {
    const locked = await payoutRepository.lockById(trx, payoutId);
    if (!locked || locked.status !== 'PENDING') return false;
    const clearingId = await accountRepository.getSystemAccountId(SYSTEM_ACCOUNT.PAYOUT_CLEARING, trx);
    const wallet = await accountRepository.createUserAccountIfMissing(locked.userId, trx);
    const { transaction } = await ledgerService.transfer({
      trx,
      fromAccountId: clearingId,
      toAccountId: wallet.id,
      amountKobo: locked.amountKobo,
      type: TRANSACTION_TYPE.PAYOUT_REVERSAL,
      idempotencyKey: `payout-reverse:${payoutId}`,
      reference: `PAYOUT-REV-${payoutId}`,
      metadata: { description: 'Payout failed, returned to wallet', payoutId, reason },
    });
    await payoutRepository.markFailed(trx, payoutId, { reversalTransactionId: transaction.id, provider, reason: (reason || 'The transfer failed').slice(0, 300) });
    return locked;
  });
  if (!done) return false;
  bus.publish(EVENTS.PAYOUT_FAILED, { payoutId: done.id, userId: done.userId, amountKobo: done.amountKobo, reason });
  return true;
}

/** Take one claimed payout as far as the provider lets us. Returns 'success' | 'failed' | 'pending' | 'retry'. */
async function processOne(payout, provider) {
  let remote;
  try {
    remote = await provider.verifyTransfer(payout.reference);
    if (remote.status === 'not_found') {
      remote = await provider.transfer({ reference: payout.reference, amountKobo: payout.amountKobo, bank: payout.bank });
    }
  } catch (err) {
    // Unknown outcome (timeout, 5xx): the transfer may have happened. Do NOT reverse; try again later.
    logger.error({ err: err.message, payoutId: payout.id }, 'Payout provider call failed, will retry');
    return 'retry';
  }

  if (remote.status === 'success') {
    await settle(payout.id, provider.name);
    return 'success';
  }
  if (remote.status === 'failed') {
    await fail(payout.id, provider.name, remote.reason);
    return 'failed';
  }
  await payoutRepository.releaseClaim(payout.id); // still in flight at the bank: poll again next run
  return 'pending';
}

async function processPending() {
  const provider = getProvider();
  const batch = await payoutRepository.claimBatch(config.business.payoutBatchSize, config.business.payoutClaimLeaseSeconds);
  const summary = { claimed: batch.length, success: 0, failed: 0, pending: 0, retry: 0 };
  for (const payout of batch) {
    try {
      summary[await processOne(payout, provider)] += 1;
    } catch (err) {
      summary.retry += 1;
      logger.error({ err: err.message, payoutId: payout.id }, 'Could not finish a payout, will retry');
    }
  }
  return summary;
}

module.exports = { request, getOne, listMine, processPending, settle, fail }; // settle and fail are exported for tests
