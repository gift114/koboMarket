/**
 * Operational error with an HTTP status and a stable machine-readable code.
 * Services throw these; the central error handler turns them into
 * { success: false, error: { code, message, details } }.
 */
class AppError extends Error {
  constructor(statusCode, code, message, details = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message = 'Bad request', details) {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }
  static validation(details, message = 'Validation failed') {
    return new AppError(422, 'VALIDATION_ERROR', message, details);
  }
  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new AppError(401, code, message);
  }
  static forbidden(message = 'You do not have permission to do this', code = 'FORBIDDEN') {
    return new AppError(403, code, message);
  }
  static notFound(message = 'Resource not found', code = 'NOT_FOUND') {
    return new AppError(404, code, message);
  }
  static conflict(message = 'Conflict', code = 'CONFLICT', details) {
    return new AppError(409, code, message, details);
  }
  static tooManyRequests(message = 'Too many requests', code = 'RATE_LIMITED') {
    return new AppError(429, code, message);
  }
}

module.exports = AppError;
