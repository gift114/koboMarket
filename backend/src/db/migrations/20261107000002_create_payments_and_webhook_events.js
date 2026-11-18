/**
 * payments: one row per wallet-funding attempt (our side of a Paystack transaction).
 * webhook_events: every webhook we receive, deduplicated.
 *
 * The database refuses bad data even if the code has a bug:
 *   - amount > 0 and NGN only; reference unique;
 *   - the fields that identify a payment can never change;
 *   - status only moves PENDING -> SUCCEEDED | FAILED, and never back (a payment is credited once);
 *   - SUCCEEDED requires a ledger transaction, and one ledger transaction can back only one payment.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE payments (
      id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id               text        NOT NULL,
      reference             text        NOT NULL,
      provider              text        NOT NULL,
      amount_kobo           bigint      NOT NULL,
      currency              text        NOT NULL DEFAULT 'NGN',
      status                text        NOT NULL DEFAULT 'PENDING',
      authorization_url     text,
      failure_reason        text,
      ledger_transaction_id uuid        REFERENCES transactions (id),
      paid_at               timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT payments_reference_unique UNIQUE (reference),
      CONSTRAINT payments_ledger_transaction_unique UNIQUE (ledger_transaction_id),
      CONSTRAINT payments_amount_chk CHECK (amount_kobo > 0),
      CONSTRAINT payments_currency_chk CHECK (currency = 'NGN'),
      CONSTRAINT payments_status_chk CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
      CONSTRAINT payments_user_id_chk CHECK (user_id ~ '^[a-f0-9]{24}$'),
      CONSTRAINT payments_succeeded_has_ledger_chk
        CHECK (status <> 'SUCCEEDED' OR (ledger_transaction_id IS NOT NULL AND paid_at IS NOT NULL))
    )
  `);
  await knex.raw('CREATE INDEX payments_user_idx ON payments (user_id, created_at DESC)');

  await knex.raw(`
    CREATE FUNCTION payments_guard_update() RETURNS trigger AS $$
    BEGIN
      IF NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.reference IS DISTINCT FROM OLD.reference
         OR NEW.provider IS DISTINCT FROM OLD.provider
         OR NEW.amount_kobo IS DISTINCT FROM OLD.amount_kobo
         OR NEW.currency IS DISTINCT FROM OLD.currency THEN
        RAISE EXCEPTION 'PAYMENT_IMMUTABLE: user, reference, provider, amount and currency cannot be changed';
      END IF;
      IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'PENDING' THEN
        RAISE EXCEPTION 'PAYMENT_INVALID_STATUS: a % payment cannot change status', OLD.status;
      END IF;
      NEW.updated_at := now();
      RETURN NEW;
    END
    $$ LANGUAGE plpgsql
  `);
  await knex.raw(`
    CREATE TRIGGER payments_guard_update BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION payments_guard_update()
  `);
  await knex.raw(`
    CREATE FUNCTION payments_block_delete() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'PAYMENT_UNDELETABLE: payments are never deleted (audit trail)';
    END
    $$ LANGUAGE plpgsql
  `);
  await knex.raw(`
    CREATE TRIGGER payments_block_delete BEFORE DELETE ON payments
    FOR EACH ROW EXECUTE FUNCTION payments_block_delete()
  `);

  await knex.raw(`
    CREATE TABLE webhook_events (
      id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      provider      text        NOT NULL,
      event_key     text        NOT NULL,
      event_type    text        NOT NULL,
      payload       jsonb       NOT NULL,
      received_at   timestamptz NOT NULL DEFAULT now(),
      processed_at  timestamptz,
      outcome       text,
      CONSTRAINT webhook_events_unique UNIQUE (provider, event_key)
    )
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS webhook_events');
  await knex.raw('DROP TABLE IF EXISTS payments');
  await knex.raw('DROP FUNCTION IF EXISTS payments_guard_update()');
  await knex.raw('DROP FUNCTION IF EXISTS payments_block_delete()');
};
