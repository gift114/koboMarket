const mongoose = require('mongoose');

const AUTH_TOKEN_TYPES = ['email_verification', 'password_reset'];

// One-time, time-limited tokens (email verification, password reset). Stored hashed.
const authTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: AUTH_TOKEN_TYPES, required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.AuthToken || mongoose.model('AuthToken', authTokenSchema);
module.exports.AUTH_TOKEN_TYPES = AUTH_TOKEN_TYPES;
