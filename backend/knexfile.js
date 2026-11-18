require('dotenv').config();

// Standalone (does not import src/config) so the Knex CLI works for migrations
// even before the full app configuration is valid.
module.exports = {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 2, max: 20 },
  migrations: {
    directory: './src/db/migrations',
    tableName: 'knex_migrations',
  },
  seeds: {
    directory: './src/db/seeds',
  },
};
