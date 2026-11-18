const AppError = require('../utils/AppError');

/**
 * Role-based access control. Mount AFTER authenticate:
 *
 *   router.post('/products', authenticate, authorize('vendor'), controller.create);
 *   router.use(authenticate, authorize('admin'));   // a whole router
 *
 * A user may hold several roles (a buyer who is also a vendor); access is granted if they
 * hold ANY of the listed roles. This is the only place roles are checked: controllers and
 * services never contain `if (user.role === ...)`. Roles come from the database on every
 * request (see authenticate), so a newly approved vendor has access immediately and a
 * revoked role stops working immediately.
 */
module.exports = function authorize(...allowedRoles) {
  if (allowedRoles.length === 0) {
    throw new Error('authorize() needs at least one role');
  }

  return (req, res, next) => {
    if (!req.user) {
      return next(AppError.unauthorized('Authentication required', 'UNAUTHORIZED'));
    }
    const allowed = req.user.roles.some((role) => allowedRoles.includes(role));
    if (!allowed) {
      return next(
        AppError.forbidden(`This action requires one of these roles: ${allowedRoles.join(', ')}`, 'INSUFFICIENT_ROLE'),
      );
    }
    return next();
  };
};
