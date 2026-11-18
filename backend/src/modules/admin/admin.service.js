const AppError = require('../../utils/AppError');
const userRepository = require('../users/user.repository');
const walletService = require('../wallet/wallet.service');
const commissionService = require('../orders/commission.service');

/** What an admin may see about a user (never the hash or token version). */
const toAdminUserView = (u) => ({
  id: u.id,
  email: u.email,
  fullName: u.fullName,
  phone: u.phone,
  roles: u.roles,
  status: u.status,
  emailVerified: u.emailVerified,
  walletStatus: u.walletStatus,
  createdAt: u.createdAt,
});

async function listUsers({ q, role, status, limit, cursor }) {
  const rows = await userRepository.search({ q, role, status, limit: limit + 1, cursor });
  const page = rows.slice(0, limit);
  return { users: page.map(toAdminUserView), nextCursor: rows.length > limit ? page[page.length - 1].id : null };
}

async function requireUser(id) {
  const user = await userRepository.findById(id);
  if (!user) throw AppError.notFound('User not found', 'USER_NOT_FOUND');
  return user;
}

/**
 * Freeze or unfreeze. Frozen users can still log in and read, but cannot place orders or request
 * payouts. Idempotent. Admins cannot be frozen (so nobody can lock the platform out of its own
 * admin tools), and nobody can freeze themselves.
 */
async function setFrozen(admin, userId, frozen) {
  const user = await requireUser(userId);
  if (frozen && user.id === admin.id) throw AppError.conflict('You cannot freeze your own account', 'CANNOT_FREEZE_SELF');
  if (frozen && user.roles.includes('admin')) throw AppError.conflict('An admin account cannot be frozen', 'CANNOT_FREEZE_ADMIN');
  const status = frozen ? 'frozen' : 'active';
  if (user.status === status) return toAdminUserView(user);
  return toAdminUserView(await userRepository.setStatus(userId, status));
}

/** Any user's wallet (balance and status). */
async function getWallet(userId) {
  await requireUser(userId);
  return walletService.getWallet(userId);
}

/** Any user's ledger history, newest first, with the running balance after each entry. */
async function getLedger(userId, query) {
  await requireUser(userId);
  return walletService.listTransactions(userId, query);
}

module.exports = { listUsers, setFrozen, getWallet, getLedger, getCommission: commissionService.getCommission, setCommission: (admin, rateBps) => commissionService.setRateBps(admin, rateBps), toAdminUserView };
