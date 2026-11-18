/**
 * orders (parent) -> sub_orders (one per vendor) -> order_items.
 *
 * Money rules enforced by the database, so a bug in the code cannot create a wrong order:
 *   - every amount is integer kobo and > 0; line_total = quantity * unit_price (CHECK);
 *   - sub_order.subtotal = SUM(its items) and order.total = SUM(its sub-orders), verified at
 *     COMMIT by deferred constraint triggers;
 *   - prices, vendors, buyers and amounts can never change after creation;
 *   - status only moves along the allowed transitions (state machine, see below);
 *   - nothing is ever deleted.
 *
 * sub_orders.escrow_held_kobo is the money PLATFORM_ESCROW still holds for that sub-order. The
 * audit checks that these add up to the real escrow account balance.
 *
 * Sub-order states:
 *   PENDING_PAYMENT -> PAID | CANCELLED
 *   PAID      -> SHIPPED | CANCELLED
 *   SHIPPED   -> DELIVERED | DISPUTED | COMPLETED (auto-complete after the timeout)
 *   DELIVERED -> COMPLETED | DISPUTED
 *   DISPUTED  -> COMPLETED | REFUNDED   (admin resolution)
 * Parent order: PENDING_PAYMENT -> PAID | CANCELLED, PAID -> COMPLETED | CANCELLED.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE orders (
      id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      buyer_id               text        NOT NULL,
      idempotency_key        text        NOT NULL,
      status                 text        NOT NULL DEFAULT 'PENDING_PAYMENT',
      total_kobo             bigint      NOT NULL,
      currency               text        NOT NULL DEFAULT 'NGN',
      payment_transaction_id uuid        REFERENCES transactions (id),
      stock_status           text        NOT NULL DEFAULT 'PENDING',
      cancel_reason          text,
      created_at             timestamptz NOT NULL DEFAULT now(),
      updated_at             timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT orders_buyer_key_unique UNIQUE (buyer_id, idempotency_key),
      CONSTRAINT orders_payment_unique UNIQUE (payment_transaction_id),
      CONSTRAINT orders_buyer_chk CHECK (buyer_id ~ '^[a-f0-9]{24}$'),
      CONSTRAINT orders_status_chk CHECK (status IN ('PENDING_PAYMENT', 'PAID', 'COMPLETED', 'CANCELLED')),
      CONSTRAINT orders_stock_status_chk CHECK (stock_status IN ('PENDING', 'RESERVED', 'RELEASED')),
      CONSTRAINT orders_total_chk CHECK (total_kobo > 0),
      CONSTRAINT orders_currency_chk CHECK (currency = 'NGN'),
      CONSTRAINT orders_paid_has_payment_chk CHECK (status = 'PENDING_PAYMENT' OR status = 'CANCELLED' OR payment_transaction_id IS NOT NULL)
    )
  `);
  await knex.raw('CREATE INDEX orders_buyer_idx ON orders (buyer_id, created_at DESC, id DESC)');
  await knex.raw("CREATE INDEX orders_stuck_idx ON orders (created_at) WHERE status = 'PAID' AND stock_status = 'PENDING'");

  await knex.raw(`
    CREATE TABLE sub_orders (
      id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id              uuid        NOT NULL REFERENCES orders (id),
      buyer_id              text        NOT NULL,
      vendor_id             text        NOT NULL,
      vendor_user_id        text        NOT NULL,
      status                text        NOT NULL DEFAULT 'PENDING_PAYMENT',
      subtotal_kobo         bigint      NOT NULL,
      commission_rate_bps   integer     NOT NULL,
      escrow_held_kobo      bigint      NOT NULL DEFAULT 0,
      shipped_at            timestamptz,
      delivered_at          timestamptz,
      completed_at          timestamptz,
      cancelled_at          timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT sub_orders_order_vendor_unique UNIQUE (order_id, vendor_id),
      CONSTRAINT sub_orders_status_chk CHECK (status IN
        ('PENDING_PAYMENT', 'PAID', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'DISPUTED', 'REFUNDED')),
      CONSTRAINT sub_orders_subtotal_chk CHECK (subtotal_kobo > 0),
      CONSTRAINT sub_orders_commission_chk CHECK (commission_rate_bps BETWEEN 0 AND 10000),
      CONSTRAINT sub_orders_escrow_chk CHECK (escrow_held_kobo >= 0 AND escrow_held_kobo <= subtotal_kobo),
      CONSTRAINT sub_orders_ids_chk CHECK (buyer_id ~ '^[a-f0-9]{24}$' AND vendor_id ~ '^[a-f0-9]{24}$' AND vendor_user_id ~ '^[a-f0-9]{24}$')
    )
  `);
  await knex.raw('CREATE INDEX sub_orders_order_idx ON sub_orders (order_id)');
  await knex.raw('CREATE INDEX sub_orders_vendor_idx ON sub_orders (vendor_id, created_at DESC)');
  await knex.raw("CREATE INDEX sub_orders_auto_complete_idx ON sub_orders (shipped_at) WHERE status = 'SHIPPED'");

  await knex.raw(`
    CREATE TABLE order_items (
      id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      sub_order_id       uuid        NOT NULL REFERENCES sub_orders (id),
      product_id         text        NOT NULL,
      variant_id         text,
      name               text        NOT NULL,
      quantity           integer     NOT NULL,
      unit_price_kobo    bigint      NOT NULL,
      line_total_kobo    bigint      NOT NULL,
      stock_decremented  boolean     NOT NULL DEFAULT false,
      stock_restored     boolean     NOT NULL DEFAULT false,
      created_at         timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT order_items_quantity_chk CHECK (quantity > 0 AND quantity <= 99),
      CONSTRAINT order_items_price_chk CHECK (unit_price_kobo > 0),
      CONSTRAINT order_items_line_total_chk CHECK (line_total_kobo = quantity::bigint * unit_price_kobo),
      CONSTRAINT order_items_ids_chk CHECK (product_id ~ '^[a-f0-9]{24}$' AND (variant_id IS NULL OR variant_id ~ '^[a-f0-9]{24}$')),
      CONSTRAINT order_items_restored_chk CHECK (NOT stock_restored OR stock_decremented)
    )
  `);
  await knex.raw('CREATE INDEX order_items_sub_order_idx ON order_items (sub_order_id)');
  await knex.raw('CREATE INDEX order_items_product_idx ON order_items (product_id)');

  // ---- immutability and the state machine -------------------------------------------------
  await knex.raw(`
    CREATE FUNCTION orders_guard_update() RETURNS trigger AS $$
    BEGIN
      IF NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
         OR NEW.total_kobo IS DISTINCT FROM OLD.total_kobo
         OR NEW.currency IS DISTINCT FROM OLD.currency
         OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
        RAISE EXCEPTION 'ORDER_IMMUTABLE: buyer, total, currency and idempotency key cannot be changed';
      END IF;
      IF OLD.payment_transaction_id IS NOT NULL AND NEW.payment_transaction_id IS DISTINCT FROM OLD.payment_transaction_id THEN
        RAISE EXCEPTION 'ORDER_IMMUTABLE: the payment transaction cannot be changed';
      END IF;
      IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
           (OLD.status = 'PENDING_PAYMENT' AND NEW.status IN ('PAID', 'CANCELLED'))
        OR (OLD.status = 'PAID' AND NEW.status IN ('COMPLETED', 'CANCELLED'))
      ) THEN
        RAISE EXCEPTION 'ORDER_INVALID_TRANSITION: cannot move an order from % to %', OLD.status, NEW.status;
      END IF;
      NEW.updated_at := now();
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `);
  await knex.raw('CREATE TRIGGER orders_guard_update BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION orders_guard_update()');

  await knex.raw(`
    CREATE FUNCTION sub_orders_guard_update() RETURNS trigger AS $$
    BEGIN
      IF NEW.order_id IS DISTINCT FROM OLD.order_id
         OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
         OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
         OR NEW.vendor_user_id IS DISTINCT FROM OLD.vendor_user_id
         OR NEW.subtotal_kobo IS DISTINCT FROM OLD.subtotal_kobo
         OR NEW.commission_rate_bps IS DISTINCT FROM OLD.commission_rate_bps THEN
        RAISE EXCEPTION 'SUB_ORDER_IMMUTABLE: order, buyer, vendor, subtotal and commission rate cannot be changed';
      END IF;
      IF NEW.escrow_held_kobo > OLD.escrow_held_kobo AND NOT (OLD.status = 'PENDING_PAYMENT' AND NEW.status = 'PAID') THEN
        RAISE EXCEPTION 'SUB_ORDER_ESCROW_INCREASE: held escrow can only go down (it is set once, when the order is paid)';
      END IF;
      IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
           (OLD.status = 'PENDING_PAYMENT' AND NEW.status IN ('PAID', 'CANCELLED'))
        OR (OLD.status = 'PAID'      AND NEW.status IN ('SHIPPED', 'CANCELLED'))
        OR (OLD.status = 'SHIPPED'   AND NEW.status IN ('DELIVERED', 'DISPUTED', 'COMPLETED'))
        OR (OLD.status = 'DELIVERED' AND NEW.status IN ('COMPLETED', 'DISPUTED'))
        OR (OLD.status = 'DISPUTED'  AND NEW.status IN ('COMPLETED', 'REFUNDED'))
      ) THEN
        RAISE EXCEPTION 'SUB_ORDER_INVALID_TRANSITION: cannot move a sub-order from % to %', OLD.status, NEW.status;
      END IF;
      NEW.updated_at := now();
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `);
  await knex.raw('CREATE TRIGGER sub_orders_guard_update BEFORE UPDATE ON sub_orders FOR EACH ROW EXECUTE FUNCTION sub_orders_guard_update()');

  await knex.raw(`
    CREATE FUNCTION order_items_guard_update() RETURNS trigger AS $$
    BEGIN
      IF NEW.sub_order_id IS DISTINCT FROM OLD.sub_order_id
         OR NEW.product_id IS DISTINCT FROM OLD.product_id
         OR NEW.variant_id IS DISTINCT FROM OLD.variant_id
         OR NEW.name IS DISTINCT FROM OLD.name
         OR NEW.quantity IS DISTINCT FROM OLD.quantity
         OR NEW.unit_price_kobo IS DISTINCT FROM OLD.unit_price_kobo
         OR NEW.line_total_kobo IS DISTINCT FROM OLD.line_total_kobo THEN
        RAISE EXCEPTION 'ORDER_ITEM_IMMUTABLE: only the stock flags of an order item can change';
      END IF;
      IF (OLD.stock_decremented AND NOT NEW.stock_decremented) OR (OLD.stock_restored AND NOT NEW.stock_restored) THEN
        RAISE EXCEPTION 'ORDER_ITEM_IMMUTABLE: stock flags only move forward';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `);
  await knex.raw('CREATE TRIGGER order_items_guard_update BEFORE UPDATE ON order_items FOR EACH ROW EXECUTE FUNCTION order_items_guard_update()');

  for (const table of ['orders', 'sub_orders', 'order_items']) {
    await knex.raw(`
      CREATE FUNCTION ${table}_block_delete() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'ORDER_UNDELETABLE: ${table} rows are never deleted (audit trail)'; END $$ LANGUAGE plpgsql
    `);
    await knex.raw(`CREATE TRIGGER ${table}_block_delete BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${table}_block_delete()`);
  }

  // ---- totals must add up, checked at COMMIT -----------------------------------------------
  await knex.raw(`
    CREATE FUNCTION sub_orders_check_items() RETURNS trigger AS $$
    DECLARE v_sum bigint;
    BEGIN
      SELECT COALESCE(SUM(line_total_kobo), 0) INTO v_sum FROM order_items WHERE sub_order_id = NEW.id;
      IF v_sum <> NEW.subtotal_kobo THEN
        RAISE EXCEPTION 'ORDER_TOTAL_MISMATCH: sub-order % subtotal % does not equal the sum of its items %', NEW.id, NEW.subtotal_kobo, v_sum;
      END IF;
      RETURN NULL;
    END $$ LANGUAGE plpgsql
  `);
  await knex.raw(`
    CREATE CONSTRAINT TRIGGER sub_orders_check_items AFTER INSERT ON sub_orders
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sub_orders_check_items()
  `);
  await knex.raw(`
    CREATE FUNCTION orders_check_sub_orders() RETURNS trigger AS $$
    DECLARE v_sum bigint;
    BEGIN
      SELECT COALESCE(SUM(subtotal_kobo), 0) INTO v_sum FROM sub_orders WHERE order_id = NEW.id;
      IF v_sum <> NEW.total_kobo THEN
        RAISE EXCEPTION 'ORDER_TOTAL_MISMATCH: order % total % does not equal the sum of its sub-orders %', NEW.id, NEW.total_kobo, v_sum;
      END IF;
      RETURN NULL;
    END $$ LANGUAGE plpgsql
  `);
  await knex.raw(`
    CREATE CONSTRAINT TRIGGER orders_check_sub_orders AFTER INSERT ON orders
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orders_check_sub_orders()
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS order_items');
  await knex.raw('DROP TABLE IF EXISTS sub_orders');
  await knex.raw('DROP TABLE IF EXISTS orders');
  for (const fn of [
    'orders_guard_update', 'sub_orders_guard_update', 'order_items_guard_update',
    'orders_block_delete', 'sub_orders_block_delete', 'order_items_block_delete',
    'sub_orders_check_items', 'orders_check_sub_orders',
  ]) {
    await knex.raw(`DROP FUNCTION IF EXISTS ${fn}()`);
  }
};
