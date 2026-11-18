const { db } = require('../../config/postgres');
const AppError = require('../../utils/AppError');
const { formatNaira } = require('../../utils/money');
const accountRepository = require('./account.repository');
const ledgerRepository = require('./ledger.repository');
const walletProvisioning = require('./walletProvisioning.service');

/**
 * The caller's wallet. Normally created at signup; if provisioning is still pending (see the
 * consistency notes in the README) it is created here on first use, which is safe because
 * creation is idempotent.
 */
async function requireAccount(userId) {
  let account = await accountRepository.findUserAccount(userId);
  if (!account) {
    await walletProvisioning.provision(userId);
    account = await accountRepository.findUserAccount(userId);
  }
  if (!account) throw AppError.notFound('Wallet not found', 'WALLET_NOT_FOUND');
  return account;
}

async function getWallet(userId) {
  const account = await requireAccount(userId);
  return {
    id: account.id,
    currency: account.currency,
    balanceKobo: account.balanceKobo,
    balanceDisplay: formatNaira(account.balanceKobo),
    status: account.status,
  };
}

async function listTransactions(userId, { limit, cursor, type, direction }) {
  const account = await requireAccount(userId);
  // One extra row tells us whether another page exists.
  const rows = await ledgerRepository.listEntriesForAccount(db, account.id, {
    limit: limit + 1,
    cursor,
    type,
    direction,
  });
  const page = rows.slice(0, limit);
  return {
    transactions: page,
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
  };
}

module.exports = { getWallet, listTransactions };
