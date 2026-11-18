const mongoose = require('mongoose');

const kobo = {
  type: Number,
  required: true,
  min: 1,
  validate: { validator: Number.isSafeInteger, message: 'must be an integer number of kobo' },
};
const stockField = {
  type: Number,
  required: true,
  min: 0,
  default: 0,
  validate: { validator: Number.isSafeInteger, message: 'must be a whole number' },
};

// A purchasable option (size / colour ...). Each has its own price and stock. The _id is
// stable so carts and orders can refer to a variant (Days 8-10).
const variantSchema = new mongoose.Schema(
  {
    sku: { type: String, trim: true, maxlength: 60 },
    attributes: { type: Object, default: {} }, // e.g. { size: "M", colour: "red" }
    priceKobo: kobo,
    stock: stockField,
  },
  { _id: true },
);

const productSchema = new mongoose.Schema(
  {
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
    // The vendor's user id: whose wallet is paid when an order completes (Day 10).
    vendorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, unique: true },
    description: { type: String, default: '', maxlength: 5000 },
    category: { type: String, required: true, trim: true, lowercase: true, maxlength: 40 },
    images: { type: [String], default: [] },
    tags: { type: [String], default: [] },

    // Integer kobo. With variants this is the LOWEST variant price ("from" price), and stock is
    // the SUM of variant stock; both are derived by the service, never trusted from the client.
    priceKobo: kobo,
    stock: stockField,
    variants: { type: [variantSchema], default: [] },

    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null }, // soft delete: the row stays for order history

    // Rating aggregate, maintained atomically by the review service. ratingAvg is derived
    // from the two integers so it can never drift from them.
    ratingSum: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    ratingAvg: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Full-text search on name (weighted higher) and description.
productSchema.index({ name: 'text', description: 'text' }, { weights: { name: 10, description: 1 }, name: 'product_text' });
// Listing / sorting / filtering. _id is the tie-breaker that makes cursors stable.
productSchema.index({ deletedAt: 1, isActive: 1, createdAt: -1, _id: -1 });
productSchema.index({ deletedAt: 1, isActive: 1, priceKobo: 1, _id: 1 });
productSchema.index({ deletedAt: 1, isActive: 1, ratingAvg: -1, _id: -1 });
productSchema.index({ deletedAt: 1, isActive: 1, category: 1 });
productSchema.index({ vendorId: 1, deletedAt: 1 });

module.exports = mongoose.models.Product || mongoose.model('Product', productSchema);
