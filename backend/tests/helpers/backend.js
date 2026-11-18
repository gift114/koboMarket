/**
 * Chooses where the MongoDB-backed repositories run during tests.
 *
 *   (default)            real MongoDB at MONGO_URI (docker-compose provides it)
 *   TEST_BACKEND=memory  in-memory repositories, for machines without MongoDB
 *
 * Must be required BEFORE src/app so the mocks are in place when the app loads.
 */
const MEMORY = process.env.TEST_BACKEND === 'memory';
const memory = MEMORY ? require('./memory-repositories') : null;

if (MEMORY) {
  const mock = (relativePath, impl) =>
    jest.doMock(require.resolve(relativePath), () => impl);
  mock('../../src/modules/users/user.repository', memory.userRepository);
  mock('../../src/modules/auth/refreshToken.repository', memory.refreshTokenRepository);
  mock('../../src/modules/auth/authToken.repository', memory.authTokenRepository);
  mock('../../src/modules/auth/loginAttempt.repository', memory.loginAttemptRepository);
  mock('../../src/modules/vendors/vendor.repository', memory.vendorRepository);
  mock('../../src/modules/notifications/notification.repository', memory.notificationRepository);
  mock('../../src/modules/products/product.repository', memory.productRepository);
  mock('../../src/modules/reviews/review.repository', memory.reviewRepository);
  mock('../../src/modules/cart/cart.repository', memory.cartRepository);
}

async function start() {
  if (MEMORY) {
    memory.reset();
    return;
  }
  const mongoose = require('mongoose');
  const { connectMongo } = require('../../src/config/mongo');
  require('../../src/modules/users/user.model');
  require('../../src/modules/auth/refreshToken.model');
  require('../../src/modules/auth/authToken.model');
  require('../../src/modules/auth/loginAttempt.model');
  require('../../src/modules/vendors/vendor.model');
  require('../../src/modules/products/product.model');
  require('../../src/modules/reviews/review.model');
  require('../../src/modules/cart/cart.model');
  require('../../src/modules/notifications/notification.model');

  await connectMongo();
  await mongoose.connection.dropDatabase(); // a clean slate every run (test database only)
  await Promise.all(Object.values(mongoose.models).map((m) => m.init())); // build unique/TTL indexes
}

async function stop() {
  if (MEMORY) return;
  await require('../../src/config/mongo').disconnectMongo();
}

/** Make every unused one-time token of a user already expired. */
async function expireAuthTokens(userId, type) {
  const past = new Date(Date.now() - 60 * 1000);
  if (MEMORY) {
    memory.store.authTokens.forEach((t) => {
      if (t.userId === userId && t.type === type) t.expiresAt = past;
    });
    return;
  }
  await require('../../src/modules/auth/authToken.model').updateMany({ userId, type }, { $set: { expiresAt: past } });
}

/** Make every refresh token of a user already expired. */
async function expireRefreshTokens(userId) {
  const past = new Date(Date.now() - 60 * 1000);
  if (MEMORY) {
    memory.store.refreshTokens.forEach((t) => {
      if (t.userId === userId) t.expiresAt = past;
    });
    return;
  }
  await require('../../src/modules/auth/refreshToken.model').updateMany({ userId }, { $set: { expiresAt: past } });
}

/** How many refresh tokens of a user could still be exchanged (unused and not revoked). */
async function countLiveRefreshTokens(userId) {
  if (MEMORY) {
    return [...memory.store.refreshTokens.values()].filter((t) => t.userId === userId && !t.usedAt && !t.revokedAt)
      .length;
  }
  return require('../../src/modules/auth/refreshToken.model').countDocuments({ userId, usedAt: null, revokedAt: null });
}

module.exports = { MEMORY, start, stop, expireAuthTokens, expireRefreshTokens, countLiveRefreshTokens };
