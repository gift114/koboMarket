const { z } = require('zod');

const email = z.string().trim().toLowerCase().email('must be a valid email').max(254);

// bcrypt only uses the first 72 bytes, so longer passwords are refused rather than silently cut.
const newPassword = z
  .string()
  .min(8, 'must be at least 8 characters')
  .regex(/[A-Za-z]/, 'must contain a letter')
  .regex(/\d/, 'must contain a number')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'must be at most 72 bytes');

const token = z.string().min(16).max(256);

// .strict() everywhere: unknown fields (for example "roles") are rejected, not ignored.
const registerBody = z
  .object({
    email,
    password: newPassword,
    fullName: z.string().trim().min(2).max(100),
    phone: z.string().trim().regex(/^\+?[0-9]{7,15}$/, 'must be 7-15 digits, optional leading +').optional(),
  })
  .strict();

const verifyEmailBody = z.object({ token }).strict();
const resendVerificationBody = z.object({ email }).strict();
const loginBody = z.object({ email, password: z.string().min(1).max(200) }).strict();
const refreshBody = z.object({ refreshToken: token }).strict();
const logoutBody = z.object({ refreshToken: token }).strict();
const forgotPasswordBody = z.object({ email }).strict();
const resetPasswordBody = z.object({ token, newPassword }).strict();

module.exports = {
  registerBody,
  verifyEmailBody,
  resendVerificationBody,
  loginBody,
  refreshBody,
  logoutBody,
  forgotPasswordBody,
  resetPasswordBody,
};
