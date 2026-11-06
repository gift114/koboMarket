const mongoose = require('mongoose');

const VENDOR_STATUS = ['pending', 'approved', 'rejected'];

// A vendor application / store. One per user. Status moves pending -> approved | rejected,
// and rejected -> pending when the user re-applies. Only an admin can approve or reject.
const vendorSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

    storeName: { type: String, required: true, trim: true, maxlength: 80 },
    // Lower-cased, whitespace-collapsed copy of storeName: makes names unique case-insensitively.
    storeNameKey: { type: String, required: true, unique: true },
    description: { type: String, default: '', maxlength: 1000 },

    // Where payouts are sent (Module H). Never returned in full by the API.
    bankDetails: {
      bankName: { type: String, required: true, trim: true, maxlength: 60 },
      accountNumber: { type: String, required: true, match: /^\d{10}$/ },
      accountName: { type: String, required: true, trim: true, maxlength: 100 },
    },

    status: { type: String, enum: VENDOR_STATUS, default: 'pending', index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    rejectionReason: { type: String, maxlength: 300 },
  },
  { timestamps: true },
);

module.exports = mongoose.models.Vendor || mongoose.model('Vendor', vendorSchema);
module.exports.VENDOR_STATUS = VENDOR_STATUS;
