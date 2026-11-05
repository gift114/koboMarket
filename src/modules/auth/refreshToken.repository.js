const RefreshToken = require('./refreshToken.model');

function toDomain(doc) {
  if (!doc) return null;
  return {
    userId: String(doc.userId),
    familyId: doc.familyId,
    tokenHash: doc.tokenHash,
    expiresAt: doc.expiresAt,
    usedAt: doc.usedAt || null,
    revokedAt: doc.revokedAt || null,
  };
}

async function create({ userId, familyId, tokenHash, expiresAt, ip, userAgent }) {
  await RefreshToken.create({ userId, familyId, tokenHash, expiresAt, ip, userAgent });
}

async function findByHash(tokenHash) {
  return toDomain(await RefreshToken.findOne({ tokenHash }).lean());
}

/**
 * Atomically mark a token as used, but only if it is still valid (unused, not revoked, not
 * expired). Returns the token, or null if it could not be claimed. Two concurrent requests
 * with the same token can never both succeed, because only one update matches the filter.
 */
async function claim(tokenHash, now) {
  const doc = await RefreshToken.findOneAndUpdate(
    { tokenHash, usedAt: null, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { returnDocument: 'before' },
  ).lean();
  return toDomain(doc);
}

async function revokeFamily(familyId, now) {
  await RefreshToken.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: now } });
}

async function revokeAllForUser(userId, now) {
  await RefreshToken.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: now } });
}

module.exports = { create, findByHash, claim, revokeFamily, revokeAllForUser };
