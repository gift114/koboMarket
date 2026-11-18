const Vendor = require('./vendor.model');

function toDomain(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    userId: String(doc.userId),
    storeName: doc.storeName,
    description: doc.description || '',
    bankDetails: {
      bankName: doc.bankDetails.bankName,
      accountNumber: doc.bankDetails.accountNumber,
      accountName: doc.bankDetails.accountName,
    },
    status: doc.status,
    reviewedBy: doc.reviewedBy ? String(doc.reviewedBy) : null,
    reviewedAt: doc.reviewedAt || null,
    rejectionReason: doc.rejectionReason || null,
    createdAt: doc.createdAt,
  };
}

async function create(data) {
  const doc = await Vendor.create(data);
  return toDomain(doc.toObject());
}

async function findById(id) {
  return toDomain(await Vendor.findById(id).lean());
}

async function findByUserId(userId) {
  return toDomain(await Vendor.findOne({ userId }).lean());
}

/** Re-application after a rejection. Atomic: only works while the status is still "rejected". */
async function resubmit(userId, data) {
  const doc = await Vendor.findOneAndUpdate(
    { userId, status: 'rejected' },
    { $set: { ...data, status: 'pending', reviewedBy: null, reviewedAt: null, rejectionReason: null } },
    { returnDocument: 'after', runValidators: true },
  ).lean();
  return toDomain(doc);
}

/**
 * Atomic status change: applies `patch` only if the vendor is currently in `fromStatus`.
 * Returns the updated vendor, or null if it was not in that state (someone else got there first).
 */
async function transition(id, fromStatus, patch) {
  const doc = await Vendor.findOneAndUpdate(
    { _id: id, status: fromStatus },
    { $set: patch },
    { returnDocument: 'after' },
  ).lean();
  return toDomain(doc);
}

/** Newest first, cursor = id of the last item of the previous page. */
async function list({ status, limit, cursor }) {
  const filter = {};
  if (status) filter.status = status;
  if (cursor) filter._id = { $lt: cursor };
  const docs = await Vendor.find(filter).sort({ _id: -1 }).limit(limit).lean();
  return docs.map(toDomain);
}

module.exports = { create, findById, findByUserId, resubmit, transition, list };
