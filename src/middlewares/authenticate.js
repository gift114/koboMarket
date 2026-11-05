const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const tokenService = require('../modules/auth/token.service');
const userRepository = require('../modules/users/user.repository');

/**
 * Requires "Authorization: Bearer <access token>". Verifies the signature and expiry, then
 * loads the user so that roles, frozen status and tokenVersion are always current. A token
 * issued before a password reset or refresh-token reuse is rejected here immediately.
 * Sets req.user = { id, email, roles, status, emailVerified }.
 */
module.exports = asyncHandler(async (req, res, next) => {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw AppError.unauthorized('Missing bearer token', 'MISSING_TOKEN');
  }

  const payload = tokenService.verifyAccessToken(token);
  const user = await userRepository.findById(payload.sub);
  if (!user || user.tokenVersion !== payload.tv) {
    throw AppError.unauthorized('This session is no longer valid, please log in again', 'TOKEN_REVOKED');
  }

  req.user = {
    id: user.id,
    email: user.email,
    roles: user.roles,
    status: user.status,
    emailVerified: user.emailVerified,
  };
  next();
});
