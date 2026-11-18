/**
 * accounts: one wallet per user plus the platform's system accounts.
 *
 * Sign convention (same for every account): balance_kobo = SUM(credits) - SUM(debits).
 * - User wallets and PLATFORM_ESCROW / REVENUE / PAYOUT_CLEARING can never go negative.
 * - PLATFORM_EXTERNAL represents the outside world (Paystack / the bank). Money funded
 *   into the platform is a debit on it, so it goes negative by exactly
 *   (total funded - total paid out). That is what makes the whole ledger sum to zero.
 *
 * balance_kobo is a CACHE maintained by a trigger on ledger_entries (see the ledger
 * migration). It cannot be edited directly, so it cannot drift from the ledger.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE accounts (
      id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_type    text        NOT NULL,
      owner_id      text        NOT NULL,
      currency      char(3)     NOT NULL DEFAULT 'NGN',
      balance_kobo  bigint      NOT NULL DEFAULT 0,
      status        text        NOT NULL DEFAULT 'ACTIVE',
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT accounts_owner_unique UNIQUE (owner_type, owner_id, currency),
      CONSTRAINT accounts_owner_type_chk CHECK (owner_type IN ('USER', 'SYSTEM')),
      CONSTRAINT accounts_status_chk CHECK (status IN ('ACTIVE', 'FROZEN', 'CLOSED')),
      CONSTRAINT accounts_user_owner_id_chk
        CHECK (owner_type <> 'USER' OR owner_id ~ '^[a-f0-9]{24}$'),
      CONSTRAINT accounts_system_owner_id_chk
        CHECK (owner_type <> 'SYSTEM' OR owner_id IN (
          'PLATFORM_ESCROW', 'PLATFORM_REVENUE', 'PLATFORM_PAYOUT_CLEARING', 'PLATFORM_EXTERNAL'
        )),
      CONSTRAINT accounts_balance_nonneg_chk
        CHECK (balance_kobo >= 0 OR (owner_type = 'SYSTEM' AND owner_id = 'PLATFORM_EXTERNAL'))
    )
  `);

  await knex.raw('CREATE INDEX accounts_owner_idx ON accounts (owner_type, owner_id)');

  await knex.raw(`
    CREATE FUNCTION accounts_guard_update() RETURNS trigger AS $$
    BEGIN
      IF NEW.owner_type IS DISTINCT FROM OLD.owner_type
         OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
         OR NEW.currency IS DISTINCT FROM OLD.currency THEN
        RAISE EXCEPTION 'ACCOUNT_IMMUTABLE: owner_type, owner_id and currency cannot be changed';
      END IF;

      -- pg_trigger_depth() is 1 for a direct UPDATE and 2 when the update comes from the
      -- ledger_entries trigger, so only the ledger can change a balance.
      IF NEW.balance_kobo IS DISTINCT FROM OLD.balance_kobo AND pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'ACCOUNT_BALANCE_PROTECTED: balance_kobo is maintained by ledger entries and cannot be updated directly';
      END IF;

      NEW.updated_at := now();
      RETURN NEW;
    END
    $$ LANGUAGE plpgsql
  `);

  await knex.raw(`
    CREATE TRIGGER accounts_guard_update
    BEFORE UPDATE ON accounts
    FOR EACH ROW EXECUTE FUNCTION accounts_guard_update()
  `);

  await knex.raw(`
    CREATE FUNCTION accounts_block_delete() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'ACCOUNT_UNDELETABLE: accounts are never deleted, set status to CLOSED instead';
    END
    $$ LANGUAGE plpgsql
  `);

  await knex.raw(`
    CREATE TRIGGER accounts_block_delete
    BEFORE DELETE ON accounts
    FOR EACH ROW EXECUTE FUNCTION accounts_block_delete()
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS accounts CASCADE');
  await knex.raw('DROP FUNCTION IF EXISTS accounts_guard_update()');
  await knex.raw('DROP FUNCTION IF EXISTS accounts_block_delete()');
};
