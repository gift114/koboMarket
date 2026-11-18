const { randomUUID } = require('crypto');

// Every request gets an ID (reused from X-Request-Id if the caller sent a sane one).
// pino-http picks it up so it appears on every log line for that request.
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

module.exports = function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  req.id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};
