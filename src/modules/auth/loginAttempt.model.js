const mongoose = require('mongoose');

// Failed-login counter per (email + IP). `key` is a hash, so no email or IP is stored.
const loginAttemptSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  count: { type: Number, required: true, default: 0 },
  expiresAt: { type: Date, required: true },
});

loginAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.LoginAttempt || mongoose.model('LoginAttempt', loginAttemptSchema);
