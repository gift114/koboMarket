/**
 * A transaction can be reversed at most once. Enforced by the database, so even two reversal
 * requests racing past the application's checks cannot both succeed (which would pay the
 * money back twice).
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE UNIQUE INDEX transactions_one_reversal_per_transaction
    ON transactions (reverses_transaction_id)
    WHERE reverses_transaction_id IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS transactions_one_reversal_per_transaction');
};
