const backend = require('../helpers/backend'); // must come before the app (installs mocks)
const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../../src/config');
const createApp = require('../../src/app');
const { outbox } = require('../../src/utils/mailer');
const userRepository = require('../../src/modules/users/user.repository');

const app = createApp();
const PASSWORD = 'Sup3rSecret99';
let counter = 0;
const uniqueEmail = () => `user${Date.now()}${(counter += 1)}@example.com`;

const api = {
  register: (body) => request(app).post('/api/v1/auth/register').send(body),
  verify: (token) => request(app).post('/api/v1/auth/verify-email').send({ token }),
  resend: (email) => request(app).post('/api/v1/auth/resend-verification').send({ email }),
  login: (email, password = PASSWORD, headers = {}) =>
    request(app).post('/api/v1/auth/login').set(headers).send({ email, password }),
  refresh: (refreshToken) => request(app).post('/api/v1/auth/refresh').send({ refreshToken }),
  logout: (refreshToken) => request(app).post('/api/v1/auth/logout').send({ refreshToken }),
  forgot: (email) => request(app).post('/api/v1/auth/forgot-password').send({ email }),
  reset: (token, newPassword) => request(app).post('/api/v1/auth/reset-password').send({ token, newPassword }),
  me: (accessToken) => request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${accessToken}`),
};

/** Read the raw token out of the last email of a kind sent to an address. */
function tokenFromEmail(email, subjectPart) {
  const mails = outbox.filter((m) => m.to === email && m.subject.includes(subjectPart));
  expect(mails.length).toBeGreaterThan(0);
  return /Token: (\S+)/.exec(mails[mails.length - 1].text)[1];
}

async function registerUser(overrides = {}) {
  const email = overrides.email || uniqueEmail();
  const res = await api.register({ email, password: PASSWORD, fullName: 'Test User', ...overrides });
  return { res, email };
}

async function verifiedUser() {
  const { email } = await registerUser();
  await api.verify(tokenFromEmail(email, 'Verify')).expect(200);
  return email;
}

async function loggedInSession(email) {
  const res = await api.login(email).expect(200);
  return res.body.data;
}

beforeAll(() => backend.start());
afterAll(() => backend.stop());

// ------------------------------------------------------------------------------------------
describe('Registration', () => {
  test('creates an account without exposing the hash, and stores a bcrypt hash', async () => {
    const { res, email } = await registerUser();
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({ email, fullName: 'Test User', roles: ['buyer'], emailVerified: false });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|tokenVersion|\$2[aby]\$/);

    const stored = await userRepository.findByEmail(email, { withPassword: true });
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(stored.passwordHash).not.toContain(PASSWORD);
  });

  test('sends a verification email containing a token', async () => {
    const { email } = await registerUser();
    expect(tokenFromEmail(email, 'Verify').length).toBeGreaterThanOrEqual(32);
  });

  test('verification email includes a clickable confirmation link', async () => {
    const { email } = await registerUser();
    const mail = outbox.findLast((message) => message.to === email && message.subject.includes('Verify'));
    const token = tokenFromEmail(email, 'Verify');
    const verificationUrl = `${config.frontendBaseUrl.replace(/\/+$/, '')}/verify-email#token=${token}`;

    expect(mail.html).toContain(`href="${verificationUrl}"`);
    expect(mail.html).toContain('Yes, it’s me — verify my email');
  });

  test('rejects a duplicate email, case-insensitively', async () => {
    const { email } = await registerUser();
    const res = await api.register({ email: email.toUpperCase(), password: PASSWORD, fullName: 'Someone Else' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  test('rejects weak passwords with details', async () => {
    for (const password of ['short1', 'allletters', '12345678']) {
      const res = await api.register({ email: uniqueEmail(), password, fullName: 'Weak Pass' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details[0].path).toBe('password');
    }
  });

  test('rejects unknown fields, so a user cannot register themselves as admin', async () => {
    const res = await api.register({ email: uniqueEmail(), password: PASSWORD, fullName: 'Sneaky', roles: ['admin'] });
    expect(res.status).toBe(422);
  });
});

// ------------------------------------------------------------------------------------------
describe('Email verification', () => {
  test('a user cannot log in before verifying their email', async () => {
    const { email } = await registerUser();

    const res = await api.login(email); // correct password, unverified email
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(res.body.data).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/accessToken|refreshToken/);
  });

  test('after verifying, login returns a 15-minute access token and a refresh token', async () => {
    const { email } = await registerUser();
    await api.verify(tokenFromEmail(email, 'Verify')).expect(200);

    const res = await api.login(email);
    expect(res.status).toBe(200);
    const { accessToken, refreshToken, expiresIn, tokenType, user } = res.body.data;
    expect(tokenType).toBe('Bearer');
    expect(expiresIn).toBe(900);
    expect(refreshToken.length).toBeGreaterThanOrEqual(48);
    expect(user.emailVerified).toBe(true);

    const decoded = jwt.decode(accessToken);
    expect(decoded.exp - decoded.iat).toBe(900);
  });

  test('a verification token works only once', async () => {
    const { email } = await registerUser();
    const token = tokenFromEmail(email, 'Verify');
    await api.verify(token).expect(200);
    const again = await api.verify(token);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_OR_EXPIRED_TOKEN');
  });

  test('an expired verification token is rejected and login stays blocked', async () => {
    const { email } = await registerUser();
    const user = await userRepository.findByEmail(email);
    await backend.expireAuthTokens(user.id, 'email_verification');

    const res = await api.verify(tokenFromEmail(email, 'Verify'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_OR_EXPIRED_TOKEN');
    expect((await api.login(email)).status).toBe(403);
  });

  test('a made-up token is rejected', async () => {
    const res = await api.verify('x'.repeat(43));
    expect(res.status).toBe(400);
  });

  test('resending issues a new token and retires the old one; unknown emails get the same reply', async () => {
    const { email } = await registerUser();
    const oldToken = tokenFromEmail(email, 'Verify');

    const resend = await api.resend(email);
    const unknown = await api.resend(uniqueEmail());
    expect(resend.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(resend.body);

    const newToken = tokenFromEmail(email, 'Verify');
    expect(newToken).not.toBe(oldToken);
    expect((await api.verify(oldToken)).status).toBe(400);
    expect((await api.verify(newToken)).status).toBe(200);
  });
});

// ------------------------------------------------------------------------------------------
describe('Login', () => {
  test('a wrong password and an unknown email give an identical 401', async () => {
    const email = await verifiedUser();
    const wrongPassword = await api.login(email, 'Wr0ngPassword1');
    const unknownEmail = await api.login(uniqueEmail(), 'Wr0ngPassword1');
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  test('after 5 failed attempts for an email + IP, even the correct password gets 429', async () => {
    const email = await verifiedUser();
    const ip = { 'X-Forwarded-For': '203.0.113.10' };

    for (let i = 0; i < config.auth.loginMaxFailedAttempts; i += 1) {
      const res = await api.login(email, 'Wr0ngPassword1', ip);
      expect(res.status).toBe(401);
    }

    const blocked = await api.login(email, PASSWORD, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_LOGIN_ATTEMPTS');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(config.auth.loginWindowMinutes * 60);

    // Same email from a different IP is a different bucket.
    const otherIp = await api.login(email, PASSWORD, { 'X-Forwarded-For': '203.0.113.99' });
    expect(otherIp.status).toBe(200);

    // A different email from the blocked IP is a different bucket too.
    const otherEmail = await verifiedUser();
    expect((await api.login(otherEmail, PASSWORD, ip)).status).toBe(200);
  });

  test('a successful login resets the failure counter', async () => {
    const email = await verifiedUser();
    const ip = { 'X-Forwarded-For': '203.0.113.20' };
    const almost = config.auth.loginMaxFailedAttempts - 1;

    for (let i = 0; i < almost; i += 1) await api.login(email, 'Wr0ngPassword1', ip);
    expect((await api.login(email, PASSWORD, ip)).status).toBe(200);
    for (let i = 0; i < almost; i += 1) {
      expect((await api.login(email, 'Wr0ngPassword1', ip)).status).toBe(401); // not 429
    }
  });
});

// ------------------------------------------------------------------------------------------
describe('Access tokens and the authenticate middleware', () => {
  test('rejects a missing, malformed, wrongly signed or expired token', async () => {
    const email = await verifiedUser();
    const { accessToken } = await loggedInSession(email);
    const { sub, tv } = jwt.decode(accessToken);

    expect((await request(app).get('/api/v1/users/me')).body.error.code).toBe('MISSING_TOKEN');
    expect((await api.me('not-a-jwt')).body.error.code).toBe('INVALID_TOKEN');

    const forged = jwt.sign({ sub, tv }, 'a-completely-different-secret-of-32-chars!!');
    expect((await api.me(forged)).body.error.code).toBe('INVALID_TOKEN');

    const expired = jwt.sign({ sub, tv, exp: Math.floor(Date.now() / 1000) - 60 }, config.auth.accessSecret);
    const res = await api.me(expired);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  test('a valid token reaches the profile, which can update name and phone only', async () => {
    const email = await verifiedUser();
    const { accessToken } = await loggedInSession(email);

    const me = await api.me(accessToken);
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(email);

    const patch = await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fullName: 'New Name', phone: '+2348012345678' });
    expect(patch.status).toBe(200);
    expect(patch.body.data.user).toMatchObject({ fullName: 'New Name', phone: '+2348012345678' });

    for (const forbidden of [{ roles: ['admin'] }, { email: 'x@example.com' }, { status: 'active' }]) {
      const res = await request(app)
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(forbidden);
      expect(res.status).toBe(422);
    }
    expect((await api.me(accessToken)).body.data.user.roles).toEqual(['buyer']);
  });
});

// ------------------------------------------------------------------------------------------
describe('Refresh token rotation', () => {
  test('refreshing returns a new, different token pair and the new access token works', async () => {
    const email = await verifiedUser();
    const first = await loggedInSession(email);

    const res = await api.refresh(first.refreshToken);
    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).not.toBe(first.refreshToken);
    expect((await api.me(res.body.data.accessToken)).status).toBe(200);
  });

  test('refresh tokens are stored hashed, never in plain text', async () => {
    const email = await verifiedUser();
    const { refreshToken } = await loggedInSession(email);
    const { sha256 } = require('../../src/utils/crypto');
    const refreshTokenRepository = require('../../src/modules/auth/refreshToken.repository');

    expect(await refreshTokenRepository.findByHash(refreshToken)).toBeNull(); // raw value is not a key
    expect(await refreshTokenRepository.findByHash(sha256(refreshToken))).not.toBeNull();
  });

  test('a reused refresh token is rejected and logs the user out of ALL sessions', async () => {
    const email = await verifiedUser();
    const sessionA = await loggedInSession(email); // e.g. phone
    const sessionB = await loggedInSession(email); // e.g. laptop

    // Normal rotation on A.
    const rotated = await api.refresh(sessionA.refreshToken);
    expect(rotated.status).toBe(200);
    const sessionA2 = rotated.body.data;

    // The OLD token is presented again (stolen / replayed).
    const replay = await api.refresh(sessionA.refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    // Every refresh token of this user is now dead, including the legitimate new one and B's.
    expect((await api.refresh(sessionA2.refreshToken)).status).toBe(401);
    expect((await api.refresh(sessionB.refreshToken)).status).toBe(401);

    // Access tokens die immediately too, not after their 15 minutes.
    for (const token of [sessionA.accessToken, sessionA2.accessToken, sessionB.accessToken]) {
      const res = await api.me(token);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_REVOKED');
    }

    // The account itself is fine: logging in again works.
    expect((await api.login(email)).status).toBe(200);
  });

  test('using the same refresh token twice at the same instant never leaves a live session', async () => {
    const email = await verifiedUser();
    const session = await loggedInSession(email);

    const results = await Promise.all([api.refresh(session.refreshToken), api.refresh(session.refreshToken)]);
    const succeeded = results.filter((r) => r.status === 200);
    const failed = results.filter((r) => r.status === 401);

    expect(succeeded.length).toBeLessThanOrEqual(1);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    failed.forEach((r) => expect(r.body.error.code).toBe('REFRESH_TOKEN_REUSED'));

    // Whatever the winner (if any) received must be dead once the replay was detected.
    for (const r of succeeded) {
      expect((await api.refresh(r.body.data.refreshToken)).status).toBe(401);
      expect((await api.me(r.body.data.accessToken)).status).toBe(401);
    }
    expect((await api.me(session.accessToken)).status).toBe(401);
  });

  test('a replay landing while the winner is still storing its new token cannot leave a live session', async () => {
    // Deterministic version of the race: the winner has claimed the token but its new refresh
    // token is not stored yet when the replay arrives and terminates every session.
    const email = await verifiedUser();
    const session = await loggedInSession(email);
    const user = await userRepository.findByEmail(email);

    const refreshTokenRepository = require('../../src/modules/auth/refreshToken.repository');
    const realCreate = refreshTokenRepository.create;
    let release;
    let reachedCreate;
    const gate = new Promise((resolve) => { release = resolve; });
    const reached = new Promise((resolve) => { reachedCreate = resolve; });
    const spy = jest.spyOn(refreshTokenRepository, 'create').mockImplementation(async (...args) => {
      reachedCreate();
      await gate;
      return realCreate(...args);
    });

    let winner;
    let replay;
    try {
      winner = api.refresh(session.refreshToken).then((r) => r); // claims the token, then stalls in create()
      await reached;
      replay = await api.refresh(session.refreshToken); // arrives in the gap
      release();
      winner = await winner;
    } finally {
      release();
      spy.mockRestore();
    }

    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    expect(winner.status).toBe(401); // the winner must undo its own session
    expect(winner.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    expect(await backend.countLiveRefreshTokens(user.id)).toBe(0);
    expect((await api.me(session.accessToken)).status).toBe(401);
  });

  test('an expired refresh token is rejected without killing other sessions', async () => {
    const email = await verifiedUser();
    const old = await loggedInSession(email);
    const user = await userRepository.findByEmail(email);
    await backend.expireRefreshTokens(user.id);

    const res = await api.refresh(old.refreshToken);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REFRESH_TOKEN_EXPIRED');

    const fresh = await loggedInSession(email);
    expect((await api.me(fresh.accessToken)).status).toBe(200);
  });

  test('an unknown refresh token is rejected', async () => {
    const res = await api.refresh('z'.repeat(64));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });
});

// ------------------------------------------------------------------------------------------
describe('Logout', () => {
  test('invalidates that refresh token only; other sessions keep working', async () => {
    const email = await verifiedUser();
    const phone = await loggedInSession(email);
    const laptop = await loggedInSession(email);

    expect((await api.logout(phone.refreshToken)).status).toBe(200);

    const afterLogout = await api.refresh(phone.refreshToken);
    expect(afterLogout.status).toBe(401);
    expect(afterLogout.body.error.code).toBe('INVALID_REFRESH_TOKEN'); // revoked, not "reuse"

    expect((await api.refresh(laptop.refreshToken)).status).toBe(200);
  });

  test('logout also retires tokens that were rotated from the logged-out session', async () => {
    const email = await verifiedUser();
    const first = await loggedInSession(email);
    const rotated = (await api.refresh(first.refreshToken)).body.data;

    await api.logout(rotated.refreshToken).expect(200);
    expect((await api.refresh(rotated.refreshToken)).status).toBe(401);
  });

  test('is idempotent and accepts unknown tokens', async () => {
    const email = await verifiedUser();
    const session = await loggedInSession(email);
    expect((await api.logout(session.refreshToken)).status).toBe(200);
    expect((await api.logout(session.refreshToken)).status).toBe(200);
    expect((await api.logout('q'.repeat(48))).status).toBe(200);
  });
});

// ------------------------------------------------------------------------------------------
describe('Forgot and reset password', () => {
  test('gives the same reply for known and unknown emails, and only emails real accounts', async () => {
    const email = await verifiedUser();
    const stranger = uniqueEmail();
    const before = outbox.length;

    const known = await api.forgot(email);
    const unknown = await api.forgot(stranger);
    expect(known.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    expect(outbox.length).toBe(before + 1);
    expect(outbox.some((m) => m.to === stranger)).toBe(false);
  });

  test('full flow: new password works, old one and every old session stop working', async () => {
    const email = await verifiedUser();
    const session = await loggedInSession(email);

    await api.forgot(email).expect(200);
    const token = tokenFromEmail(email, 'Reset');
    const newPassword = 'Br4ndNewPass77';

    expect((await api.reset(token, newPassword)).status).toBe(200);

    expect((await api.login(email, PASSWORD)).status).toBe(401);
    expect((await api.login(email, newPassword)).status).toBe(200);

    expect((await api.refresh(session.refreshToken)).status).toBe(401);
    const old = await api.me(session.accessToken);
    expect(old.status).toBe(401);
    expect(old.body.error.code).toBe('TOKEN_REVOKED');
  });

  test('a reset token works once', async () => {
    const email = await verifiedUser();
    await api.forgot(email);
    const token = tokenFromEmail(email, 'Reset');
    await api.reset(token, 'Br4ndNewPass77').expect(200);
    const again = await api.reset(token, 'An0therNewPass88');
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_OR_EXPIRED_TOKEN');
  });

  test('an expired reset token is rejected', async () => {
    const email = await verifiedUser();
    await api.forgot(email);
    await backend.expireAuthTokens((await userRepository.findByEmail(email)).id, 'password_reset');
    const res = await api.reset(tokenFromEmail(email, 'Reset'), 'Br4ndNewPass77');
    expect(res.status).toBe(400);
  });

  test('a weak new password is rejected without using up the token', async () => {
    const email = await verifiedUser();
    await api.forgot(email);
    const token = tokenFromEmail(email, 'Reset');

    expect((await api.reset(token, 'weak')).status).toBe(422);
    expect((await api.reset(token, 'Str0ngEnoughNow')).status).toBe(200);
  });

  test('asking again retires the earlier reset token', async () => {
    const email = await verifiedUser();
    await api.forgot(email);
    const first = tokenFromEmail(email, 'Reset');
    await api.forgot(email);
    const second = tokenFromEmail(email, 'Reset');

    expect(second).not.toBe(first);
    expect((await api.reset(first, 'Br4ndNewPass77')).status).toBe(400);
    expect((await api.reset(second, 'Br4ndNewPass77')).status).toBe(200);
  });
});

// ------------------------------------------------------------------------------------------
describe('Error shape', () => {
  test('validation errors use the standard envelope', async () => {
    const res = await api.login('not-an-email', '');
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: expect.any(String), details: expect.any(Array) },
    });
  });
});
