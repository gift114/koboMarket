const config = require('../../config');
const logger = require('../../utils/logger');
const userRepository = require('../users/user.repository');
const accountRepository = require('./account.repository');

/**
 * Cross-database consistency, case 1 of 2: "a user exists in MongoDB but creating their
 * wallet in PostgreSQL failed".
 *
 * MongoDB and PostgreSQL cannot share a transaction, so this is built to converge instead:
 *
 *   1. The user is created in MongoDB with walletStatus = "pending". That field IS the
 *      durable record of work still to do (an outbox entry stored on the user document).
 *   2. Fast path: right away, create the PostgreSQL account and flip the user to "ready".
 *   3. If anything fails, nothing is lost: the user stays "pending" and the reconciler job
 *      retries with exponential backoff until it works.
 *
 * Every step is idempotent (the account insert is ON CONFLICT DO NOTHING, "ready" is a plain
 * set), so a crash or a retry between any two steps can never create a second wallet or
 * leave a wrong state. See also: reconcile() below and src/jobs/walletProvisioning.job.js.
 */

const LEASE_MS = 60 * 1000;
const BASE_BACKOFF_SECONDS = 5;

/** Create the wallet (if missing) and mark the user ready. Throws if either step fails. */
async function provision(userId) {
  await accountRepository.createUserAccountIfMissing(userId);
  await userRepository.markWalletReady(userId);
}

/** 5s, 10s, 20s ... capped by WALLET_PROVISION_MAX_BACKOFF_SECONDS. */
function backoffSeconds(attempts) {
  const exponential = BASE_BACKOFF_SECONDS * 2 ** Math.min(Math.max(attempts - 1, 0), 20);
  return Math.min(exponential, config.walletProvisioning.maxBackoffSeconds);
}

/** Record a failure and schedule the next retry. Never throws: this is already the error path. */
async function scheduleRetry(userId, err, now = new Date()) {
  try {
    const attempts = await userRepository.incrementWalletAttempts(userId);
    const nextAttemptAt = new Date(now.getTime() + backoffSeconds(attempts) * 1000);
    await userRepository.scheduleWalletRetry(userId, nextAttemptAt);
    // Early failures are routine (a brief database blip); persistent ones deserve attention.
    logger[attempts >= 5 ? 'error' : 'warn'](
      { err, userId, attempts, nextAttemptAt },
      'Wallet provisioning failed, will retry',
    );
  } catch (scheduleErr) {
    // Even recording the failure failed (MongoDB down too). The user is still "pending" with
    // its original grace time, so the reconciler will find it anyway.
    logger.error({ err: scheduleErr, userId }, 'Could not record wallet provisioning failure');
  }
}

/** Called at signup. Never throws, so a wallet problem cannot lose a registration. */
async function tryProvision(userId) {
  try {
    await provision(userId);
  } catch (err) {
    await scheduleRetry(userId, err);
  }
}

/**
 * One pass of the reconciler: claim pending users that are due and provision each one.
 * `now` can be injected so tests do not have to wait for grace periods and backoff.
 */
async function reconcile(now = new Date()) {
  const { batchSize } = config.walletProvisioning;
  const userIds = await userRepository.claimPendingWalletUsers(now, batchSize, LEASE_MS);

  let provisioned = 0;
  let failed = 0;
  for (const userId of userIds) {
    try {
      await provision(userId);
      provisioned += 1;
    } catch (err) {
      failed += 1;
      await scheduleRetry(userId, err, now);
    }
  }

  if (userIds.length > 0) {
    logger.info({ claimed: userIds.length, provisioned, failed }, 'Wallet provisioning pass finished');
  }
  return { claimed: userIds.length, provisioned, failed };
}

module.exports = { provision, tryProvision, reconcile, backoffSeconds };
