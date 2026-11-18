const cron = require('node-cron');
const config = require('../config');
const logger = require('../utils/logger');
const walletProvisioningJob = require('./walletProvisioning.job');
const stuckOrdersJob = require('./stuckOrders.job');
const autoCompleteJob = require('./autoComplete.job');
const payoutsJob = require('./payouts.job');

// Jobs registered here start with the API process. Later modules add theirs (escrow
// auto-complete, payouts). Each job is guarded so a slow run is never overlapped by the next
// tick, and an exception in one run is logged instead of crashing the process.
const tasks = [];

function schedule(job, expression) {
  if (!cron.validate(expression)) {
    throw new Error(`Invalid cron expression for job "${job.name}": ${expression}`);
  }
  let running = false;
  const task = cron.schedule(expression, async () => {
    if (running) return;
    running = true;
    try {
      await job.run();
    } catch (err) {
      logger.error({ err, job: job.name }, 'Background job failed');
    } finally {
      running = false;
    }
  });
  tasks.push(task);
  logger.info({ job: job.name, cron: expression }, 'Background job scheduled');
}

function start() {
  schedule(walletProvisioningJob, config.walletProvisioning.cron);
  schedule(stuckOrdersJob, config.business.orderReconcileCron);
  schedule(autoCompleteJob, config.business.escrowAutoCompleteCron);
  schedule(payoutsJob, config.business.payoutProcessCron);
}

function stop() {
  tasks.splice(0).forEach((task) => task.stop());
}

module.exports = { start, stop };
