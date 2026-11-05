/**
 * ledger_entries: the double-entry ledger. APPEND-ONLY.
 *
 * Enforced by the database, not by application code:
 *  - amount_kobo > 0 and direction in (debit, credit)
 *  - UPDATE, DELETE and TRUNCATE are rejected by triggers
 *  - every transaction must have >= 2 entries, one currency, a POSTED/REVERSED header,
 *    and SUM(credits) = SUM(debits). Checked at COMMIT (deferred), so entries can be
 *    inserted in any order inside one database transaction.
 *  - inserting an entry updates accounts.balance_kobo in the same statement, so the cached
 *    balance always equals SUM(entries) and an overdraft fails the accounts CHECK.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE ledger_entries (
      id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      transaction_id uuid        NOT NULL REFERENCES transactions (id),
      account_id     uuid        NOT NULL REFERENCES accounts (id),
      direction      text        NOT NULL,
      amount_kobo    bigint      NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT ledger_entries_amount_positive_chk CHECK (amount_kobo > 0),
      CONSTRAINT ledger_entries_direction_chk CHECK (direction IN ('debit', 'credit'))
    )
  `);

  await knex.raw('CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id)');
  await knex.raw('CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, id)');

  // ---- Append-only ----
  await knex.raw(`
    CREATE FUNCTION ledger_entries_block_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'LEDGER_APPEND_ONLY: ledger_entries rows cannot be changed or removed (% attempted); post a reversing transaction instead', TG_OP;
    END
    $$ LANGUAGE plpgsql
  `);

  await knex.raw(`
    CREATE TRIGGER ledger_entries_no_update_delete
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_entries_block_mutation()
  `);

  await knex.raw(`
    CREATE TRIGGER ledger_entries_no_truncate
    BEFORE TRUNCATE ON ledger_entries
    FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_block_mutation()
  `);

  // ---- Keep accounts.balance_kobo equal to the ledger ----
  await knex.raw(`
    CREATE FUNCTION ledger_entries_apply_balance() RETURNS trigger AS $$
    BEGIN
      UPDATE accounts
         SET balance_kobo = balance_kobo
               + CASE NEW.direction WHEN 'credit' THEN NEW.amount_kobo ELSE -NEW.amount_kobo END
       WHERE id = NEW.account_id;
      RETURN NULL;
    END
    $$ LANGUAGE plpgsql
  `);

  await knex.raw(`
    CREATE TRIGGER ledger_entries_apply_balance
    AFTER INSERT ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_entries_apply_balance()
  `);

  // ---- Every transaction must balance (checked at COMMIT) ----
  await knex.raw(`
    CREATE FUNCTION ledger_assert_transaction_valid() RETURNS trigger AS $$
    DECLARE
      v_credit     bigint;
      v_debit      bigint;
      v_count      integer;
      v_currencies integer;
      v_status     text;
    BEGIN
      SELECT COALESCE(SUM(e.amount_kobo) FILTER (WHERE e.direction = 'credit'), 0),
             COALESCE(SUM(e.amount_kobo) FILTER (WHERE e.direction = 'debit'), 0),
             COUNT(*),
             COUNT(DISTINCT a.currency)
        INTO v_credit, v_debit, v_count, v_currencies
        FROM ledger_entries e
        JOIN accounts a ON a.id = e.account_id
       WHERE e.transaction_id = NEW.transaction_id;

      SELECT status INTO v_status FROM transactions WHERE id = NEW.transaction_id;

      IF v_status NOT IN ('POSTED', 'REVERSED') THEN
        RAISE EXCEPTION 'LEDGER_TRANSACTION_NOT_POSTED: transaction % has status % so it cannot have ledger entries', NEW.transaction_id, v_status;
      END IF;

      IF v_count < 2 THEN
        RAISE EXCEPTION 'LEDGER_TOO_FEW_ENTRIES: transaction % has % entry, a movement needs a debit and a credit', NEW.transaction_id, v_count;
      END IF;

      IF v_currencies > 1 THEN
        RAISE EXCEPTION 'LEDGER_MIXED_CURRENCY: transaction % mixes currencies', NEW.transaction_id;
      END IF;

      IF v_credit <> v_debit THEN
        RAISE EXCEPTION 'LEDGER_UNBALANCED: transaction % has credits % and debits % (must be equal)', NEW.transaction_id, v_credit, v_debit;
      END IF;

      RETURN NULL;
    END
    $$ LANGUAGE plpgsql
  `);

  await knex.raw(`
    CREATE CONSTRAINT TRIGGER ledger_entries_assert_valid
    AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ledger_assert_transaction_valid()
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS ledger_entries CASCADE');
  await knex.raw('DROP FUNCTION IF EXISTS ledger_entries_block_mutation()');
  await knex.raw('DROP FUNCTION IF EXISTS ledger_entries_apply_balance()');
  await knex.raw('DROP FUNCTION IF EXISTS ledger_assert_transaction_valid()');
};
