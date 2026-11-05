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

module.exports = { findByEmail, findById, create, markEmailVerified, setPassword, bumpTokenVersion, updateProfile };
