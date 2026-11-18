const { db } = require('../../config/postgres');

const fromRow = (r) => ({
  id: r.id,
  subOrderId: r.sub_order_id,
  orderId: r.order_id,
  buyerId: r.buyer_id,
  vendorUserId: r.vendor_user_id,
  reason: r.reason,
  evidence: r.evidence,
  escrowKobo: Number(r.escrow_kobo),
  status: r.status,
  resolution: r.resolution,
  refundKobo: r.refund_kobo === null ? null : Number(r.refund_kobo),
  vendorGrossKobo: r.vendor_gross_kobo === null ? null : Number(r.vendor_gross_kobo),
  commissionKobo: r.commission_kobo === null ? null : Number(r.commission_kobo),
  resolvedBy: r.resolved_by,
  resolutionNote: r.resolution_note,
  resolutionTransactionId: r.resolution_transaction_id,
  resolvedAt: r.resolved_at,
  createdAt: r.created_at,
});

async function insert(trx, { subOrder, reason, evidence }) {
  const [row] = await trx('disputes')
    .insert({
      sub_order_id: subOrder.id,
      order_id: subOrder.orderId,
      buyer_id: subOrder.buyerId,
      vendor_user_id: subOrder.vendorUserId,
      reason,
      evidence: JSON.stringify(evidence),
      escrow_kobo: subOrder.escrowHeldKobo,
    })
    .returning('*');
  return fromRow(row);
}

async function findById(id, trx = db) {
  const row = await trx('disputes').where({ id }).first();
  return row ? fromRow(row) : null;
}

async function lockById(trx, id) {
  const row = await trx('disputes').where({ id }).forUpdate().first();
  return row ? fromRow(row) : null;
}

async function markResolved(trx, id, r) {
  await trx('disputes').where({ id }).update({
    status: 'RESOLVED',
    resolution: r.resolution,
    refund_kobo: r.refundKobo,
    vendor_gross_kobo: r.vendorGrossKobo,
    commission_kobo: r.commissionKobo,
    resolved_by: r.resolvedBy,
    resolution_note: r.note,
    resolution_transaction_id: r.transactionId,
    resolved_at: trx.fn.now(),
  });
}

/** Admins see every dispute; anyone else only those where they are the buyer or the vendor. Newest first; cursor = (created_at, id). */
async function list({ userId, isAdmin, status, limit, cursor }) {
  const query = db('disputes');
  if (!isAdmin) query.where((q) => q.where({ buyer_id: userId }).orWhere({ vendor_user_id: userId }));
  if (status) query.where({ status });
  if (cursor) query.whereRaw('(created_at, id) < (?::timestamptz, ?::uuid)', [cursor.createdAt, cursor.id]);
  const rows = await query.orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(limit);
  return rows.map(fromRow);
}

module.exports = { insert, findById, lockById, markResolved, list };
