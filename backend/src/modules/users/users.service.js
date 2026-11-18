const AppError = require('../../utils/AppError');
const userRepository = require('./user.repository');
const { toPublicUser } = require('./user.mapper');

async function getMe(userId) {
  const user = await userRepository.findById(userId);
  if (!user) throw AppError.notFound('User not found', 'USER_NOT_FOUND');
  return toPublicUser(user);
}

// Only whitelisted profile fields. Email, roles and status can never be changed here.
async function updateMe(userId, { fullName, phone }) {
  const patch = {};
  if (fullName !== undefined) patch.fullName = fullName;
  if (phone !== undefined) patch.phone = phone;

  const user = await userRepository.updateProfile(userId, patch);
  if (!user) throw AppError.notFound('User not found', 'USER_NOT_FOUND');
  return toPublicUser(user);
}

module.exports = { getMe, updateMe };
