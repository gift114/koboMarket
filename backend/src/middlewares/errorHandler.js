const { ZodError } = require('zod');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const config = require('../config');

function notFound(req, res, next) {
  next(AppError.notFound(`Route ${req.method} ${req.originalUrl.split('?')[0]} not found`, 'ROUTE_NOT_FOUND'));
}

// Central error handler. Every error response has the same shape:
// { success: false, error: { code, message, details } }
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let error = err;

  if (err instanceof ZodError) {
    error = AppError.validation(
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  } else if (err && err.type === 'entity.parse.failed') {
    error = AppError.badRequest('Request body is not valid JSON');
  } else if (err && err.type === 'entity.too.large') {
    error = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  } else if (!(err instanceof AppError)) {
    // Unknown error: log everything server-side, tell the client nothing sensitive.
    const log = req.log || logger;
    log.error({ err, requestId: req.id }, 'Unhandled error');
    error = new AppError(
      500,
      'INTERNAL_ERROR',
      config.isProd ? 'Something went wrong' : err.message || 'Something went wrong',
    );
  } else if (error.statusCode >= 500) {
    (req.log || logger).error({ err, requestId: req.id }, 'Server error');
  }

  if (error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));

  res.status(error.statusCode).json({
    success: false,
    error: {
      code: error.code,
      message: error.message,
      details: error.details || null,
    },
  });
}

module.exports = { notFound, errorHandler };
