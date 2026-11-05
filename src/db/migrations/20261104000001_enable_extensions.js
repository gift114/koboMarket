/**
 * Day 1 migration: proves the migration pipeline works and enables extensions
 * used by later migrations (gen_random_uuid for primary keys).
 * Tables are created by migrations only, never by hand.
 */
exports.up = async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');
};

exports.down = async function down() {
  // Extensions are intentionally left in place on rollback.
};
