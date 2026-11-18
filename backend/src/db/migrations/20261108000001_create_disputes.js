/**
 * disputes: a buyer's complaint about one sub-order. Opening one moves the sub-order to
 * DISPUTED, which freezes its escrow (nothing in the system moves money out of a DISPUTED
 * sub-order except the admin resolution below). One dispute per sub-order, ever.
 *
 * Rules enforced by the database, not just the code:
 *   - the complaint (reason, evidence, escrow frozen, who, what) can never be edited;
 *   - OPEN -> RESOLVED is the only change allowed, and a resolved dispute is final;
 *   - a resolution always records the admin who decided it, a note, and a split that adds up:
 *       FULL_REFUND:    buyer gets all, vendor nothing
 *       PARTIAL_REFUND: both parts > 0, together exactly the frozen escrow
 *       REJECTED:       vendor gets all (commission is taken from it), buyer nothing
 *   - disputes are never deleted.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE disputes (
      id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      sub_order_id          uuid        NOT NULL REFERENCES sub_orders (id),
      order_id              uuid        NOT NULL REFERENCES orders (id),
      buyer_id              text        NOT NULL,
      vendor_user_id        text        NOT NULL,
      reason                text        NOT NULL,
      evidence              jsonb       NOT NULL DEFAULT '[]'::jsonb,
      escrow_kobo           bigint      NOT NULL,
      status                text        NOT NULL DEFAULT 'OPEN',
      resolution            text,
      refund_kobo           bigint,
      vendor_gross_kobo     bigint,
      commission_kobo       bigint,
      resolved_by           text,
      resolution_note       text,
      resolution_transaction_id uuid    REFERENCES transactions (id),
      resolved_at           timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT disputes_sub_order_unique UNIQUE (sub_order_id),
      CONSTRAINT disputes_ids_chk CHECK (buyer_id ~ '^[a-f0-9]{24}$' AND vendor_user_id ~ '^[a-f0-9]{24}$'),
      CONSTRAINT disputes_reason_chk CHECK (length(btrim(reason)) >= 10),
      CONSTRAINT disputes_evidence_chk CHECK (jsonb_typeof(evidence) = 'array'),
      CONSTRAINT disputes_escrow_chk CHECK (escrow_kobo > 0),
      CONSTRAINT disputes_status_chk CHECK (status IN ('OPEN', 'RESOLVED')),
      CONSTRAINT disputes_resolution_chk CHECK (resolution IS NULL OR resolution IN ('FULL_REFUND', 'PARTIAL_REFUND', 'REJECTED')),
      CONSTRAINT disputes_open_shape_chk CHECK (
        status <> 'OPEN' OR (resolution IS NULL AND refund_kobo IS NULL AND vendor_gross_kobo IS NULL AND commission_kobo IS NULL
                             AND resolved_by IS NULL AND resolution_note IS NULL AND resolution_transaction_id IS NULL AND resolved_at IS NULL)
      ),
      CONSTRAINT disputes_resolved_shape_chk CHECK (
        status <> 'RESOLVED' OR (
          resolution IS NOT NULL AND refund_kobo IS NOT NULL AND vendor_gross_kobo IS NOT NULL AND commission_kobo IS NOT NULL
          AND resolved_by ~ '^[a-f0-9]{24}$' AND length(btrim(resolution_note)) >= 3
          AND resolution_transaction_id IS NOT NULL AND resolved_at IS NOT NULL
          AND refund_kobo >= 0 AND vendor_gross_kobo >= 0 AND commission_kobo >= 0 AND commission_kobo <= vendor_gross_kobo
          AND refund_kobo + vendor_gross_kobo = escrow_kobo
          AND (
               (resolution = 'FULL_REFUND'    AND refund_kobo = escrow_kobo AND vendor_gross_kobo = 0)
            OR (resolution = 'PARTIAL_REFUND' AND refund_kobo > 0 AND vendor_gross_kobo > 0)
            OR (resolution = 'REJECTED'       AND refund_kobo = 0 AND vendor_gross_kobo = escrow_kobo)
          )
        )
      )
    )
  `);
  await knex.raw('CREATE INDEX disputes_buyer_idx ON disputes (buyer_id, created_at DESC, id DESC)');
  await knex.raw('CREATE INDEX disputes_vendor_idx ON disputes (vendor_user_id, created_at DESC, id DESC)');
  await knex.raw("CREATE INDEX disputes_open_idx ON disputes (created_at) WHERE status = 'OPEN'");

  await knex.raw(`
    CREATE FUNCTION disputes_guard_update() RETURNS trigger AS $$
    BEGIN
      IF NEW.sub_order_id IS DISTINCT FROM OLD.sub_order_id
         OR NEW.order_id IS DISTINCT FROM OLD.order_id
         OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
         OR NEW.vendor_user_id IS DISTINCT FROM OLD.vendor_user_id
         OR NEW.reason IS DISTINCT FROM OLD.reason
         OR NEW.evidence IS DISTINCT FROM OLD.evidence
         OR NEW.escrow_kobo IS DISTINCT FROM OLD.escrow_kobo
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'DISPUTE_IMMUTABLE: the complaint and the frozen amount cannot be changed';
      END IF;
      IF OLD.status = 'RESOLVED' THEN
        RAISE EXCEPTION 'DISPUTE_RESOLVED: a resolved dispute is final';
      END IF;
      NEW.updated_at := now();
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `);
  await knex.raw('CREATE TRIGGER disputes_guard_update BEFORE UPDATE ON disputes FOR EACH ROW EXECUTE FUNCTION disputes_guard_update()');

  await knex.raw(`
    CREATE FUNCTION disputes_block_delete() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'DISPUTE_NO_DELETE: disputes are never deleted';
    END $$ LANGUAGE plpgsql
  `);
  await knex.raw('CREATE TRIGGER disputes_block_delete BEFORE DELETE ON disputes FOR EACH ROW EXECUTE FUNCTION disputes_block_delete()');
};

exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS disputes');
  await knex.raw('DROP FUNCTION IF EXISTS disputes_guard_update()');
  await knex.raw('DROP FUNCTION IF EXISTS disputes_block_delete()');
};
