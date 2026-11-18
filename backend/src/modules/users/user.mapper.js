// What the API is allowed to show about a user. Never includes the password hash or token version.
function toPublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    phone: user.phone,
    roles: user.roles,
    status: user.status,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
  };
}

module.exports = { toPublicUser };
