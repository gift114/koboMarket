/**
 * transactions: the header row for every money movement. The actual debits and credits
 * live in ledger_entries. Rows are never deleted, and the fields that identify a
 * transaction (reference, type, idempotency_key) can never change after creation.
 *
 * Status lifecycle: PENDING -> POSTED | FAILED, and POSTED -> REVERSED.
 * Ledger entries may only exist for POSTED (or later REVERSED) transactions.
 * A mistake is fixed by a NEW transaction whose reverses_transaction_id points at the old one.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE transactions (
      id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      reference               text        NOT NULL,
      type                    text        NOT NULL,
      status                  text        NOT NULL DEFAULT 'PENDING',
      idempotency_key         text,
      reverses_transaction_id uuid        REFERENCES transactions (id),
      metadata                jsonb       NOT NULL DEFAULT '{}'::jsonb,
      created_at              timestamptz NOT NULL DEFAULT now(),
      updated_at              timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT transactions_reference_unique UNIQUE (reference),
      CONSTRAINT transactions_idempotency_key_unique UNIQUE (idempotency_key),
      CONSTRAINT transactions_reference_chk CHECK (length(reference) BETWEEN 1 AND 200),
      CONSTRAINT transactions_type_chk CHECK (type IN (
        'WALLET_FUNDING', 'ORDER_PAYMENT', 'ESCROW_RELEASE', 'ORDER_REFUND',
        'DISPUTE_RESOLUTION', 'PAYOUT_REQUEST', 'PAYOUT_SETTLEMENT', 'PAYOUT_REVERSAL',
        'REVERSAL', 'ADJUSTMENT'
      )),
      CONSTRAINT transactions_status_chk CHECK (status IN ('PENDING', 'POSTED', 'FAILED', 'REVERSED')),
      CONSTRAINT transactions_metadata_chk CHECK (jsonb_typeof(metadata) = 'object'),
      CONSTRAINT transactions_reverses_chk CHECK (reverses_transaction_id IS NULL OR type = 'REVERSAL')
    )
  `);

  await knex.raw('CREATE INDEX transactions_type_status_idx ON transactions (type, status)');
  await knex.raw('CREATE INDEX transactions_created_at_idx ON transactions (created_at)');

  await knex.raw(`
    CREATE FUNCTION transactions_guard_update() RETURNS trigger AS $$
    BEGIN
      IF NEW.reference IS DISTINCT FROM OLD.reference
         OR NEW.type IS DISTINCT FROM OLD.type
         OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
         OR NEW.reverses_transaction_id IS DISTINCT FROM OLD.reverses_transaction_id THEN
        RAISE EXCEPTION 'TRANSACTION_IMMUTABLE: reference, type, idempotency_key and reverses_transaction_id cannot be changed';
      END IF;

      IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
           (OLD.status = 'PENDING' AND NEW.status IN ('POSTED', 'FAILED'))
        OR (OLD.status = 'POSTED'  AND NEW.status = 'REVERSED')
      ) THEN
        RAISE EXCEPTION 'TRANSACTION_INVALID_STATUS: cannot move a transaction from % to %', OLD.status, NEW.status;
      END IF;

      NEW.updated_at := now();
      RETURN NEW;
    END
    $$ LANGUAGE plpgsql
  `);

  await knex.raw(`
    CREATE TRIGGER transactions_guard_update
    BEFORE UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION transactions_guard_update()
  `);

  await knex.raw(`
    CREATE FUNCTION transactions_block_delete() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'TRANSACTION_UNDELETABLE: transactions are never deleted (audit trail)';
    END
    $$ LANGUAGE plpgsql
  `);

  await knex.raw(`
    CREATE TRIGGER transactions_block_delete
    BEFORE DELETE ON transactions
    FOR EACH ROW EXECUTE FUNCTION transactions_block_delete()
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS transactions CASCADE');
  await knex.raw('DROP FUNCTION IF EXISTS transactions_guard_update()');
  await knex.raw('DROP FUNCTION IF EXISTS transactions_block_delete()');
};
