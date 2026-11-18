const { types } = require('pg');
const knex = require('knex');
const knexConfig = require('../../knexfile');

// node-pg returns bigint (int8) columns as strings by default. All money columns are bigint
// kobo, so parse them to JS numbers, and fail loudly rather than silently losing precision.
types.setTypeParser(types.builtins.INT8, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`bigint value ${value} exceeds the safe integer range`);
  }
  return n;
});

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
