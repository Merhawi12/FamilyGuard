/**
 * Regressions for the six defects found in the 2026-08-09 audit.
 *
 * Every one of them sat behind a fully green suite, so each is pinned here by
 * the behaviour that was actually wrong rather than by the shape of the fix.
 */
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../src/app');
const { User, Session, Device } = require('../src/models');
const { createUser, createChild, createDevice, deviceToken, tokenFor, uniqueEmail, DEFAULT_PASSWORD } = require('./helpers');

describe('The MFA pre-auth token is not a credential', () => {
  /*
   * `signPreAuthToken` omits `sid` because no session exists after the first
   * factor. `authenticate` only consulted the Session table when `sid` was
   * present, so the pre-auth token fell through to the user lookup and
   * authenticated every route for its full five minutes — a password alone
   * reached children, locations, messages and chat, and MFA gated nothing but
   * the shape of the login response.
   */
  let preAuthToken;
  let user;

  beforeEach(async () => {
    const email = uniqueEmail('mfa-preauth');
    user = await createUser({ email, mfaEnabled: true, mfaSecret: 'JBSWY3DPEHPK3PXP' });
    const login = await request(app).post('/api/auth/login').send({ email, password: DEFAULT_PASSWORD });
    preAuthToken = login.body.preAuthToken;
  });

  it('is what login returns instead of a session token', () => {
    expect(preAuthToken).toEqual(expect.any(String));
    expect(jwt.decode(preAuthToken)).toMatchObject({ mfaRequired: true });
  });

  it('creates no session until the second factor is presented', async () => {
    expect(await Session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('cannot read the account it half-authenticated', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${preAuthToken}`);
    expect(res.status).toBe(401);
  });

  it('cannot reach the family data behind the second factor', async () => {
    for (const path of ['/api/children', '/api/alerts', '/api/notifications']) {
      const res = await request(app).get(path).set('Authorization', `Bearer ${preAuthToken}`);
      expect([path, res.status]).toEqual([path, 401]);
    }
  });
});

describe('Every signup path grants the trial', () => {
  /*
   * `effectivePlan` lifts a free account to the trial tier only while
   * `trialEndsAt` is in the future, so a signup that never set one produced a
   * Free account from its first request — no GPS, no geofencing, no website
   * filtering — while the welcome copy promised full access.
   */
  it('email registration sets a trial', async () => {
    const email = uniqueEmail('trial-email');
    await request(app).post('/api/auth/register').send({ name: 'E', email, password: 'Str0ngPassw0rd!' });
    const user = await User.findByEmail(email);
    expect(user.trialEndsAt).toBeTruthy();
    expect(new Date(user.trialEndsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('phone registration sets a trial too', async () => {
    const phone = '+14155550142';
    await request(app).post('/api/auth/phone/request').send({ phone, name: 'P', mode: 'register' });
    const user = await User.findByPhone(phone);
    expect(user.trialEndsAt).toBeTruthy();
    expect(new Date(user.trialEndsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('resuming an abandoned phone signup does not extend the trial it already has', async () => {
    const phone = '+14155550143';
    await request(app).post('/api/auth/phone/request').send({ phone, name: 'P', mode: 'register' });
    const first = (await User.findByPhone(phone)).trialEndsAt;

    await request(app).post('/api/auth/phone/request').send({ phone, name: 'P again', mode: 'register' });
    const second = (await User.findByPhone(phone)).trialEndsAt;

    expect(new Date(second).getTime()).toBe(new Date(first).getTime());
  });
});

describe('Changing the email address re-verifies it', () => {
  /*
   * The address was written straight through with `emailVerified` left true, so
   * an account could move to an address its owner had never proved control of —
   * taking the password-reset link and every alert about the child with it.
   */
  let user;
  let token;
  // Unique per test: the address is claimed for real, and a fixed one would be
  // taken by the first case and 409 for every case after it.
  let newAddress;

  beforeEach(async () => {
    user = await createUser({ email: uniqueEmail('profile') });
    token = tokenFor(user);
    newAddress = uniqueEmail('moved-to');
    await request(app).put('/api/auth/profile').set('Authorization', `Bearer ${token}`).send({ email: newAddress });
    await user.reload();
  });

  it('stores the new address', () => {
    expect(user.email).toBe(newAddress);
  });

  it('marks it unverified', () => {
    expect(user.emailVerified).toBe(false);
  });

  it('issues a fresh verification code for it', () => {
    expect(user.emailVerificationCode).toMatch(/^\d{6}$/);
    expect(new Date(user.emailVerificationExpires).getTime()).toBeGreaterThan(Date.now());
  });

  it('tells the client the address needs confirming', async () => {
    const res = await request(app).put('/api/auth/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: uniqueEmail('moved-again') });
    expect(res.body).toMatchObject({ emailVerificationRequired: true });
  });

  it('reports the verified state so the client can show it', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.body.emailVerified).toBe(false);
  });

  it('leaves the caller signed in, so a typo can be corrected', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('does not re-verify when the address is unchanged but differently cased', async () => {
    await user.update({ emailVerified: true, emailVerificationCode: null });
    await request(app).put('/api/auth/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: newAddress.toUpperCase() });
    await user.reload();
    expect(user.emailVerified).toBe(true);
  });
});

describe('Changing the password evicts every other session', () => {
  /*
   * A password change is what someone does when they think the old one is
   * known. Leaving the other sessions live meant the old password stopped
   * working while every token minted with it kept full access.
   */
  let email;
  let mine;
  let theirs;
  let user;

  beforeEach(async () => {
    email = uniqueEmail('pwchange');
    user = await createUser({ email });
    mine = (await request(app).post('/api/auth/login').send({ email, password: DEFAULT_PASSWORD })).body.token;
    theirs = (await request(app).post('/api/auth/login').send({ email, password: DEFAULT_PASSWORD })).body.token;

    await request(app).put('/api/auth/password')
      .set('Authorization', `Bearer ${mine}`)
      .send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'An0therStr0ng!pw' });
  });

  it('kills the other session', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${theirs}`);
    expect(res.status).toBe(401);
  });

  it('keeps the session that made the change', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${mine}`);
    expect(res.status).toBe(200);
  });

  it('leaves exactly one session live', async () => {
    expect(await Session.count({ where: { userId: user.id, revoked: false } })).toBe(1);
  });

  it('reports how many were signed out', async () => {
    const second = (await request(app).post('/api/auth/login').send({ email, password: 'An0therStr0ng!pw' })).body.token;
    const res = await request(app).put('/api/auth/password')
      .set('Authorization', `Bearer ${second}`)
      .send({ currentPassword: 'An0therStr0ng!pw', newPassword: 'Y3tAn0ther!pass' });
    expect(res.body.otherSessionsRevoked).toBe(1);
  });
});

describe('The email verification code is guess-limited on the account', () => {
  /*
   * The route's IP limiter was the only thing between a six-digit code and a
   * distributed guesser, and this code issues a session — guessing it is a
   * takeover of a newly registered account. The phone path already counted
   * failures against the account; only the email half did not.
   */
  const wrongCode = (i) => String(100000 + i);
  let email;
  let user;

  beforeEach(async () => {
    email = uniqueEmail('codelock');
    user = await createUser({
      email,
      emailVerified: false,
      emailVerificationCode: '123456',
      emailVerificationExpires: new Date(Date.now() + 15 * 60 * 1000),
    });
    // Spread across addresses so the per-IP limiter is not what stops this.
    for (let i = 0; i < 6; i++) {
      await request(app).post('/api/auth/verify-email')
        .set('X-Forwarded-For', `10.0.0.${i}`)
        .send({ email, code: wrongCode(i) });
    }
    await user.reload();
  });

  it('locks the account after repeated wrong codes', () => {
    expect(new Date(user.lockedUntil).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses even the correct code while locked', async () => {
    const res = await request(app).post('/api/auth/verify-email')
      .set('X-Forwarded-For', '10.9.9.9')
      .send({ email, code: '123456' });
    expect(res.status).toBe(423);
  });

  it('clears the counter once the right code is accepted', async () => {
    await user.update({ lockedUntil: null, failedLoginAttempts: 4 });
    const res = await request(app).post('/api/auth/verify-email')
      .set('X-Forwarded-For', '10.9.9.8')
      .send({ email, code: '123456' });
    expect(res.status).toBe(200);
    await user.reload();
    expect(user.failedLoginAttempts).toBe(0);
  });
});

describe('A device is only as authorised as the family above it', () => {
  /*
   * Device auth rested on `Device.isActive` alone. Blocking a parent revoked
   * their sessions and left every child device fully credentialed: still
   * posting activity and location, still reading its rules and its chat —
   * collecting a blocked family's children's whereabouts into a dashboard
   * nobody could open.
   */
  let parent;
  let child;
  let token;

  const deviceRoutes = [
    ['get', '/api/devices/me/rules'],
    ['get', '/api/devices/me/contacts'],
    ['get', '/api/chats/me/messages'],
    ['post', '/api/devices/me/heartbeat'],
  ];

  beforeEach(async () => {
    parent = await createUser({ email: uniqueEmail('devchain') });
    child = await createChild(parent.id);
    const device = await createDevice(child.id);
    token = deviceToken(device);
  });

  it('works while the whole chain is active', async () => {
    const res = await request(app).get('/api/devices/me/rules').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  describe('once the parent is blocked', () => {
    beforeEach(async () => {
      const admin = await createUser({ email: uniqueEmail('admin'), role: 'super_admin' });
      await request(app).patch(`/api/admin/clients/${parent.id}/toggle-block`)
        .set('Authorization', `Bearer ${tokenFor(admin)}`);
    });

    it.each(deviceRoutes)('refuses %s %s', async (method, path) => {
      const res = await request(app)[method](path).set('Authorization', `Bearer ${token}`).send({});
      expect(res.status).toBe(401);
    });

    it('refuses a location fix', async () => {
      const res = await request(app).post('/api/locations')
        .set('Authorization', `Bearer ${token}`)
        .send({ latitude: 40.7, longitude: -73.9 });
      expect(res.status).toBe(401);
    });

    it('refuses an activity report', async () => {
      const res = await request(app).post('/api/devices/me/activity')
        .set('Authorization', `Bearer ${token}`)
        .send({ appName: 'Test', durationMinutes: 1 });
      expect(res.status).toBe(401);
    });

    it('works again once the parent is unblocked, with no per-device bookkeeping', async () => {
      const admin = await createUser({ email: uniqueEmail('admin'), role: 'super_admin' });
      await request(app).patch(`/api/admin/clients/${parent.id}/toggle-block`)
        .set('Authorization', `Bearer ${tokenFor(admin)}`);

      const res = await request(app).get('/api/devices/me/rules').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  });

  it('refuses a device whose child has been deactivated', async () => {
    await child.update({ isActive: false });
    const res = await request(app).get('/api/devices/me/rules').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('still refuses a device revoked on its own', async () => {
    await Device.update({ isActive: false }, { where: { childId: child.id } });
    const res = await request(app).get('/api/devices/me/rules').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});
