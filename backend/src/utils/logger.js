const pino = require('pino');
const config = require('../config');

// Anything matching these paths is replaced with [REDACTED] in every log line.
// Passwords, tokens and secrets must never reach the logs.
const redact = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-paystack-signature"]',
    'req.body.password',
    'req.body.newPassword',
    'req.body.token',
    'req.body.refreshToken',
    '*.password',
    '*.passwordHash',
    '*.token',
    '*.accessToken',
    '*.refreshToken',
    '*.secret',
  ],
  censor: '[REDACTED]',
};

const logger = pino({
  level: config.logLevel,
  redact,
  base: { service: 'kobomarket-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(config.isProd || config.isTest
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } }),
});

module.exports = logger;
