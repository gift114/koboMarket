const config = require('../../config');
const logger = require('../../utils/logger');
const AppError = require('../../utils/AppError');
const { sha256, randomToken, hashPassword, verifyPassword, verifyAgainstDummy } = require('../../utils/crypto');
const { sendMail, verificationEmail, passwordResetEmail } = require('../../utils/mailer');
const userRepository = require('../users/user.repository');
const { toPublicUser } = require('../users/user.mapper');
const refreshTokenRepository = require('./refreshToken.repository');
const authTokenRepository = require('./authToken.repository');
const loginAttemptRepository = require('./loginAttempt.repository');
const tokenService = require('./token.service');

const EMAIL_VERIFICATION = 'email_verification';
const PASSWORD_RESET = 'password_reset';
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const invalidRefresh = () => AppError.unauthorized('Invalid refresh token', 'INVALID_REFRESH_TOKEN');

// ---------------------------------------------------------------- helpers

async function issueOneTimeToken(user, type, ttlMs) {
  const now = new Date();
  await authTokenRepository.invalidateOutstanding(user.id, type, now);
  const raw = randomToken();
  await authTokenRepository.create({
    userId: user.id,
    type,
    tokenHash: sha256(raw),
    expiresAt: new Date(now.getTime() + ttlMs),
  });
  return raw;
}

async function sendVerification(user) {
  const ttlHours = config.auth.emailVerificationTtlHours;
  const raw = await issueOneTimeToken(user, EMAIL_VERIFICATION, ttlHours * HOUR_MS);
  await sendMail({ to: user.email, ...verificationEmail(raw, ttlHours) });
}

/**
 * Logs the user out everywhere. tokenVersion is bumped FIRST (killing every access token),
 * then all refresh tokens are revoked. The order matters: see the post-check in refresh().
 */
async function terminateAllSessions(userId) {
  await userRepository.bumpTokenVersion(userId);
  await refreshTokenRepository.revokeAllForUser(userId, new Date());
}

const loginKey = (email, ip) => sha256(`${email}|${ip}`);

// ---------------------------------------------------------------- register / verify

async function register({ email, password, fullName, phone }) {
  if (await userRepository.findByEmail(email)) {
    throw AppError.conflict('An account with this email already exists', 'EMAIL_ALREADY_REGISTERED');
  }

  const passwordHash = await hashPassword(password);
  let user;
  try {
    user = await userRepository.create({ email, passwordHash, fullName, phone, roles: ['buyer'] });
  } catch (err) {
    // Two registrations with the same email at the same instant: the unique index decides.
    if (err.code === 11000) {
      throw AppError.conflict('An account with this email already exists', 'EMAIL_ALREADY_REGISTERED');
    }
    throw err;
  }

  // A mail failure must not undo the registration; the user can ask for a new email.
  try {
    await sendVerification(user);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'Failed to send verification email');
  }

  return toPublicUser(user);
}

async function verifyEmail(rawToken) {
  const claimed = await authTokenRepository.claim(EMAIL_VERIFICATION, sha256(rawToken), new Date());
  if (!claimed) {
    throw new AppError(400, 'INVALID_OR_EXPIRED_TOKEN', 'This verification token is invalid or has expired');
  }
  await userRepository.markEmailVerified(claimed.userId);
}

// Same answer whether or not the account exists, so emails cannot be enumerated.
async function resendVerification(email) {
  const user = await userRepository.findByEmail(email);
  if (user && !user.emailVerified) {
    try {
      await sendVerification(user);
    } catch (err) {
      logger.error({ err, userId: user.id }, 'Failed to send verification email');
    }
  }
}

// ---------------------------------------------------------------- login / refresh / logout

async function login({ email, password }, { ip, userAgent }) {
  const now = new Date();
  const key = loginKey(email, ip);
  const windowMs = config.auth.loginWindowMinutes * MINUTE_MS;

  // 1. Locked out? Checked BEFORE the password, so a locked attacker learns nothing more.
  const active = await loginAttemptRepository.getActive(key, now);
  if (active && active.count >= config.auth.loginMaxFailedAttempts) {
    const retryAfter = Math.max(1, Math.ceil((active.expiresAt.getTime() - now.getTime()) / 1000));
    throw AppError.tooManyRequests(
      'Too many failed login attempts. Try again later.',
      'TOO_MANY_LOGIN_ATTEMPTS',
      retryAfter,
    );
  }

  // 2. Check the credentials. Unknown email and wrong password look identical.
  const user = await userRepository.findByEmail(email, { withPassword: true });
  const passwordOk = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user) await verifyAgainstDummy(password);

  if (!passwordOk) {
    await loginAttemptRepository.recordFailure(key, windowMs, now);
    throw AppError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }

  await loginAttemptRepository.clear(key);

  // 3. Correct password but unverified email: no tokens.
  if (!user.emailVerified) {
    throw AppError.forbidden('Verify your email address before logging in', 'EMAIL_NOT_VERIFIED');
  }

  const session = await tokenService.issueSession(user, { ip, userAgent });
  return { ...stripFamily(session), user: toPublicUser(user) };
}

function stripFamily({ familyId, ...rest }) {
  return rest;
}

/**
 * Rotate a refresh token. The old one is consumed atomically, so it works exactly once.
 * Presenting a token that was already used means it was stolen or replayed: every session
 * of that user is terminated.
 */
async function refresh(rawToken, { ip, userAgent }) {
  const now = new Date();
  const tokenHash = sha256(rawToken);

  const claimed = await refreshTokenRepository.claim(tokenHash, now);

  if (!claimed) {
    const existing = await refreshTokenRepository.findByHash(tokenHash);
    if (!existing) throw invalidRefresh();

    if (existing.usedAt) {
      await terminateAllSessions(existing.userId);
      logger.warn({ userId: existing.userId }, 'Refresh token reuse detected: all sessions revoked');
      throw AppError.unauthorized(
        'Refresh token reuse detected. All sessions have been logged out.',
        'REFRESH_TOKEN_REUSED',
      );
    }
    if (existing.revokedAt) throw invalidRefresh();
    throw AppError.unauthorized('Refresh token has expired', 'REFRESH_TOKEN_EXPIRED');
  }

  const user = await userRepository.findById(claimed.userId);
  if (!user) throw invalidRefresh();

  const session = await tokenService.issueSession(user, { familyId: claimed.familyId, ip, userAgent });

  // Race guard. If a replay of this same token terminated all sessions between our claim and
  // the insert above, the new token missed the revocation sweep. tokenVersion is bumped before
  // that sweep, so a changed version here means we must undo our own session.
  const fresh = await userRepository.findById(user.id);
  if (!fresh || fresh.tokenVersion !== user.tokenVersion) {
    await refreshTokenRepository.revokeFamily(claimed.familyId, new Date());
    throw AppError.unauthorized(
      'Refresh token reuse detected. All sessions have been logged out.',
      'REFRESH_TOKEN_REUSED',
    );
  }

  return stripFamily(session);
}

// Idempotent: logging out with an unknown or already-revoked token is not an error.
async function logout(rawToken) {
  const existing = await refreshTokenRepository.findByHash(sha256(rawToken));
  if (existing) await refreshTokenRepository.revokeFamily(existing.familyId, new Date());
}

// ---------------------------------------------------------------- password reset

async function forgotPassword(email) {
  const user = await userRepository.findByEmail(email);
  if (!user) return; // identical response either way

  try {
    const ttlMinutes = config.auth.passwordResetTtlMinutes;
    const raw = await issueOneTimeToken(user, PASSWORD_RESET, ttlMinutes * MINUTE_MS);
    await sendMail({ to: user.email, ...passwordResetEmail(raw, ttlMinutes) });
  } catch (err) {
    logger.error({ err, userId: user.id }, 'Failed to send password reset email');
  }
}

async function resetPassword(rawToken, newPassword) {
  const claimed = await authTokenRepository.claim(PASSWORD_RESET, sha256(rawToken), new Date());
  if (!claimed) {
    throw new AppError(400, 'INVALID_OR_EXPIRED_TOKEN', 'This reset token is invalid or has expired');
  }

  const passwordHash = await hashPassword(newPassword);
  await userRepository.setPassword(claimed.userId, passwordHash); // also bumps tokenVersion
  await refreshTokenRepository.revokeAllForUser(claimed.userId, new Date());
}

module.exports = {
  register,
  verifyEmail,
  resendVerification,
  login,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
};
