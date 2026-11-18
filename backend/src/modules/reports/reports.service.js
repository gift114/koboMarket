const { db } = require('../../config/postgres');
const { formatNaira } = require('../../utils/money');
const { runAudit } = require('../audit/ledgerAudit.service');
const vendorRepository = require('../vendors/vendor.repository');

/**
 * Admin reports. Every number is computed in SQL (raw queries, aggregated by the database), never
 * by looping over rows in JavaScript. All dates are UTC. Amounts are integer kobo; bigint sums are
 * cast to ::bigint and returned as JavaScript numbers (safe: well below 2^53).
 */
const num = (v) => Number(v);

/**
 * Platform revenue (commission) per day for the last `days` days, including today. Days with no
 * revenue appear with 0. Revenue is NET of reversals: credits minus debits on PLATFORM_REVENUE.
 */
async function revenueByDay(days) {
  const { rows } = await db.raw(
    `WITH day_series AS (
       SELECT d::date AS day
         FROM generate_series((now() AT TIME ZONE 'UTC')::date - (?::int - 1), (now() AT TIME ZONE 'UTC')::date, interval '1 day') AS d
     ),
     revenue AS (
       SELECT (e.created_at AT TIME ZONE 'UTC')::date AS day,
              SUM(CASE e.direction WHEN 'credit' THEN e.amount_kobo ELSE -e.amount_kobo END)::bigint AS revenue_kobo,
              COUNT(DISTINCT e.transaction_id)::int AS transactions
         FROM ledger_entries e
         JOIN accounts a ON a.id = e.account_id
        WHERE a.owner_type = 'SYSTEM' AND a.owner_id = 'PLATFORM_REVENUE'
        GROUP BY 1
     )
     SELECT to_char(s.day, 'YYYY-MM-DD') AS day, COALESCE(r.revenue_kobo, 0)::bigint AS revenue_kobo, COALESCE(r.transactions, 0) AS transactions
       FROM day_series s LEFT JOIN revenue r ON r.day = s.day
      ORDER BY s.day`,
    [days],
  );
  const byDay = rows.map((r) => ({ day: r.day, revenueKobo: num(r.revenue_kobo), revenueDisplay: formatNaira(num(r.revenue_kobo)), transactions: r.transactions }));
  return { days, totalKobo: byDay.reduce((sum, d) => sum + d.revenueKobo, 0), byDay };
}

/** "YYYY-MM" (UTC) -> [start, end) as ISO strings. Defaults to the current month. */
function monthRange(month) {
  const now = new Date();
  const [y, m] = month ? month.split('-').map(Number) : [now.getUTCFullYear(), now.getUTCMonth() + 1];
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return { label: `${y}-${String(m).padStart(2, '0')}`, start: start.toISOString(), end: end.toISOString() };
}

/**
 * The 10 vendors who earned the most in a month (default: this month). Earnings are what was paid
 * into the vendor's wallet by escrow releases and dispute settlements (after commission), read
 * from the ledger transactions' own metadata; reversed transactions do not count.
 */
async function topVendors(month) {
  const range = monthRange(month);
  const { rows } = await db.raw(
    `SELECT s.vendor_id,
            s.vendor_user_id,
            SUM((t.metadata->>'vendorKobo')::bigint)::bigint     AS earned_kobo,
            SUM((t.metadata->>'commissionKobo')::bigint)::bigint AS commission_kobo,
            COUNT(DISTINCT s.id)::int                            AS sub_orders
       FROM transactions t
       JOIN sub_orders s ON s.id = (t.metadata->>'subOrderId')::uuid
      WHERE t.type IN ('ESCROW_RELEASE', 'DISPUTE_RESOLUTION')
        AND t.status = 'POSTED'
        AND t.created_at >= ?::timestamptz AND t.created_at < ?::timestamptz
        AND (t.metadata->>'vendorKobo')::bigint > 0
      GROUP BY s.vendor_id, s.vendor_user_id
      ORDER BY earned_kobo DESC, s.vendor_id
      LIMIT 10`,
    [range.start, range.end],
  );
  const vendors = [];
  for (const [i, r] of rows.entries()) {
    const vendor = await vendorRepository.findById(r.vendor_id);
    vendors.push({
      rank: i + 1,
      vendorId: r.vendor_id,
      storeName: vendor ? vendor.storeName : null,
      earnedKobo: num(r.earned_kobo),
      earnedDisplay: formatNaira(num(r.earned_kobo)),
      commissionKobo: num(r.commission_kobo),
      subOrders: r.sub_orders,
    });
  }
  return { month: range.label, vendors };
}

/** How much money the platform holds in escrow right now, by sub-order status, next to the escrow account's balance. */
async function escrowTotal(trx = db) {
  const { rows: byStatus } = await trx.raw(
    `SELECT status, COUNT(*)::int AS sub_orders, COALESCE(SUM(escrow_held_kobo), 0)::bigint AS escrow_kobo
       FROM sub_orders WHERE escrow_held_kobo > 0 GROUP BY status ORDER BY status`,
  );
  const { rows: [totals] } = await trx.raw(
    `SELECT (SELECT balance_kobo FROM accounts WHERE owner_type = 'SYSTEM' AND owner_id = 'PLATFORM_ESCROW')::bigint AS account_kobo,
            COALESCE((SELECT SUM(escrow_held_kobo) FROM sub_orders), 0)::bigint AS held_kobo,
            COALESCE((SELECT SUM(escrow_held_kobo) FROM sub_orders WHERE status = 'DISPUTED'), 0)::bigint AS disputed_kobo`,
  );
  return {
    escrowAccountKobo: num(totals.account_kobo),
    heldBySubOrdersKobo: num(totals.held_kobo),
    inDisputeKobo: num(totals.disputed_kobo),
    inSync: num(totals.account_kobo) === num(totals.held_kobo),
    totalDisplay: formatNaira(num(totals.account_kobo)),
    byStatus: byStatus.map((r) => ({ status: r.status, subOrders: r.sub_orders, escrowKobo: num(r.escrow_kobo) })),
  };
}

/**
 * Reconciliation: everything the ledger audit looks for, as a list of discrepancies. On a healthy
 * system `discrepancies` is EMPTY (and `ok` is true). Each entry names the broken rule and the
 * offending rows.
 */
async function reconciliation(trx = db) {
  const audit = await runAudit(trx);
  const discrepancies = audit.checks.filter((c) => !c.pass).map((c) => ({ rule: c.name, rows: c.failures }));
  return { ok: discrepancies.length === 0, checksRun: audit.checks.length, discrepancies };
}

module.exports = { revenueByDay, topVendors, escrowTotal, reconciliation };
