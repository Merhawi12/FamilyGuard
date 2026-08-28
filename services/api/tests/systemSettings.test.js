/**
 * The two Settings-screen controls that wrote a row and changed nothing.
 *
 * "Maintenance mode" and "Default trial period" both persisted to
 * `system_settings` and were read by no part of the platform. An operator who
 * turned maintenance on got a warning banner promising that "parents cannot sign
 * in", over a service that went on signing them in; an operator who set a
 * 14-day trial watched every new account get 7.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { User } = require('../src/models');
const { setSetting } = require('../src/utils/settings');
const { createUser, tokenFor, uniqueEmail, signIn, DEFAULT_PASSWORD } = require('./helpers');
const { ROLES, defaultPermissionsFor } = require('../src/config/roles');

// Settings persist in the shared schema, so each test states what it needs.
beforeEach(async () => {
  await setSetting('maintenanceMode', false);
  await setSetting('defaultTrialDays', 7);
});

/**
 * A whole sign-in, not just the password step — `signIn` drives the emailed
 * second factor too, and hands back whichever response carries the token.
 *
 * Maintenance mode is checked in both halves of that flow, so a helper that
 * stopped at `POST /auth/login` would be testing the gate on the door people no
 * longer come through: the pre-auth token outlives the switch being thrown, and
 * it is `login/verify` that has to refuse a challenge started before it.
 */
const login = (email, password = DEFAULT_PASSWORD) => signIn(email, password);

describe('maintenance mode — new sign-ins', () => {
  it('refuses a parent password sign-in with 503 while it is on', async () => {
    const email = uniqueEmail('maint');
    await createUser({ email });

    expect((await login(email)).status).toBe(200);

    await setSetting('maintenanceMode', true);

    const res = await login(email);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ maintenance: true });
    expect(res.body.token).toBeUndefined();
  });

  it('still lets staff in — they are who turns it back off', async () => {
    const email = uniqueEmail('boss');
    await createUser({
      email,
      role: ROLES.SUPER_ADMIN,
      permissions: defaultPermissionsFor(ROLES.SUPER_ADMIN),
    });

    await setSetting('maintenanceMode', true);

    const res = await login(email);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('does not disturb a session that was already open', async () => {
    const user = await createUser();
    const token = tokenFor(user);

    await setSetting('maintenanceMode', true);

    // Exactly what the console's banner promises: "Sessions already open are
    // not affected."
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('refuses a wrong password with 401, not 503 — maintenance leaks nothing', async () => {
    const email = uniqueEmail('maint');
    await createUser({ email });
    await setSetting('maintenanceMode', true);

    const res = await login(email, 'the-wrong-password');
    expect(res.status).toBe(401);
  });

  it('is reported by /auth/providers so the sign-in page can say so first', async () => {
    expect((await request(app).get('/api/auth/providers')).body.maintenance).toBe(false);

    await setSetting('maintenanceMode', true);

    expect((await request(app).get('/api/auth/providers')).body.maintenance).toBe(true);
  });

  it('blocks email verification from issuing a session', async () => {
    const email = uniqueEmail('verify');
    const user = await createUser({
      email,
      emailVerified: false,
      emailVerificationCode: '123456',
      emailVerificationExpires: new Date(Date.now() + 15 * 60 * 1000),
    });

    await setSetting('maintenanceMode', true);

    const res = await request(app).post('/api/auth/verify-email').send({ email, code: '123456' });

    expect(res.status).toBe(503);
    expect(res.body.token).toBeUndefined();
    // The address really was proved, and that is recorded whatever the mode.
    expect((await User.findByPk(user.id)).emailVerified).toBe(true);
  });
});

describe('default trial period', () => {
  const trialDaysFor = (user) =>
    Math.round((new Date(user.trialEndsAt) - Date.now()) / (24 * 60 * 60 * 1000));

  it('gives a new registration the configured length, not a hardcoded 7 days', async () => {
    await setSetting('defaultTrialDays', 14);

    const email = uniqueEmail('trial');
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Trial Parent', email, password: 'password1234' });
    expect(res.status).toBe(201);

    expect(trialDaysFor(await User.findByEmail(email))).toBe(14);
  });

  it('falls back to 7 days when nothing is configured', async () => {
    const email = uniqueEmail('trial');
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Trial Parent', email, password: 'password1234' });

    expect(trialDaysFor(await User.findByEmail(email))).toBe(7);
  });

  it('ignores a nonsensical value rather than issuing an already-expired trial', async () => {
    await setSetting('defaultTrialDays', 0);

    const email = uniqueEmail('trial');
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Trial Parent', email, password: 'password1234' });

    expect(trialDaysFor(await User.findByEmail(email))).toBe(7);
  });
});
