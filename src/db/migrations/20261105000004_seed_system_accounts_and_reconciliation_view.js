/**
 * Reference data the platform cannot run without: the system accounts.
 * (User wallets are created at registration; demo data comes from `npm run seed`.)
 *
 * Also creates account_reconciliation, which compares every cached balance with the
 * sum of its ledger entries. It must never return a mismatch; the admin reconciliation
 * report and `npm run audit:ledger` both read from it.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    INSERT INTO accounts (owner_type, owner_id, currency) VALUES
      ('SYSTEM', 'PLATFORM_ESCROW',          'NGN'),
      ('SYSTEM', 'PLATFORM_REVENUE',         'NGN'),
      ('SYSTEM', 'PLATFORM_PAYOUT_CLEARING', 'NGN'),
      ('SYSTEM', 'PLATFORM_EXTERNAL',        'NGN')
  `);

  await knex.raw(`
    CREATE VIEW account_reconciliation AS
    SELECT a.id            AS account_id,
           a.owner_type,
           a.owner_id,
           a.currency,
           a.balance_kobo  AS cached_balance_kobo,
           COALESCE(SUM(CASE e.direction WHEN 'credit' THEN e.amount_kobo ELSE -e.amount_kobo END), 0)::bigint
                           AS ledger_balance_kobo
      FROM accounts a
      LEFT JOIN ledger_entries e ON e.account_id = a.id
     GROUP BY a.id
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS account_reconciliation');
  // The system accounts are not deleted here: accounts are undeletable and may already be
  // referenced by ledger entries. They disappear when the accounts table is dropped by the
  // rollback of the create_accounts migration.
};
