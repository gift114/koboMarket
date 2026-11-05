const path = require('path');
const knex = require('knex');
const { testDatabaseUrl } = require('./test-env');

/**
 * Runs once before the whole suite: create the test database if needed, roll every
 * migration back, then migrate to latest. A clean schema every run also proves the
 * down() of every migration works.
 */
module.exports = async () => {
  const url = new URL(testDatabaseUrl);
  const dbName = url.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(dbName)) throw new Error(`Unsafe test database name: ${dbName}`);

  const adminUrl = new URL(testDatabaseUrl);
  adminUrl.pathname = '/postgres';
  const admin = knex({ client: 'pg', connection: adminUrl.toString() });
  try {
    const { rowCount } = await admin.raw('SELECT 1 FROM pg_database WHERE datname = ?', [dbName]);
    if (rowCount === 0) await admin.raw(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    throw new Error(
      `Cannot reach PostgreSQL for tests (${adminUrl.host}). Start it with "docker-compose up -d postgres". ${err.message}`,
    );
  } finally {
    await admin.destroy();
  }

  const db = knex({
    client: 'pg',
    connection: testDatabaseUrl,
    migrations: { directory: path.join(__dirname, '..', 'src', 'db', 'migrations'), tableName: 'knex_migrations' },
  });
  try {
    await db.migrate.rollback(undefined, true);
    await db.migrate.latest();
  } finally {
    await db.destroy();
  }
};
