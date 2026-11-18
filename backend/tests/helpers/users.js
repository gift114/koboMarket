const request = require('supertest');
const { hashPassword } = require('../../src/utils/crypto');
const userRepository = require('../../src/modules/users/user.repository');

const PASSWORD = 'Sup3rSecret99';
let counter = 0;
const uniqueEmail = (prefix = 'user') => `${prefix}${Date.now()}${(counter += 1)}@example.com`;

/** Create a verified user straight in the database (skips the signup emails). */
async function createUser({ roles = ['buyer'], email = uniqueEmail() } = {}) {
  const user = await userRepository.create({
    email,
    passwordHash: await hashPassword(PASSWORD),
    fullName: 'Test User',
    roles,
  });
  await userRepository.markEmailVerified(user.id);
  return { id: user.id, email, password: PASSWORD };
}

async function login(app, { email, password }) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password }).expect(200);
  return res.body.data.accessToken;
}

/** { id, email, password, token } for a freshly created, logged-in user with the given roles. */
async function createUserAndLogin(app, options = {}) {
  const user = await createUser(options);
  return { ...user, token: await login(app, user) };
}

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

module.exports = { PASSWORD, uniqueEmail, createUser, login, createUserAndLogin, bearer };
