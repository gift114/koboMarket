/**
 * payouts: a vendor withdrawing wallet money to their bank account.
 *
 * Money path (all through the ledger service):
 *   request     vendor wallet      -> PLATFORM_PAYOUT_CLEARING   (immediately; the money is "in flight")
 *   success     PAYOUT_CLEARING    -> PLATFORM_EXTERNAL          (it left the platform)
 *   failure     PAYOUT_CLEARING    -> vendor wallet              (reversed; the vendor can retry)
 *
 * Enforced by the database:
 *   - a vendor has at most ONE pending payout (partial unique index), so two requests racing each
 *     other can never both get through;
 *   - amount, owner, bank snapshot and reference never change; PENDING -> SUCCESS | FAILED is the
 *     only transition and a finished payout is final;
 *   - SUCCESS needs its settlement transaction, FAILED its reversal transaction and a reason;
 *   - nothing is deleted.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE payouts (
      id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id                   text        NOT NULL,
      vendor_id                 text        NOT NULL,
      reference                 text        NOT NULL,
      amount_kobo               bigint      NOT NULL,
      currency                  text        NOT NULL DEFAULT 'NGN',
      bank_name                 text        NOT NULL,
      account_number            text        NOT NULL,
      account_name              text        NOT NULL,
      status                    text        NOT NULL DEFAULT 'PENDING',
      provider                  text,
      failure_reason            text,
      request_transaction_id    uuid        NOT NULL REFERENCES transactions (id),
      settlement_transaction_id uuid        REFERENCES transactions (id),
      reversal_transaction_id   uuid        REFERENCES transactions (id),
      attempts                  integer     NOT NULL DEFAULT 0,
      claimed_at                timestamptz,
      processed_at              timestamptz,
      created_at                timestamptz NOT NULL DEFAULT now(),
      updated_at                timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT payouts_reference_unique UNIQUE (reference),
      CONSTRAINT payouts_request_tx_unique UNIQUE (request_transaction_id),
      CONSTRAINT payouts_ids_chk CHECK (user_id ~ '^[a-f0-9]{24}$' AND vendor_id ~ '^[a-f0-9]{24}$'),
      CONSTRAINT payouts_amount_chk CHECK (amount_kobo > 0),
      CONSTRAINT payouts_currency_chk CHECK (currency = 'NGN'),
      CONSTRAINT payouts_status_chk CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
      CONSTRAINT payouts_pending_shape_chk CHECK (
        status <> 'PENDING' OR (settlement_transaction_id IS NULL AND reversal_transaction_id IS NULL AND processed_at IS NULL AND failure_reason IS NULL)
      ),
      CONSTRAINT payouts_success_shape_chk CHECK (
        status <> 'SUCCESS' OR (settlement_transaction_id IS NOT NULL AND reversal_transaction_id IS NULL AND processed_at IS NOT NULL)
      ),
      CONSTRAINT payouts_failed_shape_chk CHECK (
        status <> 'FAILED' OR (reversal_transaction_id IS NOT NULL AND settlement_transaction_id IS NULL AND processed_at IS NOT NULL AND failure_reason IS NOT NULL)
      )
    )
  `);
  // "At most one PENDING payout per vendor", enforced where races cannot get around it.
  await knex.raw("CREATE UNIQUE INDEX payouts_one_pending_per_user ON payouts (user_id) WHERE status = 'PENDING'");
  await knex.raw('CREATE INDEX payouts_user_idx ON payouts (user_id, created_at DESC, id DESC)');
  await knex.raw("CREATE INDEX payouts_pending_idx ON payouts (created_at) WHERE status = 'PENDING'");

  await knex.raw(`
    CREATE FUNCTION payouts_guard_update() RETURNS trigger AS $$
    BEGIN
      IF NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
         OR NEW.reference IS DISTINCT FROM OLD.reference
         OR NEW.amount_kobo IS DISTINCT FROM OLD.amount_kobo
         OR NEW.bank_name IS DISTINCT FROM OLD.bank_name
         OR NEW.account_number IS DISTINCT FROM OLD.account_number
         OR NEW.account_name IS DISTINCT FROM OLD.account_name
         OR NEW.request_transaction_id IS DISTINCT FROM OLD.request_transaction_id
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'PAYOUT_IMMUTABLE: owner, amount, bank details and reference cannot be changed';
      END IF;
      IF OLD.status <> 'PENDING' THEN
        RAISE EXCEPTION 'PAYOUT_FINAL: a finished payout cannot be changed';
      END IF;
      NEW.updated_at := now();
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `);
  await knex.raw('CREATE TRIGGER payouts_guard_update BEFORE UPDATE ON payouts FOR EACH ROW EXECUTE FUNCTION payouts_guard_update()');

  await knex.raw(`
    CREATE FUNCTION payouts_block_delete() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'PAYOUT_NO_DELETE: payouts are never deleted';
    END $$ LANGUAGE plpgsql
  `);
  await knex.raw('CREATE TRIGGER payouts_block_delete BEFORE DELETE ON payouts FOR EACH ROW EXECUTE FUNCTION payouts_block_delete()');
};

exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS payouts');
  await knex.raw('DROP FUNCTION IF EXISTS payouts_guard_update()');
  await knex.raw('DROP FUNCTION IF EXISTS payouts_block_delete()');
};
