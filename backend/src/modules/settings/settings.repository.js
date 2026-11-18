const { db } = require('../../config/postgres');

async function get(key, trx = db) {
  const row = await trx('platform_settings').where({ key }).first();
  return row ? { key: row.key, value: row.value, updatedBy: row.updated_by, updatedAt: row.updated_at } : null;
}

/** Upsert a setting and append to the history in ONE transaction. */
async function set(key, value, adminId) {
  return db.transaction(async (trx) => {
    const old = await trx('platform_settings').where({ key }).forUpdate().first();
    await trx('platform_settings')
      .insert({ key, value: JSON.stringify(value), updated_by: adminId })
      .onConflict('key')
      .merge({ value: JSON.stringify(value), updated_by: adminId, updated_at: trx.fn.now() });
    await trx('platform_setting_changes').insert({
      key,
      old_value: old ? JSON.stringify(old.value) : null,
      new_value: JSON.stringify(value),
      changed_by: adminId,
    });
    return get(key, trx);
  });
}

async function history(key, limit = 20) {
  const rows = await db('platform_setting_changes').where({ key }).orderBy('id', 'desc').limit(limit);
  return rows.map((r) => ({ oldValue: r.old_value, newValue: r.new_value, changedBy: r.changed_by, changedAt: r.changed_at }));
}

module.exports = { get, set, history };
