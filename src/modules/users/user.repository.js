const User = require('./user.model');

// Repositories are the only layer that talks to MongoDB. They return plain objects with a
// string `id`, so services never depend on Mongoose documents.
function toDomain(doc) {
  if (!doc) return null;
  const user = {
    id: String(doc._id),
    email: doc.email,
    fullName: doc.fullName,
    phone: doc.phone || null,
    roles: doc.roles,
    status: doc.status,
    emailVerified: doc.emailVerified,
    emailVerifiedAt: doc.emailVerifiedAt || null,
    tokenVersion: doc.tokenVersion,
    walletStatus: doc.walletStatus,
    walletAttempts: doc.walletAttempts,
    walletNextAttemptAt: doc.walletNextAttemptAt,
    createdAt: doc.createdAt,
  };
  if (doc.passwordHash !== undefined) user.passwordHash = doc.passwordHash;
  return user;
}

async function findByEmail(email, { withPassword = false } = {}) {
  const query = User.findOne({ email });
  if (withPassword) query.select('+passwordHash');
  return toDomain(await query.lean());
}

async function findById(id) {
  return toDomain(await User.findById(id).lean());
}

async function create(data) {
  const doc = await User.create(data);
  const user = toDomain(doc.toObject());
  delete user.passwordHash; // same as every other read: the hash is only returned on request
  return user;
}

async function markEmailVerified(id) {
  await User.updateOne({ _id: id }, { $set: { emailVerified: true, emailVerifiedAt: new Date() } });
}

// Changing the password bumps tokenVersion so existing access tokens stop working at once.
async function setPassword(id, passwordHash) {
  await User.updateOne({ _id: id }, { $set: { passwordHash }, $inc: { tokenVersion: 1 } });
}

async function bumpTokenVersion(id) {
  await User.updateOne({ _id: id }, { $inc: { tokenVersion: 1 } });
}

async function updateProfile(id, patch) {
  return toDomain(await User.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true }).lean());
}

// $addToSet makes this idempotent: adding a role the user already has changes nothing.
async function addRole(id, role) {
  await User.updateOne({ _id: id }, { $addToSet: { roles: role } });
}

// ---- wallet provisioning state (see walletProvisioning.service.js) ----

async function markWalletReady(id) {
  await User.updateOne({ _id: id }, { $set: { walletStatus: 'ready' } });
}

/** Counts one more failed attempt and returns the new total. */
async function incrementWalletAttempts(id) {
  const doc = await User.findByIdAndUpdate(id, { $inc: { walletAttempts: 1 } }, { returnDocument: 'after' }).lean();
  return doc ? doc.walletAttempts : 0;
}

async function scheduleWalletRetry(id, nextAttemptAt) {
  await User.updateOne({ _id: id }, { $set: { walletNextAttemptAt: nextAttemptAt } });
}

/**
 * Take up to `limit` users whose wallet is still pending and due. Each one is "leased" by
 * pushing its next-attempt time forward, in one atomic update, so two job runs (or two API
 * instances) never work on the same user at once. If the worker dies, the lease simply
 * expires and the user is picked up again.
 */
async function claimPendingWalletUsers(now, limit, leaseMs) {
  const ids = [];
  for (let i = 0; i < limit; i += 1) {
    const doc = await User.findOneAndUpdate(
      { walletStatus: 'pending', walletNextAttemptAt: { $lte: now } },
      { $set: { walletNextAttemptAt: new Date(now.getTime() + leaseMs) } },
      { returnDocument: 'after', projection: { _id: 1 } },
    ).lean();
    if (!doc) break;
    ids.push(String(doc._id));
  }
  return ids;
}

module.exports = {
  findByEmail,
  findById,
  create,
  markEmailVerified,
  setPassword,
  bumpTokenVersion,
  updateProfile,
  addRole,
  markWalletReady,
  incrementWalletAttempts,
  scheduleWalletRetry,
  claimPendingWalletUsers,
};
