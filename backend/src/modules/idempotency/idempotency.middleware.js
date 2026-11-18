const { createHash } = require('crypto');
const AppError = require('../../utils/AppError');
const logger = require('../../utils/logger');
const config = require('../../config');
const repository = require('./idempotency.repository');

const KEY_FORMAT = /^[A-Za-z0-9._:-]{8,128}$/;

/** JSON with sorted keys, so { a, b } and { b, a } are the same request. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const hashRequest = (req) =>
  createHash('sha256').update(`${req.method} ${req.baseUrl}${req.path}\n${canonical(req.body || {})}`).digest('hex');

/**
 * Idempotency-Key support for endpoints that move money (fund, checkout, payout).
 *
 *   router.post('/fund', authenticate, validate(...), idempotent(), controller.fund);
 *
 *   same key + same request  -> the ORIGINAL response is replayed (header Idempotent-Replayed: true)
 *   same key + other request -> 409 IDEMPOTENCY_KEY_REUSED
 *   same key, first request still running -> 409 REQUEST_IN_PROGRESS (retry shortly)
 *   no / malformed key       -> 400
 *
 * Only successful (2xx) responses are stored. A failed request is forgotten, so the client can
 * fix the problem and retry with the same key. The response is stored BEFORE it is sent, so a
 * client that retries the instant it gets the response always finds it.
 * Keys are per user, so one user can never replay another's response.
 * Mount after authenticate and validate.
 */
module.exports = function idempotent() {
  return async function idempotencyMiddleware(req, res, next) {
    try {
      const key = req.get('Idempotency-Key');
      if (!key) {
        throw AppError.badRequest('The Idempotency-Key header is required for this request', {
          header: 'Idempotency-Key',
        });
      }
      if (!KEY_FORMAT.test(key)) {
        throw AppError.badRequest('Idempotency-Key must be 8-128 characters: letters, digits, . _ : -');
      }

      const hash = hashRequest(req);
      let { claimed, record } = await repository.claim(req.user.id, key, hash, config.idempotency);

      if (!claimed) {
        if (record.requestHash !== hash) {
          throw AppError.conflict(
            'This Idempotency-Key was already used for a different request',
            'IDEMPOTENCY_KEY_REUSED',
          );
        }
        if (record.status === 'COMPLETED') {
          res.set('Idempotent-Replayed', 'true');
          return res.status(record.responseStatus).json(record.responseBody);
        }
        // Still running. If its owner has been silent for too long, take it over.
        if (!(await repository.takeOver(record.id, config.idempotency))) {
          throw new AppError(409, 'REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed', null);
        }
        claimed = true;
      }

      const recordId = record.id;
      const sendJson = res.json.bind(res);
      res.json = (body) => {
        const status = res.statusCode;
        const settle = status >= 200 && status < 300 ? repository.complete(recordId, status, body) : repository.release(recordId);
        settle
          .catch((err) => logger.error({ err, recordId }, 'Could not finalise the idempotency record'))
          .finally(() => sendJson(body));
        return res;
      };
      return next();
    } catch (err) {
      return next(err);
    }
  };
};

module.exports.canonical = canonical;
