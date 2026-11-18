const { DIRECTION, SYSTEM_ACCOUNT, TRANSACTION_TYPE } = require('../../db/constants');
const accountRepository = require('../wallet/account.repository');
const ledgerService = require('../wallet/ledger.service');

/**
 * The two ways money leaves PLATFORM_ESCROW. Both run inside the caller's PostgreSQL
 * transaction (`trx`), so the ledger posting and the sub-order status change commit together
 * or not at all. Neither touches sub_orders itself: the caller updates the status and sets
 * escrow_held_kobo to 0 in the same transaction, which keeps that column equal to what the
 * ledger says escrow holds (the audit checks this).
 */

/** Commission on `amountKobo` at `rateBps` basis points, rounded DOWN to a whole kobo (BigInt: no float, no overflow). */
function commissionFor(amountKobo, rateBps) {
  return Number((BigInt(amountKobo) * BigInt(rateBps)) / 10000n);
}

/**
 * The general case: split the held escrow between the buyer (refund) and the vendor (gross, from
 * which the commission is taken, at the sub-order's recorded rate, on the vendor's part ONLY), as
 * ONE ledger transaction: debit ESCROW; credit buyer / vendor / PLATFORM_REVENUE. Legs of 0 are
 * left out. The two parts must add up to what is being settled.
 */
async function settleEscrow(trx, subOrder, { refundKobo = 0, vendorGrossKobo = 0, type, idempotencyKey, reference, metadata = {} }) {
  const totalKobo = refundKobo + vendorGrossKobo;
  const escrowId = await accountRepository.getSystemAccountId(SYSTEM_ACCOUNT.ESCROW, trx);
  const entries = [{ accountId: escrowId, direction: DIRECTION.DEBIT, amountKobo: totalKobo }];

  const commissionKobo = commissionFor(vendorGrossKobo, subOrder.commissionRateBps);
  const vendorKobo = vendorGrossKobo - commissionKobo;
  if (refundKobo > 0) {
    const buyerAccount = await accountRepository.createUserAccountIfMissing(subOrder.buyerId, trx);
    entries.push({ accountId: buyerAccount.id, direction: DIRECTION.CREDIT, amountKobo: refundKobo });
  }
  if (vendorKobo > 0) {
    const vendorAccount = await accountRepository.createUserAccountIfMissing(subOrder.vendorUserId, trx);
    entries.push({ accountId: vendorAccount.id, direction: DIRECTION.CREDIT, amountKobo: vendorKobo });
  }
  if (commissionKobo > 0) {
    const revenueId = await accountRepository.getSystemAccountId(SYSTEM_ACCOUNT.REVENUE, trx);
    entries.push({ accountId: revenueId, direction: DIRECTION.CREDIT, amountKobo: commissionKobo });
  }

  const { transaction } = await ledgerService.postTransaction({
    trx,
    type,
    idempotencyKey,
    reference,
    entries,
    metadata: { ...metadata, subOrderId: subOrder.id, refundKobo, vendorGrossKobo, commissionKobo, vendorKobo, commissionRateBps: subOrder.commissionRateBps },
  });
  return { transactionId: transaction.id, commissionKobo, vendorKobo, refundKobo };
}

/**
 * Pay the vendor in full: ESCROW -> vendor wallet (amount minus commission) and ESCROW ->
 * PLATFORM_REVENUE (commission), as ONE three-leg transaction. The vendor gets any rounding
 * remainder. Idempotent on `release:<subOrderId>`: calling twice never pays twice.
 */
function releaseToVendor(trx, subOrder, amountKobo = subOrder.escrowHeldKobo) {
  return settleEscrow(trx, subOrder, {
    vendorGrossKobo: amountKobo,
    type: TRANSACTION_TYPE.ESCROW_RELEASE,
    idempotencyKey: `release:${subOrder.id}`,
    reference: `RELEASE-${subOrder.id}`,
    metadata: { description: 'Escrow released to vendor' },
  });
}

/** Refund the buyer: ESCROW -> buyer wallet. Idempotent on `refund:<subOrderId>`. */
async function refundToBuyer(trx, subOrder, amountKobo = subOrder.escrowHeldKobo) {
  const escrowId = await accountRepository.getSystemAccountId(SYSTEM_ACCOUNT.ESCROW, trx);
  const buyerAccount = await accountRepository.createUserAccountIfMissing(subOrder.buyerId, trx);
  const { transaction } = await ledgerService.transfer({
    trx,
    fromAccountId: escrowId,
    toAccountId: buyerAccount.id,
    amountKobo,
    type: TRANSACTION_TYPE.ORDER_REFUND,
    idempotencyKey: `refund:${subOrder.id}`,
    reference: `REFUND-${subOrder.id}`,
    metadata: { description: 'Escrow refunded to buyer', subOrderId: subOrder.id },
  });
  return { transactionId: transaction.id };
}

module.exports = { settleEscrow, releaseToVendor, refundToBuyer, commissionFor };
