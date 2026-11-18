// Three views of a vendor, from least to most revealing. Full bank account numbers are never
// returned by any endpoint; payouts read them straight from the database.
const maskAccountNumber = (n) => `******${n.slice(-4)}`;

function toPublicStore(v) {
  return { id: v.id, storeName: v.storeName, description: v.description, createdAt: v.createdAt };
}

function toOwnerView(v) {
  return {
    id: v.id,
    storeName: v.storeName,
    description: v.description,
    status: v.status,
    rejectionReason: v.rejectionReason,
    bankDetails: {
      bankName: v.bankDetails.bankName,
      accountNumberMasked: maskAccountNumber(v.bankDetails.accountNumber),
      accountName: v.bankDetails.accountName,
    },
    reviewedAt: v.reviewedAt,
    createdAt: v.createdAt,
  };
}

function toAdminView(v) {
  return { ...toOwnerView(v), userId: v.userId, reviewedBy: v.reviewedBy };
}

module.exports = { toPublicStore, toOwnerView, toAdminView, maskAccountNumber };
