const knex = require('knex');
const knexConfig = require('../../knexfile');

// One shared Knex instance (connection pool) for the whole app.
// Repositories receive either this instance or a transaction object (trx),
// so services can run several repository calls inside ONE PostgreSQL transaction.
const db = knex(knexConfig);

async function pingPostgres() {
  await db.raw('select 1');
}

async function disconnectPostgres() {
  await db.destroy();
}

module.exports = { db, pingPostgres, disconnectPostgres };
