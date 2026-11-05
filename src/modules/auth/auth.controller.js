const asyncHandler = require('../../utils/asyncHandler');
const authService = require('./auth.service');

// Controllers only translate HTTP <-> service calls. No business logic lives here.
const clientInfo = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

const register = asyncHandler(async (req, res) => {
  const user = await authService.register(req.body);
  res.status(201).json({
    success: true,
    data: { user, message: 'Account created. Check your email for the verification token.' },
  });
});

const verifyEmail = asyncHandler(async (req, res) => {
  await authService.verifyEmail(req.body.token);
  res.json({ success: true, data: { message: 'Email verified. You can now log in.' } });
});

const resendVerification = asyncHandler(async (req, res) => {
  await authService.resendVerification(req.body.email);
  res.json({
    success: true,
    data: { message: 'If that account exists and is unverified, a new email has been sent.' },
  });
});

const login = asyncHandler(async (req, res) => {
  const session = await authService.login(req.body, clientInfo(req));
  res.json({ success: true, data: session });
});

const refresh = asyncHandler(async (req, res) => {
  const session = await authService.refresh(req.body.refreshToken, clientInfo(req));
  res.json({ success: true, data: session });
});

const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.body.refreshToken);
  res.json({ success: true, data: { message: 'Logged out' } });
});

const forgotPassword = asyncHandler(async (req, res) => {
  await authService.forgotPassword(req.body.email);
  res.json({
    success: true,
    data: { message: 'If that account exists, a password reset email has been sent.' },
  });
});

const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body.token, req.body.newPassword);
  res.json({ success: true, data: { message: 'Password updated. Please log in again.' } });
});

module.exports = { register, verifyEmail, resendVerification, login, refresh, logout, forgotPassword, resetPassword };
