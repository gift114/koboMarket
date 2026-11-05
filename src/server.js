const config = require('./config');
const logger = require('./utils/logger');
const createApp = require('./app');
const { connectMongo, disconnectMongo } = require('./config/mongo');
const { disconnectPostgres, pingPostgres } = require('./config/postgres');

async function main() {
  await connectMongo();
  await pingPostgres();
  logger.info('PostgreSQL connected');

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(`KoboMarket API listening on port ${config.port} (docs at /api-docs)`);
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      await Promise.allSettled([disconnectMongo(), disconnectPostgres()]);
      process.exit(0);
    });
    // Force exit if connections hang.
    setTimeout(() => process.exit(1), 10000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
