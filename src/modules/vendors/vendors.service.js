const AppError = require('../../utils/AppError');
const logger = require('../../utils/logger');
const userRepository = require('../users/user.repository');
const vendorRepository = require('./vendor.repository');
const { toPublicStore, toOwnerView, toAdminView } = require('./vendor.mapper');

const storeNameKey = (name) => name.trim().toLowerCase().replace(/\s+/g, ' ');

const storeNameTaken = () => AppError.conflict('That store name is already taken', 'STORE_NAME_TAKEN');
const alreadyPending = () =>
  AppError.conflict('You already have an application waiting for review', 'APPLICATION_PENDING');

/** Translate a MongoDB duplicate-key error into the right API conflict. */
function conflictFrom(err) {
  if (err.code !== 11000) return err;
  return err.keyPattern && err.keyPattern.storeNameKey ? storeNameTaken() : alreadyPending();
}

// ---------------------------------------------------------------- applicant

async function apply(userId, { storeName, description, bankDetails }) {
  const data = { storeName, storeNameKey: storeNameKey(storeName), description, bankDetails };
  const existing = await vendorRepository.findByUserId(userId);

  try {
    if (!existing) {
      return toOwnerView(await vendorRepository.create({ userId, ...data }));
    }
    if (existing.status === 'approved') {
      throw AppError.conflict('You are already an approved vendor', 'ALREADY_A_VENDOR');
    }
    if (existing.status === 'pending') throw alreadyPending();

    // Rejected: the applicant may fix the application and apply again.
    const resubmitted = await vendorRepository.resubmit(userId, data);
    if (!resubmitted) throw alreadyPending(); // status changed while we were checking
    return toOwnerView(resubmitted);
  } catch (err) {
    throw conflictFrom(err);
  }
}

async function getMine(userId) {
  const vendor = await vendorRepository.findByUserId(userId);
  if (!vendor) throw AppError.notFound('You have not applied to become a vendor', 'NO_APPLICATION');
  return toOwnerView(vendor);
}

/** Public store page: approved vendors only. Everything else looks like it does not exist. */
async function getPublicStore(vendorId) {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor || vendor.status !== 'approved') {
    throw AppError.notFound('Vendor not found', 'VENDOR_NOT_FOUND');
  }
  return toPublicStore(vendor);
}

// ---------------------------------------------------------------- admin

async function adminList({ status, limit, cursor }) {
  // Ask for one extra row to know whether another page exists.
  const rows = await vendorRepository.list({ status, limit: limit + 1, cursor });
  const page = rows.slice(0, limit);
  return {
    vendors: page.map(toAdminView),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
  };
}

async function requireVendor(vendorId) {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) throw AppError.notFound('Vendor application not found', 'VENDOR_NOT_FOUND');
  return vendor;
}

const invalidState = (vendor, action) =>
  AppError.conflict(`Cannot ${action} an application that is ${vendor.status}`, 'INVALID_STATE');

/**
 * Approve: pending -> approved, then grant the "vendor" role.
 *
 * MongoDB has no transaction across two collections here, so the order is chosen to fail
 * safe: the status flips first (atomically), the role is added second (idempotent $addToSet).
 * If the role step fails the status is rolled back to pending. Approving an already-approved
 * vendor just re-applies the role, which repairs any half-finished approval.
 */
async function approve(adminId, vendorId) {
  const vendor = await requireVendor(vendorId);

  if (vendor.status === 'approved') {
    await userRepository.addRole(vendor.userId, 'vendor');
    return toAdminView(vendor);
  }
  if (vendor.status !== 'pending') throw invalidState(vendor, 'approve');

  const approved = await vendorRepository.transition(vendorId, 'pending', {
    status: 'approved',
    reviewedBy: adminId,
    reviewedAt: new Date(),
    rejectionReason: null,
  });
  if (!approved) throw invalidState(await requireVendor(vendorId), 'approve'); // lost a race

  try {
    await userRepository.addRole(vendor.userId, 'vendor');
  } catch (err) {
    logger.error({ err, vendorId }, 'Granting vendor role failed, rolling approval back');
    await vendorRepository.transition(vendorId, 'approved', { status: 'pending', reviewedBy: null, reviewedAt: null });
    throw err;
  }
  return toAdminView(approved);
}

async function reject(adminId, vendorId, reason) {
  const vendor = await requireVendor(vendorId);
  if (vendor.status !== 'pending') throw invalidState(vendor, 'reject');

  const rejected = await vendorRepository.transition(vendorId, 'pending', {
    status: 'rejected',
    reviewedBy: adminId,
    reviewedAt: new Date(),
    rejectionReason: reason,
  });
  if (!rejected) throw invalidState(await requireVendor(vendorId), 'reject');
  return toAdminView(rejected);
}

module.exports = { apply, getMine, getPublicStore, adminList, approve, reject };
