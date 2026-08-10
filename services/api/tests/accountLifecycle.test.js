/**
 * The two ends of owning an account: seeing where it is signed in, and closing it.
 *
 * Neither existed. The platform emails an account holder the moment their
 * account is opened from a device it does not recognise, and then offered them
 * nothing to do about it — no list of sessions, no way to end one. The only
 * lever was changing the password, which signs out the phone they are reading
 * the email on as well as the intruder.
 *
 * And there was no way to leave at all: no endpoint, no button, nothing. For a
 * service holding a child's location history, contacts and browsing that is a
 * legal problem (the right to erasure) before it is a missing feature, and the
 * family app ships on Google Play, which requires an in-app route to it.
 */
const request = require('supertest');
const Stripe = require('stripe'); // the manual mock in __mocks__/stripe.js
const { app } = require('../src/app');
const {
  User, Session, Child, Device, ActivityLog, Location, AppRule, WebsiteRule,
  ScreenTimeRule, Message, Contact, Alert, SafeZone, Notification, AuditLog,
} = require('../src/models');
const { createUser, createChild, createDevice, DEFAULT_PASSWORD } = require('./helpers');

const signIn = (email, agent = 'Chrome/Test') =>
  request(app).post('/api/auth/login').set('User-Agent', agent).send({ email, password: DEFAULT_PASSWORD });

describe('an account holder can see where their account is signed in', () => {
  it('lists a session per device, marking the one asking', async () => {
    const user = await createUser();

    const first = await signIn(user.email, 'Chrome/Laptop').expect(200);
    await signIn(user.email, 'Firefox/Phone').expect(200);

    const res = await request(app)
      .get('/api/auth/sessions')
      .set('Authorization', `Bearer ${first.body.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((s) => s.userAgent).sort()).toEqual(['Chrome/Laptop', 'Firefox/Phone']);
    expect(res.body.filter((s) => s.current)).toHaveLength(1);
    expect(res.body.find((s) => s.current).userAgent).toBe('Chrome/Laptop');
  });

  it('never shows another account\'s sessions', async () => {
    const mine = await createUser();
    const theirs = await createUser();
    const me = await signIn(mine.email);
    await signIn(theirs.email);

    const res = await request(app)
      .get('/api/auth/sessions')
      .set('Authorization', `Bearer ${me.body.token}`);

    expect(res.body).toHaveLength(1);
  });

  it('leaves out a session that has already been revoked', async () => {
    const user = await createUser();
    const keep = await signIn(user.email, 'Chrome/Laptop');
    const drop = await signIn(user.email, 'Firefox/Phone');

    const before = await request(app).get('/api/auth/sessions').set('Authorization', `Bearer ${keep.body.token}`);
    const target = before.body.find((s) => !s.current);

    await request(app)
      .delete(`/api/auth/sessions/${target.id}`)
      .set('Authorization', `Bearer ${keep.body.token}`)
      .expect(200);

    const after = await request(app).get('/api/auth/sessions').set('Authorization', `Bearer ${keep.body.token}`);
    expect(after.body).toHaveLength(1);
    expect(after.body[0].current).toBe(true);

    // And the token that session issued really stops working — the point of the
    // button is eviction, not a tidier list.
    const dead = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${drop.body.token}`);
    expect(dead.status).toBe(401);
  });

  it('refuses to revoke a session belonging to someone else', async () => {
    const mine = await createUser();
    const theirs = await createUser();
    const me = await signIn(mine.email);
    await signIn(theirs.email);
    const theirSession = await Session.findOne({ where: { userId: theirs.id } });

    const res = await request(app)
      .delete(`/api/auth/sessions/${theirSession.id}`)
      .set('Authorization', `Bearer ${me.body.token}`);

    expect(res.status).toBe(404);
    await theirSession.reload();
    expect(theirSession.revoked).toBe(false);
  });

  it('sends the caller to logout rather than revoking the session it is using', async () => {
    const user = await createUser();
    const me = await signIn(user.email);
    const list = await request(app).get('/api/auth/sessions').set('Authorization', `Bearer ${me.body.token}`);

    const res = await request(app)
      .delete(`/api/auth/sessions/${list.body[0].id}`)
      .set('Authorization', `Bearer ${me.body.token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sign out/i);
  });

  it('signs out every other device at once, keeping this one', async () => {
    const user = await createUser();
    const me = await signIn(user.email, 'Chrome/Laptop');
    await signIn(user.email, 'Firefox/Phone');
    await signIn(user.email, 'Safari/Tablet');

    const res = await request(app)
      .delete('/api/auth/sessions/others')
      .set('Authorization', `Bearer ${me.body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(2);

    const still = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${me.body.token}`);
    expect(still.status).toBe(200);
  });
});

describe('staff deleting a client erases the same things the client would', () => {
  /*
   * `deleteClient` was `client.destroy()` and nothing else. Every child profile,
   * every linked device, and all of their location history, messages, contacts
   * and browsing stayed in the database with no account above them to reach it
   * from — for a minor, indefinitely. Deleting a customer is the moment that
   * data is supposed to stop existing, and this was the only door staff had.
   */
  const jwt = require('jsonwebtoken');

  it('takes the children and their data with the account', async () => {
    const staff = await createUser({ role: 'super_admin' });
    const staffToken = jwt.sign({ id: staff.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const client = await createUser();
    const child = await createChild(client.id);
    const device = await createDevice(child.id);
    await ActivityLog.create({
      childId: child.id, deviceId: device.id, category: 'app_usage',
      appName: 'TikTok', appPackage: 'com.tiktok', durationMinutes: 5, startTime: new Date(),
    });
    await Location.create({ childId: child.id, deviceId: device.id, latitude: 45.4, longitude: -75.7 });
    await Contact.create({ childId: child.id, parentId: client.id, name: 'Gran', phone: '+15551230001' });

    const res = await request(app)
      .delete(`/api/admin/clients/${client.id}`)
      .set('Authorization', `Bearer ${staffToken}`);

    expect(res.status).toBe(200);
    expect(await User.findByPk(client.id)).toBeNull();
    expect(await Child.count({ where: { parentId: client.id } })).toBe(0);
    expect(await Device.count({ where: { childId: child.id } })).toBe(0);
    expect(await ActivityLog.count({ where: { childId: child.id } })).toBe(0);
    expect(await Location.count({ where: { childId: child.id } })).toBe(0);
    expect(await Contact.count({ where: { childId: child.id } })).toBe(0);
  });

  it('still refuses to touch a staff account through this door', async () => {
    const superAdmin = await createUser({ role: 'super_admin' });
    const token = jwt.sign({ id: superAdmin.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const colleague = await createUser({ role: 'support' });

    const res = await request(app)
      .delete(`/api/admin/clients/${colleague.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(await User.findByPk(colleague.id)).not.toBeNull();
  });
});

describe('an account with no password can set one', () => {
  /*
   * A Google or phone sign-up has no `passwordHash`, and `changePassword`
   * demanded a current password it could never match — so the settings screen
   * showed the form and every submission answered "Current password is
   * incorrect". The account was permanently tied to the one provider it was
   * created with.
   */
  const jwt = require('jsonwebtoken');
  const tokenFor = (user) => jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

  it('says on /auth/me whether there is one', async () => {
    const withOne = await createUser();
    const without = await createUser({ passwordHash: null, googleId: 'g-1' });

    const a = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenFor(withOne)}`);
    const b = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenFor(without)}`);

    expect(a.body.hasPassword).toBe(true);
    expect(b.body.hasPassword).toBe(false);
    // Whether one exists, never anything about what it is.
    expect(JSON.stringify(a.body)).not.toMatch(/\$2[aby]\$/);
  });

  it('sets the first one without asking for a current password', async () => {
    const user = await createUser({ passwordHash: null, googleId: 'g-2' });

    const res = await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ newPassword: 'brand-new-pw-9' });

    expect(res.status).toBe(200);
    await user.reload();
    expect(await user.comparePassword('brand-new-pw-9')).toBe(true);
  });

  it('lets that account then sign in with it', async () => {
    const user = await createUser({ passwordHash: null, googleId: 'g-3' });

    await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ newPassword: 'brand-new-pw-9' })
      .expect(200);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'brand-new-pw-9' });

    expect(login.status).toBe(200);
    expect(login.body.token).toEqual(expect.any(String));
  });

  it('still demands the current one once there is one', async () => {
    const user = await createUser();

    const res = await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ newPassword: 'brand-new-pw-9' });

    expect(res.status).toBe(400);
  });

  it('holds a first password to the same strength rule', async () => {
    const user = await createUser({ passwordHash: null, googleId: 'g-4' });

    const res = await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ newPassword: 'short' });

    expect(res.status).toBe(400);
  });
});

describe('an account holder can close their account', () => {
  it('refuses without the password', async () => {
    const user = await createUser();
    const me = await signIn(user.email);

    const res = await request(app)
      .delete('/api/auth/account')
      .set('Authorization', `Bearer ${me.body.token}`)
      .send({});

    expect(res.status).toBe(401);
    expect(await User.findByPk(user.id)).not.toBeNull();
  });

  it('refuses with the wrong password', async () => {
    const user = await createUser();
    const me = await signIn(user.email);

    const res = await request(app)
      .delete('/api/auth/account')
      .set('Authorization', `Bearer ${me.body.token}`)
      .send({ password: 'not-the-password' });

    expect(res.status).toBe(401);
    expect(await User.findByPk(user.id)).not.toBeNull();
  });

  it('takes the account and everything hanging off it', async () => {
    const user = await createUser();
    const me = await signIn(user.email);
    const child = await createChild(user.id);
    const device = await createDevice(child.id);

    await ScreenTimeRule.create({ childId: child.id });
    await AppRule.create({ childId: child.id, appName: 'TikTok', appPackage: 'com.tiktok' });
    await WebsiteRule.create({ childId: child.id, url: 'example.com', action: 'block' });
    await ActivityLog.create({
      childId: child.id, deviceId: device.id, category: 'app_usage',
      appName: 'TikTok', appPackage: 'com.tiktok', durationMinutes: 5, startTime: new Date(),
    });
    await Location.create({ childId: child.id, deviceId: device.id, latitude: 45.4, longitude: -75.7 });
    await Message.create({
      childId: child.id, parentId: user.id, senderId: user.id, senderRole: 'parent', text: 'hi',
    });
    await Contact.create({ childId: child.id, parentId: user.id, name: 'Gran', phone: '+15551230000' });
    await Alert.create({ parentId: user.id, childId: child.id, type: 'emergency_button', message: 'x', severity: 'high' });
    await SafeZone.create({
      parentId: user.id, childId: child.id, name: 'Home',
      latitude: 45.4, longitude: -75.7, radiusMeters: 200,
    });
    await Notification.create({ userId: user.id, type: 'system', title: 't', message: 'm' });

    const res = await request(app)
      .delete('/api/auth/account')
      .set('Authorization', `Bearer ${me.body.token}`)
      .send({ password: DEFAULT_PASSWORD });

    expect(res.status).toBe(200);

    expect(await User.findByPk(user.id)).toBeNull();
    expect(await Child.count({ where: { parentId: user.id } })).toBe(0);
    expect(await Device.count({ where: { childId: child.id } })).toBe(0);
    expect(await ScreenTimeRule.count({ where: { childId: child.id } })).toBe(0);
    expect(await AppRule.count({ where: { childId: child.id } })).toBe(0);
    expect(await WebsiteRule.count({ where: { childId: child.id } })).toBe(0);
    expect(await ActivityLog.count({ where: { childId: child.id } })).toBe(0);
    expect(await Location.count({ where: { childId: child.id } })).toBe(0);
    expect(await Message.count({ where: { childId: child.id } })).toBe(0);
    expect(await Contact.count({ where: { parentId: user.id } })).toBe(0);
    expect(await Alert.count({ where: { parentId: user.id } })).toBe(0);
    expect(await SafeZone.count({ where: { parentId: user.id } })).toBe(0);
    expect(await Notification.count({ where: { userId: user.id } })).toBe(0);
    expect(await Session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('leaves the token dead behind it', async () => {
    const user = await createUser();
    const me = await signIn(user.email);

    await request(app)
      .delete('/api/auth/account')
      .set('Authorization', `Bearer ${me.body.token}`)
      .send({ password: DEFAULT_PASSWORD })
      .expect(200);

    const after = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${me.body.token}`);
    expect(after.status).toBe(401);
  });

  it('takes nothing belonging to anyone else', async () => {
    const leaving = await createUser();
    const staying = await createUser();
    const theirChild = await createChild(staying.id);
    await Alert.create({ parentId: staying.id, childId: theirChild.id, type: 'emergency_button', message: 'x', severity: 'high' });

    const me = await signIn(leaving.email);
    await request(app)
      .delete('/api/auth/account')
      .set('Authorization', `Bearer ${me.body.token}`)
      .send({ password: DEFAULT_PASSWORD })
      .expect(200);

    expect(await User.findByPk(staying.id)).not.toBeNull();
    expect(await Child.count({ where: { parentId: staying.id } })).toBe(1);
    expect(await Alert.count({ where: { parentId: staying.id } })).toBe(1);
  });

  it('records that it happened, without repeating what it erased', async () => {
    const user = await createUser();
    const me = await signIn(user.email);

    await request(app)
      .delete('/api/auth/account')
      .set('Authorization', `Bearer ${me.body.token}`)
      .send({ password: DEFAULT_PASSWORD })
      .expect(200);

    // The audit writer is fire-and-forget, so give it the turn it needs.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const entry = await AuditLog.findOne({ where: { action: 'auth.account_deleted', entityId: user.id } });
    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry.metadata || {})).not.toContain(user.email);
  });

  describe('and the subscription is stopped before anything is deleted', () => {
    afterEach(() => {
      Stripe.__mock.subscriptions.cancel.mockClear();
      Stripe.__mock.subscriptions.cancel.mockImplementation(async (id) => ({ id, status: 'canceled' }));
    });

    it('cancels a live subscription', async () => {
      const user = await createUser({ plan: 'premium', stripeSubscriptionId: 'sub_live' });
      const me = await signIn(user.email);

      await request(app)
        .delete('/api/auth/account')
        .set('Authorization', `Bearer ${me.body.token}`)
        .send({ password: DEFAULT_PASSWORD })
        .expect(200);

      expect(Stripe.__mock.subscriptions.cancel).toHaveBeenCalledWith('sub_live');
    });

    it('deletes nothing when the cancellation fails', async () => {
      /*
       * The order matters more than the failure does. Deleting first and
       * cancelling second would, on a Stripe outage, leave a card being charged
       * every month for an account whose owner no longer has a login to stop it
       * — and no record on our side that they were ever a customer.
       */
      Stripe.__mock.subscriptions.cancel.mockRejectedValueOnce(new Error('stripe is down'));

      const user = await createUser({ plan: 'premium', stripeSubscriptionId: 'sub_live' });
      const me = await signIn(user.email);

      const res = await request(app)
        .delete('/api/auth/account')
        .set('Authorization', `Bearer ${me.body.token}`)
        .send({ password: DEFAULT_PASSWORD });

      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/try again/i);
      expect(await User.findByPk(user.id)).not.toBeNull();
    });

    it('treats a subscription Stripe has already lost as cancelled', async () => {
      const gone = Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
      Stripe.__mock.subscriptions.cancel.mockRejectedValueOnce(gone);

      const user = await createUser({ plan: 'premium', stripeSubscriptionId: 'sub_stale' });
      const me = await signIn(user.email);

      await request(app)
        .delete('/api/auth/account')
        .set('Authorization', `Bearer ${me.body.token}`)
        .send({ password: DEFAULT_PASSWORD })
        .expect(200);

      expect(await User.findByPk(user.id)).toBeNull();
    });
  });

  describe('an account with no password to re-enter', () => {
    it('asks for the word instead', async () => {
      // Google and phone sign-ins have no `passwordHash`. Without this branch
      // they could never close their account at all.
      const user = await createUser({ passwordHash: null, googleId: 'google-123' });
      const { token } = (await request(app).post('/api/auth/google').send({ credential: 'x' })).body;
      // The Google endpoint is not what is under test here; sign the token the
      // same way the helpers do.
      const jwt = require('jsonwebtoken');
      const own = token || jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

      const refused = await request(app)
        .delete('/api/auth/account')
        .set('Authorization', `Bearer ${own}`)
        .send({});
      expect(refused.status).toBe(400);
      expect(await User.findByPk(user.id)).not.toBeNull();

      const done = await request(app)
        .delete('/api/auth/account')
        .set('Authorization', `Bearer ${own}`)
        .send({ confirm: 'DELETE' });
      expect(done.status).toBe(200);
      expect(await User.findByPk(user.id)).toBeNull();
    });
  });
});
