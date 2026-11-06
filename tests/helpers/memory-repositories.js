/**
 * In-memory stand-ins for the MongoDB repositories (same function names, same return shapes,
 * same atomic-claim semantics). They let the HTTP test suite run where no MongoDB is
 * available. They are NOT a substitute for running the suite against real MongoDB
 * (TEST_BACKEND unset), which is what `docker-compose` + `npm test` does.
 *
 * Each "atomic" operation is a synchronous check-and-set inside an async function, so two
 * concurrent callers can never both win, mirroring a single findOneAndUpdate in MongoDB.
 */
const crypto = require('crypto');
const config = require('../../src/config');

const newId = () => crypto.randomBytes(12).toString('hex');
const dupKeyError = (keyPattern = {}) =>
  Object.assign(new Error('E11000 duplicate key error'), { code: 11000, keyPattern });

const store = {
  users: new Map(),
  refreshTokens: new Map(), // tokenHash -> record
  authTokens: new Map(), // tokenHash -> record
  loginAttempts: new Map(), // key -> record
  vendors: new Map(), // id -> record
};

function reset() {
  Object.values(store).forEach((m) => m.clear());
}

// ------------------------------------------------------------------ users
function publicUser(record, withPassword = false) {
  if (!record) return null;
  const { passwordHash, ...rest } = record;
  return withPassword ? { ...rest, passwordHash } : { ...rest };
}

const userRepository = {
  async findByEmail(email, { withPassword = false } = {}) {
    const record = [...store.users.values()].find((u) => u.email === email);
    return publicUser(record, withPassword);
  },
  async findById(id) {
    return publicUser(store.users.get(id));
  },
  async create(data) {
    if ([...store.users.values()].some((u) => u.email === data.email)) throw dupKeyError();
    const record = {
      id: newId(),
      email: data.email,
      passwordHash: data.passwordHash,
      fullName: data.fullName,
      phone: data.phone || null,
      roles: data.roles || ['buyer'],
      status: 'active',
      emailVerified: false,
      emailVerifiedAt: null,
      tokenVersion: 0,
      walletStatus: 'pending',
      walletAttempts: 0,
      walletNextAttemptAt: new Date(Date.now() + config.walletProvisioning.graceSeconds * 1000),
      createdAt: new Date(),
    };
    store.users.set(record.id, record);
    return publicUser(record);
  },
  async addRole(id, role) {
    const u = store.users.get(id);
    if (!u.roles.includes(role)) u.roles = [...u.roles, role];
  },
  async markWalletReady(id) {
    store.users.get(id).walletStatus = 'ready';
  },
  async incrementWalletAttempts(id) {
    const u = store.users.get(id);
    if (!u) return 0;
    u.walletAttempts += 1;
    return u.walletAttempts;
  },
  async scheduleWalletRetry(id, nextAttemptAt) {
    store.users.get(id).walletNextAttemptAt = nextAttemptAt;
  },
  async claimPendingWalletUsers(now, limit, leaseMs) {
    const ids = [];
    for (const u of store.users.values()) {
      if (ids.length >= limit) break;
      if (u.walletStatus === 'pending' && u.walletNextAttemptAt <= now) {
        u.walletNextAttemptAt = new Date(now.getTime() + leaseMs); // the lease, taken synchronously
        ids.push(u.id);
      }
    }
    return ids;
  },
  async markEmailVerified(id) {
    Object.assign(store.users.get(id), { emailVerified: true, emailVerifiedAt: new Date() });
  },
  async setPassword(id, passwordHash) {
    const u = store.users.get(id);
    u.passwordHash = passwordHash;
    u.tokenVersion += 1;
  },
  async bumpTokenVersion(id) {
    store.users.get(id).tokenVersion += 1;
  },
  async updateProfile(id, patch) {
    const u = store.users.get(id);
    if (!u) return null;
    Object.assign(u, patch);
    return publicUser(u);
  },
};

// ------------------------------------------------------------------ refresh tokens
const refreshTokenRepository = {
  async create({ userId, familyId, tokenHash, expiresAt }) {
    if (store.refreshTokens.has(tokenHash)) throw dupKeyError();
    store.refreshTokens.set(tokenHash, { userId, familyId, tokenHash, expiresAt, usedAt: null, revokedAt: null });
  },
  async findByHash(tokenHash) {
    const r = store.refreshTokens.get(tokenHash);
    return r ? { ...r } : null;
  },
  async claim(tokenHash, now) {
    const r = store.refreshTokens.get(tokenHash);
    if (!r || r.usedAt || r.revokedAt || !(r.expiresAt > now)) return null;
    const before = { ...r };
    r.usedAt = now;
    return before;
  },
  async revokeFamily(familyId, now) {
    store.refreshTokens.forEach((r) => {
      if (r.familyId === familyId && !r.revokedAt) r.revokedAt = now;
    });
  },
  async revokeAllForUser(userId, now) {
    store.refreshTokens.forEach((r) => {
      if (r.userId === userId && !r.revokedAt) r.revokedAt = now;
    });
  },
};

// ------------------------------------------------------------------ one-time tokens
const authTokenRepository = {
  async create({ userId, type, tokenHash, expiresAt }) {
    if (store.authTokens.has(tokenHash)) throw dupKeyError();
    store.authTokens.set(tokenHash, { userId, type, tokenHash, expiresAt, usedAt: null });
  },
  async invalidateOutstanding(userId, type, now) {
    store.authTokens.forEach((t) => {
      if (t.userId === userId && t.type === type && !t.usedAt) t.usedAt = now;
    });
  },
  async claim(type, tokenHash, now) {
    const t = store.authTokens.get(tokenHash);
    if (!t || t.type !== type || t.usedAt || !(t.expiresAt > now)) return null;
    t.usedAt = now;
    return { userId: t.userId };
  },
};

// ------------------------------------------------------------------ login attempts
const loginAttemptRepository = {
  async getActive(key, now) {
    const a = store.loginAttempts.get(key);
    return a && a.expiresAt > now ? { count: a.count, expiresAt: a.expiresAt } : null;
  },
  async recordFailure(key, windowMs, now) {
    const a = store.loginAttempts.get(key);
    if (a && a.expiresAt > now) {
      a.count += 1;
      return { count: a.count, expiresAt: a.expiresAt };
    }
    const fresh = { count: 1, expiresAt: new Date(now.getTime() + windowMs) };
    store.loginAttempts.set(key, fresh);
    return { ...fresh };
  },
  async clear(key) {
    store.loginAttempts.delete(key);
  },
};

// ------------------------------------------------------------------ vendors
const vendorRepository = {
  async create(data) {
    const all = [...store.vendors.values()];
    if (all.some((v) => v.userId === data.userId)) throw dupKeyError({ userId: 1 });
    if (all.some((v) => v.storeNameKey === data.storeNameKey)) throw dupKeyError({ storeNameKey: 1 });
    const record = {
      id: newId(),
      userId: data.userId,
      storeName: data.storeName,
      storeNameKey: data.storeNameKey,
      description: data.description || '',
      bankDetails: { ...data.bankDetails },
      status: 'pending',
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      createdAt: new Date(),
    };
    store.vendors.set(record.id, record);
    return vendorView(record);
  },
  async findById(id) {
    return vendorView(store.vendors.get(id));
  },
  async findByUserId(userId) {
    return vendorView([...store.vendors.values()].find((v) => v.userId === userId));
  },
  async resubmit(userId, data) {
    const v = [...store.vendors.values()].find((x) => x.userId === userId && x.status === 'rejected');
    if (!v) return null;
    const clash = [...store.vendors.values()].find((x) => x.id !== v.id && x.storeNameKey === data.storeNameKey);
    if (clash) throw dupKeyError({ storeNameKey: 1 });
    Object.assign(v, data, { status: 'pending', reviewedBy: null, reviewedAt: null, rejectionReason: null });
    return vendorView(v);
  },
  async transition(id, fromStatus, patch) {
    const v = store.vendors.get(id);
    if (!v || v.status !== fromStatus) return null;
    Object.assign(v, patch);
    return vendorView(v);
  },
  async list({ status, limit, cursor }) {
    return [...store.vendors.values()]
      .filter((v) => (!status || v.status === status) && (!cursor || v.id < cursor))
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, limit)
      .map(vendorView);
  },
};

function vendorView(record) {
  if (!record) return null;
  const { storeNameKey, ...rest } = record;
  return { ...rest, bankDetails: { ...record.bankDetails } };
}

module.exports = {
  store,
  reset,
  vendorRepository,
  userRepository,
  refreshTokenRepository,
  authTokenRepository,
  loginAttemptRepository,
};
