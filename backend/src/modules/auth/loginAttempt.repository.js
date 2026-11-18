const LoginAttempt = require('./loginAttempt.model');

async function getActive(key, now) {
  const doc = await LoginAttempt.findOne({ key, expiresAt: { $gt: now } }).lean();
  return doc ? { count: doc.count, expiresAt: doc.expiresAt } : null;
}

/**
 * Count one more failure inside the current window, or start a new window. Every step is a
 * single atomic MongoDB operation, so concurrent failures are all counted.
 */
async function recordFailure(key, windowMs, now) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const expiresAt = new Date(now.getTime() + windowMs);

    // 1. A window is open: add one.
    let doc = await LoginAttempt.findOneAndUpdate(
      { key, expiresAt: { $gt: now } },
      { $inc: { count: 1 } },
      { returnDocument: 'after' },
    ).lean();
    if (doc) return { count: doc.count, expiresAt: doc.expiresAt };

    // 2. An expired window is still lying around (TTL cleanup is not instant): restart it.
    doc = await LoginAttempt.findOneAndUpdate(
      { key, expiresAt: { $lte: now } },
      { $set: { count: 1, expiresAt } },
      { returnDocument: 'after' },
    ).lean();
    if (doc) return { count: doc.count, expiresAt: doc.expiresAt };

    // 3. First failure ever. If another request created it first, loop and increment it.
    try {
      await LoginAttempt.create({ key, count: 1, expiresAt });
      return { count: 1, expiresAt };
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }
  throw new Error('Could not record failed login attempt');
}

async function clear(key) {
  await LoginAttempt.deleteOne({ key });
}

module.exports = { getActive, recordFailure, clear };
