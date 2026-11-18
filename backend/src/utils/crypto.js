const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');

/** SHA-256 hex. Used to store tokens at rest: a database leak must not leak usable tokens. */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Unguessable URL-safe token (256 bits). The raw value is only ever sent to the user. */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashPassword(plain) {
  return bcrypt.hash(plain, config.auth.bcryptRounds);
}

function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// Compared against when the email is unknown, so "no such user" and "wrong password" take
// the same time and cannot be told apart by timing.
let dummyHashPromise;
async function verifyAgainstDummy(plain) {
  if (!dummyHashPromise) dummyHashPromise = hashPassword(randomToken());
  await bcrypt.compare(plain, await dummyHashPromise);
}

module.exports = { sha256, randomToken, hashPassword, verifyPassword, verifyAgainstDummy };
