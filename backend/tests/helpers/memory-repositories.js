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
  products: new Map(), // id -> record
  reviews: new Map(), // id -> record
  carts: new Map(), // userId -> record
  notifications: new Map(), // id -> record
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
  async search({ q, role, status, limit, cursor }) {
    const needle = q ? q.toLowerCase() : null;
    return [...store.users.values()]
      .filter((u) => !needle || u.email.toLowerCase().includes(needle) || u.fullName.toLowerCase().includes(needle))
      .filter((u) => !role || u.roles.includes(role))
      .filter((u) => !status || u.status === status)
      .filter((u) => !cursor || u.id < cursor)
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, limit)
      .map((u) => publicUser(u));
  },
  async setStatus(id, status) {
    const u = store.users.get(id);
    if (!u) return null;
    u.status = status;
    return publicUser(u);
  },
  async listIdsByRole(role) {
    return [...store.users.values()].filter((u) => u.roles.includes(role)).map((u) => u.id);
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


// ------------------------------------------------------------------ products and reviews
const productQuery = require('../../src/modules/products/product.query');

const copyProduct = (p) => ({
  ...p,
  images: [...p.images],
  tags: [...p.tags],
  variants: p.variants.map((v) => ({ ...v, attributes: { ...v.attributes } })),
});

/** A tiny stand-in for MongoDB's $text: every search word must appear in name or description. */
const matchesText = (p, q) => {
  const haystack = `${p.name} ${p.description}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every((word) => haystack.includes(word));
};

const productRepository = {
  async create(data) {
    if ([...store.products.values()].some((p) => p.slug === data.slug)) throw dupKeyError({ slug: 1 });
    const record = {
      id: newId(),
      description: '',
      images: [],
      tags: [],
      variants: [],
      isActive: true,
      deletedAt: null,
      ratingSum: 0,
      ratingCount: 0,
      ratingAvg: 0,
      createdAt: new Date(),
      ...data,
    };
    // Guarantee a distinct, increasing createdAt like a real clock would over time.
    store.products.set(record.id, record);
    return copyProduct(record);
  },
  async findById(id) {
    const p = store.products.get(id);
    return p && !p.deletedAt ? copyProduct(p) : null;
  },
  async findManyByIds(ids) {
    const found = ids.map((id) => store.products.get(id)).filter((p) => p && !p.deletedAt);
    return new Map(found.map((p) => [p.id, copyProduct(p)]));
  },
  async findBySlug(slug) {
    const p = [...store.products.values()].find((x) => x.slug === slug && !x.deletedAt);
    return p ? copyProduct(p) : null;
  },
  async update(id, patch) {
    const p = store.products.get(id);
    if (!p || p.deletedAt) return null;
    Object.assign(p, patch);
    return copyProduct(p);
  },
  async softDelete(id) {
    const p = store.products.get(id);
    if (!p || p.deletedAt) return null;
    p.deletedAt = new Date();
    p.isActive = false;
    return copyProduct(p);
  },
  async search({ filters, sort, limit, after }) {
    let rows = [...store.products.values()].filter((p) => !p.deletedAt && p.isActive);
    if (filters.q) rows = rows.filter((p) => matchesText(p, filters.q));
    if (filters.category) rows = rows.filter((p) => p.category === filters.category);
    if (filters.vendorId) rows = rows.filter((p) => p.vendorId === filters.vendorId);
    if (filters.tag) rows = rows.filter((p) => p.tags.includes(filters.tag));
    if (filters.minRating !== undefined) rows = rows.filter((p) => p.ratingAvg >= filters.minRating);
    if (filters.minPrice !== undefined) rows = rows.filter((p) => p.priceKobo >= filters.minPrice);
    if (filters.maxPrice !== undefined) rows = rows.filter((p) => p.priceKobo <= filters.maxPrice);
    rows.sort(productQuery.comparator(sort));
    if (after) rows = rows.filter((p) => productQuery.isAfterCursor(sort, p, after));
    return rows.slice(0, limit).map(copyProduct);
  },
  async listByVendor(vendorId, { limit, cursor }) {
    let rows = [...store.products.values()].filter((p) => p.vendorId === vendorId && !p.deletedAt);
    rows.sort((a, b) => (a.id < b.id ? 1 : -1));
    if (cursor) rows = rows.filter((p) => p.id < cursor);
    return rows.slice(0, limit).map(copyProduct);
  },
  // Guarded decrement: check and write in one synchronous step = atomic, like the filtered update.
  async decrementStock(productId, variantId, quantity) {
    const p = store.products.get(productId);
    if (!p || p.deletedAt || !p.isActive) return false;
    if (variantId) {
      const v = p.variants.find((x) => x.id === variantId);
      if (!v || v.stock < quantity) return false;
      v.stock -= quantity;
      p.stock -= quantity;
      return true;
    }
    if (p.variants.length > 0 || p.stock < quantity) return false;
    p.stock -= quantity;
    return true;
  },
  async restoreStock(productId, variantId, quantity) {
    const p = store.products.get(productId);
    if (!p) return false;
    if (variantId) {
      const v = p.variants.find((x) => x.id === variantId);
      if (!v) return false;
      v.stock += quantity;
    }
    p.stock += quantity;
    return true;
  },
  // Synchronous read-modify-write inside one async function = atomic, like the pipeline update.
  async addRating(id, rating) {
    const p = store.products.get(id);
    if (!p || p.deletedAt) return null;
    p.ratingSum += rating;
    p.ratingCount += 1;
    p.ratingAvg = Math.round((p.ratingSum / p.ratingCount) * 100) / 100;
    return copyProduct(p);
  },
};

const copyCart = (c) => ({ ...c, items: c.items.map((i) => ({ ...i })) });

const cartRepository = {
  async findByUserId(userId) {
    const c = store.carts.get(userId);
    const snapshot = c ? copyCart(c) : null; // what the database held at the moment of the read...
    await new Promise((resolve) => setTimeout(resolve, 5)); // ...then network time passes (others may write)
    return snapshot;
  },
  // Compare-and-set on `rev`, exactly like the MongoDB filter { userId, rev }.
  async save(userId, items, expectedRev) {
    const current = store.carts.get(userId);
    if (!current) {
      if (expectedRev !== null) return null;
      const record = { userId, items: items.map((i) => ({ ...i })), rev: 0, updatedAt: new Date() };
      store.carts.set(userId, record);
      return copyCart(record);
    }
    if (expectedRev === null || current.rev !== expectedRev) return null;
    current.items = items.map((i) => ({ ...i }));
    current.rev += 1;
    current.updatedAt = new Date();
    return copyCart(current);
  },
};

const reviewRepository = {
  async create(data) {
    if ([...store.reviews.values()].some((r) => r.productId === data.productId && r.buyerId === data.buyerId)) {
      throw dupKeyError({ productId: 1, buyerId: 1 });
    }
    const record = { id: newId(), title: '', comment: '', createdAt: new Date(), ...data };
    store.reviews.set(record.id, record);
    return { ...record };
  },
  async remove(id) {
    store.reviews.delete(id);
  },
  async listByProduct(productId, { limit, cursor }) {
    let rows = [...store.reviews.values()].filter((r) => r.productId === productId);
    rows.sort((a, b) => (a.id < b.id ? 1 : -1));
    if (cursor) rows = rows.filter((r) => r.id < cursor);
    return rows.slice(0, limit).map((r) => ({ ...r }));
  },
};

// ------------------------------------------------------------------ notifications
let notificationSeq = 0;
const notificationRepository = {
  async create({ userId, type, title, message, data, dedupeKey }) {
    // the unique (userId, dedupeKey) index, checked and written synchronously
    if ([...store.notifications.values()].some((n) => n.userId === userId && n.dedupeKey === dedupeKey)) return null;
    notificationSeq += 1;
    const record = { id: String(notificationSeq).padStart(24, '0'), userId, type, title, message, data: data || {}, dedupeKey, readAt: null, createdAt: new Date() };
    store.notifications.set(record.id, record);
    return { ...record };
  },
  async listByUser(userId, { limit, cursor, unreadOnly }) {
    return [...store.notifications.values()]
      .filter((n) => n.userId === userId && (!unreadOnly || !n.readAt) && (!cursor || n.id < cursor))
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, limit)
      .map((n) => ({ ...n }));
  },
  async countUnread(userId) {
    return [...store.notifications.values()].filter((n) => n.userId === userId && !n.readAt).length;
  },
  async markRead(userId, id) {
    const n = store.notifications.get(id);
    if (!n || n.userId !== userId) return null;
    if (!n.readAt) n.readAt = new Date();
    return { ...n };
  },
  async markAllRead(userId) {
    let count = 0;
    store.notifications.forEach((n) => {
      if (n.userId === userId && !n.readAt) {
        n.readAt = new Date();
        count += 1;
      }
    });
    return count;
  },
};

module.exports = {
  store,
  notificationRepository,
  reset,
  productRepository,
  reviewRepository,
  cartRepository,
  vendorRepository,
  userRepository,
  refreshTokenRepository,
  authTokenRepository,
  loginAttemptRepository,
};
