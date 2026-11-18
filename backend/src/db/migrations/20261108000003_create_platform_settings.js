/**
 * platform_settings: values an admin can change at runtime (today: the commission rate).
 * platform_setting_changes: an append-only history (who changed what, from what to what), so a
 * rate change can always be explained. The history can never be edited or deleted.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE platform_settings (
      key        text        PRIMARY KEY,
      value      jsonb       NOT NULL,
      updated_by text        NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT platform_settings_key_chk CHECK (key IN ('commission_rate_bps')),
      CONSTRAINT platform_settings_commission_chk CHECK (
        key <> 'commission_rate_bps' OR (
          jsonb_typeof(value) = 'number'
          AND CASE WHEN (value #>> '{}') ~ '^[0-9]{1,4}$' THEN (value #>> '{}')::int <= 5000 ELSE false END
        )
      )
    )
  `);
  await knex.raw(`
    CREATE TABLE platform_setting_changes (
      id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      key        text        NOT NULL,
      old_value  jsonb,
      new_value  jsonb       NOT NULL,
      changed_by text        NOT NULL,
      changed_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`
    CREATE FUNCTION platform_setting_changes_append_only() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'SETTINGS_HISTORY_APPEND_ONLY: the settings history cannot be changed or deleted';
    END $$ LANGUAGE plpgsql
  `);
  await knex.raw(`
    CREATE TRIGGER platform_setting_changes_append_only BEFORE UPDATE OR DELETE ON platform_setting_changes
    FOR EACH ROW EXECUTE FUNCTION platform_setting_changes_append_only()
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS platform_setting_changes');
  await knex.raw('DROP TABLE IF EXISTS platform_settings');
  await knex.raw('DROP FUNCTION IF EXISTS platform_setting_changes_append_only()');
};
