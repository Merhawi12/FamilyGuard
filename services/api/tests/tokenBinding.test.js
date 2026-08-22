/**
 * A device token describes a pairing, and the pairing is the device row.
 *
 * `confirmLink` mints `{ deviceId, childId }` from one row, so the two claims
 * always agree — and every child-scoped read downstream (`/devices/me/rules`,
 * `/devices/me/contacts`, `POST /locations`, the chat thread) was nonetheless
 * taking the child from the *token* while every authorisation decision above it
 * was made against the *device*. That is one signing-key mistake, one
 * relink-to-a-different-child feature, or one hand-minted token away from being
 * a cross-family read of a child's location.
 *
 * These tests hold the two halves together: identity comes from the row, and a
 * token that disagrees with the row is refused rather than believed.
 */
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { app } = require('../src/app');
const { createUser, createChild, createDevice, uniqueEmail, tokenFor } = require('./helpers');

/** A signed device token naming whatever child the caller wants it to name. */
const forgedDeviceToken = (deviceId, childId) =>
  jwt.sign({ deviceId, childId }, process.env.JWT_SECRET, { expiresIn: '1h' });

describe('a device token may not name a child other than its own', () => {
  let victimChild;
  let attackerDevice;

  beforeEach(async () => {
    const victimParent = await createUser({ email: uniqueEmail('victim') });
    victimChild = await createChild(victimParent.id, { name: 'Victim Kid' });

    const attackerParent = await createUser({ email: uniqueEmail('attacker') });
    const attackerChild = await createChild(attackerParent.id, { name: 'Own Kid' });
    attackerDevice = await createDevice(attackerChild.id);
  });

  it('refuses a REST call whose token points at a stranger’s child', async () => {
    const res = await request(app)
      .get('/api/devices/me/rules')
      .set('Authorization', `Bearer ${forgedDeviceToken(attackerDevice.id, victimChild.id)}`)
      .expect(401);

    // Reported as an unlinked device, which is what a token describing a pairing
    // that does not exist is.
    expect(res.body.code).toBe('device_unlinked');
  });

  it('refuses to post a location against a stranger’s child', async () => {
    await request(app)
      .post('/api/locations')
      .set('Authorization', `Bearer ${forgedDeviceToken(attackerDevice.id, victimChild.id)}`)
      .send({ latitude: 43.65, longitude: -79.38 })
      .expect(401);
  });

  it('refuses to read a stranger’s chat thread', async () => {
    await request(app)
      .get('/api/chats/me/messages')
      .set('Authorization', `Bearer ${forgedDeviceToken(attackerDevice.id, victimChild.id)}`)
      .expect(401);
  });

  it('still admits a token that agrees with its device row', async () => {
    await request(app)
      .get('/api/devices/me/rules')
      .set('Authorization', `Bearer ${forgedDeviceToken(attackerDevice.id, attackerDevice.childId)}`)
      .expect(200);
  });
});

describe('notification preferences are a fixed set of switches', () => {
  let user;
  let auth;

  beforeEach(async () => {
    user = await createUser({ email: uniqueEmail('prefs') });
    auth = `Bearer ${tokenFor(user)}`;
  });

  const put = (body) =>
    request(app).put('/api/auth/notification-prefs').set('Authorization', auth).send(body);

  it('saves the switches the screen actually has', async () => {
    const res = await put({
      emailAlerts: false,
      alertTypes: { blocked_app_attempt: true },
    }).expect(200);

    expect(res.body.emailAlerts).toBe(false);
    expect(res.body.alertTypes.blocked_app_attempt).toBe(true);

    // Read back through the getter, which is where the defaults are applied —
    // the writer stores only what was set, so a switch nobody has touched is
    // absent from the row and comes from the defaults on the way out.
    const read = await request(app)
      .get('/api/auth/notification-prefs')
      .set('Authorization', auth)
      .expect(200);

    expect(read.body.emailAlerts).toBe(false);
    expect(read.body.alertTypes.blocked_app_attempt).toBe(true);
    expect(read.body.alertTypes.emergency_button).toBe(true);
  });

  /**
   * `{ ...current, ...req.body }` made this endpoint an arbitrary write into a
   * column on the user row: keys of any name, values of any shape, nested to any
   * depth, up to the body limit, persisted and echoed back on every read.
   */
  it('drops keys that are not settings', async () => {
    const res = await put({
      emailAlerts: true,
      role: 'super_admin',
      plan: 'premium',
      injected: { deeply: { nested: 'x'.repeat(100) } },
    }).expect(200);

    expect(res.body.role).toBeUndefined();
    expect(res.body.plan).toBeUndefined();
    expect(res.body.injected).toBeUndefined();

    // And nothing reached the row itself — the blob is a column, not a document.
    const reloaded = await user.reload();
    expect(reloaded.role).toBe('parent');
    expect(JSON.parse(reloaded.notificationPrefs).injected).toBeUndefined();
  });

  it('drops alert types the platform does not have', async () => {
    const res = await put({ alertTypes: { made_up_type: true } }).expect(200);

    expect(res.body.alertTypes.made_up_type).toBeUndefined();
  });

  it('stores the switches as booleans whatever was sent', async () => {
    const res = await put({ emailAlerts: 'yes', alertTypes: { cyberbullying: 0 } }).expect(200);

    expect(res.body.emailAlerts).toBe(true);
    expect(res.body.alertTypes.cyberbullying).toBe(false);
  });

  /** An `alertTypes` that is not an object must not throw or wipe the entry. */
  it('ignores a malformed alertTypes rather than failing the save', async () => {
    await put({ alertTypes: { cyberbullying: false } }).expect(200);
    const res = await put({ alertTypes: ['cyberbullying'] }).expect(200);

    expect(res.body.alertTypes.cyberbullying).toBe(false);
  });
});
