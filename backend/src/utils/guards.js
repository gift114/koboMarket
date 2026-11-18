const AppError = require('./AppError');

/** Frozen users can log in and look around, but cannot place orders or withdraw money. */
function assertNotFrozen(user) {
  if (user.status === 'frozen') {
    throw AppError.forbidden('Your account has been frozen. Please contact support.', 'ACCOUNT_FROZEN');
  }
}

module.exports = { assertNotFrozen };
