const mongoose = require('mongoose');

const NOTIFICATION_TYPES = [
  'ORDER_PLACED',
  'NEW_ORDER',
  'ORDER_SHIPPED',
  'FUNDS_RELEASED',
  'DISPUTE_OPENED',
  'DISPUTE_NEEDS_REVIEW',
  'DISPUTE_RESOLVED',
  'PAYOUT_SUCCESS',
  'PAYOUT_FAILED',
];

// An in-app notification for one user. `dedupeKey` makes creation idempotent: the same event
// delivered twice produces one notification.
const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true, maxlength: 120 },
    message: { type: String, required: true, maxlength: 500 },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    dedupeKey: { type: String, required: true },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

notificationSchema.index({ userId: 1, _id: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });
notificationSchema.index({ userId: 1, dedupeKey: 1 }, { unique: true });

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;
