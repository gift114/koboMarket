const mongoose = require('mongoose');

// One cart per user. The cart stores WHAT and HOW MANY, plus the price the buyer saw when
// adding it. That price is only a snapshot for "the price changed" warnings: checkout always
// charges the product's CURRENT price (see cart.service prepareCheckout).
const itemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    quantity: { type: Number, required: true, min: 1, max: 99, validate: { validator: Number.isInteger } },
    priceKobo: { type: Number, required: true, min: 1, validate: { validator: Number.isSafeInteger } },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const cartSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    items: { type: [itemSchema], default: [] },
    // Optimistic-concurrency counter: a write succeeds only if nobody changed the cart since it was read.
    rev: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.models.Cart || mongoose.model('Cart', cartSchema);
