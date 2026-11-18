const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    buyerName: { type: String, required: true, maxlength: 100 }, // snapshot, shown next to the review
    rating: { type: Number, required: true, min: 1, max: 5, validate: { validator: Number.isInteger } },
    title: { type: String, default: '', maxlength: 100 },
    comment: { type: String, default: '', maxlength: 1000 },
  },
  { timestamps: true },
);

// One review per buyer per product, enforced by the database (not just by a check in code).
reviewSchema.index({ productId: 1, buyerId: 1 }, { unique: true });
reviewSchema.index({ productId: 1, _id: -1 });

module.exports = mongoose.models.Review || mongoose.model('Review', reviewSchema);
