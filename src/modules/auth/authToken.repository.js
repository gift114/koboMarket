const AuthToken = require('./authToken.model');

async function create({ userId, type, tokenHash, expiresAt }) {
  await AuthToken.create({ userId, type, tokenHash, expiresAt });
}

// Issuing a new token retires the older unused ones, so only the latest email works.
async function invalidateOutstanding(userId, type, now) {
  await AuthToken.updateMany({ userId, type, usedAt: null }, { $set: { usedAt: now } });
}

/**
 * Atomically consume a token: it must match the type and hash, be unused and unexpired.
 * Returns { userId } or null. Single use even under concurrent requests.
 */
async function claim(type, tokenHash, now) {
  const doc = await AuthToken.findOneAndUpdate(
    { type, tokenHash, usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { returnDocument: 'before' },
  ).lean();
  return doc ? { userId: String(doc.userId) } : null;
}

module.exports = { create, invalidateOutstanding, claim };
