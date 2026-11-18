const rateLimit = require('express-rate-limit');
const config = require('../config');

// Stricter per-IP limit for unauthenticated endpoints that send email or accept guessable
// secrets. (Login has its own failed-attempt limiter per email + IP in the auth service.)
const authLimiter = rateLimit({
  windowMs: config.rateLimit.windowMinutes * 60 * 1000,
  max: config.auth.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.isTest,
  handler: (req, res) =>
    res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests, try again later', details: null },
    }),
});

module.exports = { authLimiter };
