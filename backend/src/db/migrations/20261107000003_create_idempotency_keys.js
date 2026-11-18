/**
 * Idempotency-Key records (shared by wallet funding, checkout and payouts).
 * One row per (user, key). The unique constraint is what makes "the same key never runs
 * twice" true even when two identical requests arrive at the same instant.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE idempotency_keys (
      id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id         text        NOT NULL,
      key             text        NOT NULL,
      request_hash    text        NOT NULL,
      status          text        NOT NULL DEFAULT 'IN_PROGRESS',
      response_status integer,
      response_body   jsonb,
      locked_at       timestamptz NOT NULL DEFAULT now(),
      expires_at      timestamptz NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT idempotency_keys_unique UNIQUE (user_id, key),
      CONSTRAINT idempotency_keys_status_chk CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
      CONSTRAINT idempotency_keys_completed_chk
        CHECK (status <> 'COMPLETED' OR (response_status IS NOT NULL AND response_body IS NOT NULL))
    )
  `);
  await knex.raw('CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at)');
};

exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS idempotency_keys');
};
