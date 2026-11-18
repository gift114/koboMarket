const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const config = require('../../config');
const AppError = require('../../utils/AppError');
const { sha256, randomToken } = require('../../utils/crypto');
const refreshTokenRepository = require('./refreshToken.repository');

const ACCESS_TOKEN_SECONDS = config.auth.accessTtlMinutes * 60;
const REFRESH_TOKEN_MS = config.auth.refreshTtlDays * 24 * 60 * 60 * 1000;

// Access tokens are short-lived JWTs carrying only the user id and tokenVersion. Roles and
// status are read from the database on each request, so they are never stale.
function signAccessToken(user) {
  return jwt.sign({ sub: user.id, tv: user.tokenVersion }, config.auth.accessSecret, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TOKEN_SECONDS,
  });
}

function verifyAccessToken(token) {
  try {
    return jwt.verify(token, config.auth.accessSecret, { algorithms: ['HS256'] });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw AppError.unauthorized('Access token has expired', 'TOKEN_EXPIRED');
    }
    throw AppError.unauthorized('Invalid access token', 'INVALID_TOKEN');
  }
}

// Refresh tokens are opaque random strings. Only their SHA-256 is stored.
async function issueRefreshToken({ userId, familyId, ip, userAgent }) {
  const raw = randomToken(48);
  await refreshTokenRepository.create({
    userId,
    familyId,
    tokenHash: sha256(raw),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_MS),
    ip,
    userAgent: userAgent ? String(userAgent).slice(0, 300) : undefined,
  });
  return raw;
}

/** A new login starts a new family; a rotation keeps the family of the token it replaces. */
async function issueSession(user, { familyId = randomUUID(), ip, userAgent } = {}) {
  const refreshToken = await issueRefreshToken({ userId: user.id, familyId, ip, userAgent });
  return {
    accessToken: signAccessToken(user),
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: ACCESS_TOKEN_SECONDS,
    familyId,
  };
}

module.exports = { signAccessToken, verifyAccessToken, issueSession };
