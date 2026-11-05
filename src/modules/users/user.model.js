const mongoose = require('mongoose');

const ROLES = ['buyer', 'vendor', 'admin'];
const USER_STATUS = ['active', 'frozen'];

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    // select:false so the hash never leaks into a query result by accident.
    passwordHash: { type: String, required: true, select: false },
    fullName: { type: String, required: true, trim: true, maxlength: 100 },
    phone: { type: String, trim: true, maxlength: 20 },

    // A user can be both buyer and vendor. Authorisation reads this array (via RBAC middleware).
    roles: { type: [String], enum: ROLES, default: ['buyer'] },
    // Frozen users can log in but cannot place orders or withdraw (enforced in those services).
    status: { type: String, enum: USER_STATUS, default: 'active' },

    emailVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date },

    // Embedded in every access token. Bumping it instantly invalidates all outstanding access
    // tokens (password reset, refresh-token reuse).
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
module.exports.ROLES = ROLES;
module.exports.USER_STATUS = USER_STATUS;
