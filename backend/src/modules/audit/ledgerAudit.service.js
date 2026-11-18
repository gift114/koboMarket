const { db: defaultDb } = require('../../config/postgres');
const { SYSTEM_ACCOUNT } = require('../../db/constants');

/**
 * Ledger audit. Re-derives every number from the raw ledger_entries rows and compares it with
 * what the rest of the system claims. Read-only; safe to run against production at any time.
 *
 * The headline invariant (from the brief):
 *   SUM(all user wallets) + ESCROW + REVENUE + PAYOUT_CLEARING = total funded - total paid out
 * where "funded" / "paid out" are the net flows through PLATFORM_EXTERNAL (the outside world).
 */

const check = (name, failures, extra = {}) => ({ name, pass: failures.length === 0, failures, ...extra });

async function runAudit(db = defaultDb) {
  const checks = [];

  // 1. Global conservation of money.
  const { rows: [flow] } = await db.raw(
    `SELECT
       COALESCE(SUM(e.amount_kobo) FILTER (WHERE a.is_external AND e.direction = 'debit'), 0)::bigint  AS funded,
       COALESCE(SUM(e.amount_kobo) FILTER (WHERE a.is_external AND e.direction = 'credit'), 0)::bigint AS paid_out,
       COALESCE(SUM(CASE e.direction WHEN 'credit' THEN e.amount_kobo ELSE -e.amount_kobo END)
                FILTER (WHERE NOT a.is_external), 0)::bigint AS held
     FROM ledger_entries e
     JOIN (SELECT id, (owner_type = 'SYSTEM' AND owner_id = ?) AS is_external FROM accounts) a ON a.id = e.account_id`,
    [SYSTEM_ACCOUNT.EXTERNAL],
  );
  const funded = Number(flow.funded);
  const paidOut = Number(flow.paid_out);
  const held = Number(flow.held);
  checks.push(
    check(
      'Money held (user wallets + escrow + revenue + payout clearing) = funded - paid out',
      held === funded - paidOut ? [] : [{ heldKobo: held, fundedKobo: funded, paidOutKobo: paidOut, differenceKobo: held - (funded - paidOut) }],
    ),
  );

  // 2. Every account: cached balance == balance recomputed from its entries.
  const { rows: drift } = await db.raw(
    `SELECT account_id, owner_type, owner_id, cached_balance_kobo, ledger_balance_kobo
       FROM account_reconciliation WHERE cached_balance_kobo <> ledger_balance_kobo`,
  );
  checks.push(check('Every account balance matches the sum of its ledger entries', drift));

  // 3. Every transaction balances (debits = credits) and has at least two entries.
  const { rows: unbalanced } = await db.raw(
    `SELECT t.id, t.reference,
            COALESCE(SUM(e.amount_kobo) FILTER (WHERE e.direction = 'debit'), 0)::bigint  AS debits,
            COALESCE(SUM(e.amount_kobo) FILTER (WHERE e.direction = 'credit'), 0)::bigint AS credits,
            COUNT(e.id)::int AS entries
       FROM transactions t LEFT JOIN ledger_entries e ON e.transaction_id = t.id
      WHERE t.status IN ('POSTED', 'REVERSED')
      GROUP BY t.id
     HAVING COALESCE(SUM(e.amount_kobo) FILTER (WHERE e.direction = 'debit'), 0)
         <> COALESCE(SUM(e.amount_kobo) FILTER (WHERE e.direction = 'credit'), 0)
         OR COUNT(e.id) < 2`,
  );
  checks.push(check('Every posted transaction has debits = credits and at least two entries', unbalanced));

  // 4. Ledger entries only ever belong to POSTED / REVERSED transactions.
  const { rows: orphans } = await db.raw(
    `SELECT DISTINCT t.id, t.reference, t.status FROM ledger_entries e
       JOIN transactions t ON t.id = e.transaction_id WHERE t.status NOT IN ('POSTED', 'REVERSED')`,
  );
  checks.push(check('No ledger entries belong to a pending or failed transaction', orphans));

  // 5. Nobody (except the outside world) is overdrawn.
  const { rows: negative } = await db.raw(
    `SELECT id AS account_id, owner_type, owner_id, balance_kobo FROM accounts
      WHERE balance_kobo < 0 AND NOT (owner_type = 'SYSTEM' AND owner_id = ?)`,
    [SYSTEM_ACCOUNT.EXTERNAL],
  );
  checks.push(check('No account has a negative balance (except PLATFORM_EXTERNAL)', negative));

  // 6. Reversal bookkeeping is consistent in both directions.
  const { rows: badReversals } = await db.raw(
    `SELECT t.id, t.reference, t.status FROM transactions t
      WHERE (t.status = 'REVERSED'
             AND (SELECT COUNT(*) FROM transactions r WHERE r.reverses_transaction_id = t.id) <> 1)
         OR (t.type = 'REVERSAL' AND t.status = 'POSTED'
             AND NOT EXISTS (SELECT 1 FROM transactions o WHERE o.id = t.reverses_transaction_id AND o.status = 'REVERSED'))`,
  );
  checks.push(check('Every REVERSED transaction has exactly one reversal, and every reversal points at a REVERSED one', badReversals));

  // 7. Every credited top-up is backed by a WALLET_FUNDING ledger transaction of the same amount.
  const { rows: badPayments } = await db.raw(
    `SELECT p.id, p.reference, p.amount_kobo, t.type AS ledger_type,
            COALESCE(SUM(e.amount_kobo) FILTER (WHERE e.direction = 'credit'), 0)::bigint AS credited_kobo
       FROM payments p
       LEFT JOIN transactions t ON t.id = p.ledger_transaction_id
       LEFT JOIN ledger_entries e ON e.transaction_id = t.id
      WHERE p.status = 'SUCCEEDED'
      GROUP BY p.id, t.type
     HAVING t.type IS DISTINCT FROM 'WALLET_FUNDING'
         OR COALESCE(SUM(e.amount_kobo) FILTER (WHERE e.direction = 'credit'), 0) <> p.amount_kobo`,
  );
  checks.push(check('Every successful top-up payment is backed by a WALLET_FUNDING transaction of the same amount', badPayments));

  // 8. PLATFORM_ESCROW holds exactly the money still owed for open sub-orders.
  const { rows: [escrow] } = await db.raw(
    `SELECT (SELECT balance_kobo FROM accounts WHERE owner_type = 'SYSTEM' AND owner_id = ?)::bigint AS balance,
            (SELECT COALESCE(SUM(escrow_held_kobo), 0) FROM sub_orders)::bigint AS held`,
    [SYSTEM_ACCOUNT.ESCROW],
  );
  checks.push(
    check(
      'PLATFORM_ESCROW balance equals the escrow still held for open sub-orders',
      Number(escrow.balance) === Number(escrow.held) ? [] : [{ escrowBalanceKobo: Number(escrow.balance), heldBySubOrdersKobo: Number(escrow.held) }],
    ),
  );

  // 9. Disputes agree with the sub-orders and the ledger: an OPEN dispute <=> a DISPUTED sub-order
  //    still holding exactly the frozen amount; a RESOLVED one was settled by a DISPUTE_RESOLUTION
  //    transaction that debited escrow by exactly that amount, and the sub-order holds nothing.
  const { rows: badDisputes } = await db.raw(
    `SELECT d.id, d.status, s.status AS sub_order_status, s.escrow_held_kobo, d.escrow_kobo
       FROM disputes d
       JOIN sub_orders s ON s.id = d.sub_order_id
       LEFT JOIN transactions t ON t.id = d.resolution_transaction_id
      WHERE (d.status = 'OPEN' AND (s.status <> 'DISPUTED' OR s.escrow_held_kobo <> d.escrow_kobo))
         OR (d.status = 'RESOLVED' AND (
               s.escrow_held_kobo <> 0
            OR t.type IS DISTINCT FROM 'DISPUTE_RESOLUTION'
            OR (SELECT COALESCE(SUM(e.amount_kobo), 0) FROM ledger_entries e
                  JOIN accounts a ON a.id = e.account_id
                 WHERE e.transaction_id = t.id AND e.direction = 'debit'
                   AND a.owner_type = 'SYSTEM' AND a.owner_id = ?) <> d.escrow_kobo))
     UNION ALL
     SELECT s.id, 'NO_DISPUTE', s.status, s.escrow_held_kobo, NULL
       FROM sub_orders s
      WHERE s.status = 'DISPUTED' AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.sub_order_id = s.id AND d.status = 'OPEN')`,
    [SYSTEM_ACCOUNT.ESCROW],
  );
  checks.push(check('Every dispute matches its sub-order and the ledger entries that settled it', badDisputes));

  // 10. Payouts agree with the ledger: PLATFORM_PAYOUT_CLEARING holds exactly the PENDING payouts,
  //     and each payout's request / settlement / reversal transaction has the right type and moves
  //     exactly the payout amount through the clearing account.
  const { rows: [clearing] } = await db.raw(
    `SELECT (SELECT balance_kobo FROM accounts WHERE owner_type = 'SYSTEM' AND owner_id = ?)::bigint AS balance,
            (SELECT COALESCE(SUM(amount_kobo), 0) FROM payouts WHERE status = 'PENDING')::bigint AS pending`,
    [SYSTEM_ACCOUNT.PAYOUT_CLEARING],
  );
  checks.push(
    check(
      'PLATFORM_PAYOUT_CLEARING holds exactly the money of PENDING payouts',
      Number(clearing.balance) === Number(clearing.pending) ? [] : [{ clearingBalanceKobo: Number(clearing.balance), pendingPayoutsKobo: Number(clearing.pending) }],
    ),
  );

  const { rows: badPayouts } = await db.raw(
    `WITH legs AS (
       SELECT p.id, p.status, p.amount_kobo,
              rt.type AS req_type, st.type AS settle_type, vt.type AS rev_type,
              (SELECT COALESCE(SUM(e.amount_kobo), 0) FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
                WHERE e.transaction_id = p.request_transaction_id AND e.direction = 'credit' AND a.owner_type = 'SYSTEM' AND a.owner_id = :clearing) AS req_in,
              (SELECT COALESCE(SUM(e.amount_kobo), 0) FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
                WHERE e.transaction_id = p.settlement_transaction_id AND e.direction = 'debit' AND a.owner_type = 'SYSTEM' AND a.owner_id = :clearing) AS settle_out,
              (SELECT COALESCE(SUM(e.amount_kobo), 0) FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
                WHERE e.transaction_id = p.reversal_transaction_id AND e.direction = 'debit' AND a.owner_type = 'SYSTEM' AND a.owner_id = :clearing) AS rev_out
         FROM payouts p
         JOIN transactions rt ON rt.id = p.request_transaction_id
         LEFT JOIN transactions st ON st.id = p.settlement_transaction_id
         LEFT JOIN transactions vt ON vt.id = p.reversal_transaction_id)
     SELECT id, status, amount_kobo FROM legs
      WHERE req_type <> 'PAYOUT_REQUEST' OR req_in <> amount_kobo
         OR (status = 'SUCCESS' AND (settle_type IS DISTINCT FROM 'PAYOUT_SETTLEMENT' OR settle_out <> amount_kobo))
         OR (status = 'FAILED'  AND (rev_type IS DISTINCT FROM 'PAYOUT_REVERSAL' OR rev_out <> amount_kobo))`,
    { clearing: SYSTEM_ACCOUNT.PAYOUT_CLEARING },
  );
  checks.push(check('Every payout is backed by ledger transactions of the right type and amount', badPayouts));

  const { rows: [counts] } = await db.raw(
    `SELECT (SELECT COUNT(*) FROM accounts)::int AS accounts,
            (SELECT COUNT(*) FROM transactions)::int AS transactions,
            (SELECT COUNT(*) FROM ledger_entries)::int AS entries`,
  );

  return {
    pass: checks.every((c) => c.pass),
    checks,
    totals: { fundedKobo: funded, paidOutKobo: paidOut, heldKobo: held, ...counts },
  };
}

module.exports = { runAudit };
