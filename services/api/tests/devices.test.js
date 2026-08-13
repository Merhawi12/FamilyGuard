const request = require('supertest');
const { app } = require('../src/app');
const { Device, ActivityLog } = require('../src/models');
const { createUser, tokenFor, createChild, createDevice, deviceToken } = require('./helpers');

describe('Device linking flow', () => {
  it('generates a code, confirms from the device, and issues a working device token', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);

    const gen = await request(app)
      .post('/api/devices/link')
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ childId: child.id, deviceName: 'Kid Pixel' });
    expect(gen.status).toBe(200);
    expect(gen.body.code).toBeTruthy();

    const confirm = await request(app)
      .post('/api/devices/confirm')
      .send({ code: gen.body.code, deviceId: gen.body.device.id, osVersion: 'Android 14' });
    expect(confirm.status).toBe(200);
    expect(typeof confirm.body.deviceToken).toBe('string');

    // The issued token authenticates device-only routes.
    const rules = await request(app)
      .get('/api/devices/me/rules')
      .set('Authorization', `Bearer ${confirm.body.deviceToken}`);
    expect(rules.status).toBe(200);
    expect(rules.body).toHaveProperty('appRules');
  });

  it('rejects an invalid linking code (404) and a re-link of an already-linked device (400)', async () => {
    const bad = await request(app).post('/api/devices/confirm').send({ code: 'NOPE' });
    expect(bad.status).toBe(404);

    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id, { linkingCode: 'CODE1234', linkingCodeExpiry: new Date(Date.now() + 60000), isLinked: true });
    const relink = await request(app).post('/api/devices/confirm').send({ code: 'CODE1234', deviceId: device.id });
    expect(relink.status).toBe(400);
  });

  /* A code is a credential, and a credential that outlives its use is one more
     thing that can be replayed. This one used to sit on the row for the life of
     the device, with only the `isLinked` flag standing between it and a second
     link. */
  it('spends the code: it is cleared from the row and cannot be presented twice', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id, {
      isLinked: false, linkingCode: 'SPEND123', linkingCodeExpiry: new Date(Date.now() + 60000),
    });

    const confirm = await request(app).post('/api/devices/confirm').send({ code: 'SPEND123' });
    expect(confirm.status).toBe(200);

    const reloaded = await Device.findByPk(device.id);
    expect(reloaded.linkingCode).toBeNull();
    expect(reloaded.linkingCodeExpiry).toBeNull();
    // Gone, not merely refused — the second attempt cannot even find a row.
    expect((await request(app).post('/api/devices/confirm').send({ code: 'SPEND123' })).status).toBe(404);
    // And the spent code must not be handed back to the caller.
    expect(confirm.body.device.linkingCode ?? null).toBeNull();
  });

  /* One code, one phone. The checks and the write are separate statements, so
     two requests arriving together — a double tap on a slow connection, or two
     API instances — could both see `isLinked === false` and both be issued a
     365-day token for the same row, only one of which the parent could remove. */
  it('issues one token when the same code is confirmed twice at once', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id, {
      isLinked: false, linkingCode: 'RACE1234', linkingCodeExpiry: new Date(Date.now() + 60000),
    });

    const results = await Promise.all([
      request(app).post('/api/devices/confirm').send({ code: 'RACE1234', deviceId: device.id }),
      request(app).post('/api/devices/confirm').send({ code: 'RACE1234', deviceId: device.id }),
    ]);

    const granted = results.filter((r) => r.status === 200);
    expect(granted).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(1);
  });

  /* Codes are uppercase hex. The child app upper-cases what was typed, but the
     API refusing a lowercase code makes a client bug indistinguishable from a
     typo — for a family, an eternal "that code was not recognised". */
  it('accepts the code in any case', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    await createDevice(child.id, {
      isLinked: false, linkingCode: 'ABCDEF12', linkingCodeExpiry: new Date(Date.now() + 60000),
    });

    const res = await request(app).post('/api/devices/confirm').send({ code: '  abcdef12 ' });
    expect(res.status).toBe(200);
  });
});

/**
 * A link that must not be granted.
 *
 * Every case here used to answer 200 with a real device token. The phone stored
 * it, showed itself connected and moved on to the permissions screen — and then
 * every call it made was refused, because `authenticateDevice` re-asks the
 * question `confirm` had not: is this device, its child and their parent all
 * still active? The parent saw nothing at all, because a device on a removed row
 * or a removed child is filtered out of every list they can open.
 */
describe('Confirming a link the account can no longer honour', () => {
  const codedDevice = (childId, overrides) => createDevice(childId, {
    isLinked: false,
    linkingCode: overrides?.linkingCode || `C${Math.random().toString(16).slice(2, 9).toUpperCase()}`,
    linkingCodeExpiry: new Date(Date.now() + 60000),
    ...overrides,
  });

  it('refuses a code belonging to a device the parent removed (410)', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const auth = `Bearer ${tokenFor(parent)}`;

    const gen = await request(app).post('/api/devices/link').set('Authorization', auth)
      .send({ childId: child.id, deviceName: 'Phone' });
    await request(app).delete(`/api/devices/${gen.body.device.id}`).set('Authorization', auth).expect(200);

    const confirm = await request(app).post('/api/devices/confirm')
      .send({ code: gen.body.code, deviceId: gen.body.device.id });
    expect(confirm.status).toBe(410);
    expect(confirm.body.error).toMatch(/removed/i);
    expect(confirm.body.deviceToken).toBeUndefined();

    // The dead row must not be flipped to "linked" on the way out — the parent
    // has no screen that could show it, and nothing could ever unlink it.
    const reloaded = await Device.findByPk(gen.body.device.id);
    expect(reloaded.isLinked).toBe(false);
  });

  it('refuses a code whose child was removed (410)', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await codedDevice(child.id);
    // Deactivate the child alone: the device row stays active, which is the
    // state a removal that predates the cascade leaves behind.
    await child.update({ isActive: false });

    const res = await request(app).post('/api/devices/confirm').send({ code: device.linkingCode });
    expect(res.status).toBe(410);
  });

  it('refuses a code whose parent account is blocked (403)', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await codedDevice(child.id);
    await parent.update({ isActive: false });

    const res = await request(app).post('/api/devices/confirm').send({ code: device.linkingCode });
    expect(res.status).toBe(403);
    expect(res.body.deviceToken).toBeUndefined();
  });

  it('will not issue a code for a child that has been removed (404)', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const auth = `Bearer ${tokenFor(parent)}`;
    await request(app).delete(`/api/children/${child.id}`).set('Authorization', auth).expect(200);

    const res = await request(app).post('/api/devices/link').set('Authorization', auth)
      .send({ childId: child.id, deviceName: 'Ghost' });
    expect(res.status).toBe(404);
    // No orphan row: it would be invisible in every parent-facing list, would
    // not count against the plan allowance, and could never be linked.
    expect(await Device.count({ where: { childId: child.id, isActive: true } })).toBe(0);
  });
});

/**
 * The refusal has to say which kind of refusal it is.
 *
 * A removed device is permanent and the phone should forget its token; a blocked
 * parent is temporary and it must not. Both were "Device revoked", so the child
 * app could not tell them apart and did neither.
 */
describe('A refused device token says why', () => {
  it('reports a removed device as permanently unlinked', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const token = deviceToken(device);

    await request(app).delete(`/api/devices/${device.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`).expect(200);

    const res = await request(app).get('/api/devices/me/rules').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('device_unlinked');
  });

  it('reports a blocked parent as suspended, not unlinked', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const token = deviceToken(device);

    await parent.update({ isActive: false });

    const res = await request(app).get('/api/devices/me/rules').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    // Unblocking restores this device; a phone that wiped itself here would need
    // a code from an account that cannot sign in to issue one.
    expect(res.body.code).toBe('account_suspended');
  });

  it('reports a deactivated child as suspended too', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const token = deviceToken(device);

    await child.update({ isActive: false });

    const res = await request(app).get('/api/devices/me/rules').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('account_suspended');
  });
});

describe('Managing a linked device', () => {
  it('forbids removing a device that belongs to another parent (403)', async () => {
    const owner = await createUser();
    const child = await createChild(owner.id);
    const device = await createDevice(child.id);

    const attacker = await createUser();
    const res = await request(app)
      .delete(`/api/devices/${device.id}`)
      .set('Authorization', `Bearer ${tokenFor(attacker)}`);
    expect(res.status).toBe(403);
    const reloaded = await Device.findByPk(device.id);
    expect(reloaded.isActive).toBe(true);
  });

  /* Removal is a soft delete. The children list nests devices and used to
     include the deactivated ones, so the card stayed on screen after a delete
     and the button read as broken. */
  it('drops a removed device from the children list, keeping the child itself', async () => {
    const parent = await createUser();
    const auth = `Bearer ${tokenFor(parent)}`;
    const child = await createChild(parent.id);
    const keep = await createDevice(child.id, { name: 'Keep' });
    const drop = await createDevice(child.id, { name: 'Drop' });

    const before = await request(app).get('/api/children').set('Authorization', auth);
    expect(before.body[0].devices).toHaveLength(2);

    const del = await request(app).delete(`/api/devices/${drop.id}`).set('Authorization', auth);
    expect(del.status).toBe(200);

    const after = await request(app).get('/api/children').set('Authorization', auth);
    expect(after.body).toHaveLength(1); // the child must survive the filter
    expect(after.body[0].devices.map((d) => d.id)).toEqual([keep.id]);
  });

  it('still lists a child that has no devices at all', async () => {
    const parent = await createUser();
    const auth = `Bearer ${tokenFor(parent)}`;
    const child = await createChild(parent.id);
    const only = await createDevice(child.id);
    await request(app).delete(`/api/devices/${only.id}`).set('Authorization', auth);

    // An inner join on the active-device filter would make this child vanish.
    const res = await request(app).get('/api/children').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].devices).toEqual([]);
  });

  it('refuses to anchor a hand-set location on a removed device', async () => {
    // GPS tracking is a paid feature; a free plan would 403 at the gate first.
    const parent = await createUser({ plan: 'premium' });
    const auth = `Bearer ${tokenFor(parent)}`;
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    await request(app).delete(`/api/devices/${device.id}`).set('Authorization', auth);

    const res = await request(app)
      .post(`/api/locations/${child.id}/manual`)
      .set('Authorization', auth)
      .send({ latitude: 43.6532, longitude: -79.3832 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/link a device/i);
  });
});

/* A device row is created the moment a code is generated, but the code lasts 30
   minutes and the sheet showing it does not survive being closed. These cover
   finishing that half-done link later instead of deleting the row. */
describe('A device that was never connected', () => {
  const pending = (childId, overrides) => createDevice(childId, { isLinked: false, ...overrides });

  it('gets a fresh code that the child app can actually confirm with', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await pending(child.id, { linkingCode: 'OLD12345', linkingCodeExpiry: new Date(Date.now() - 1000) });

    const res = await request(app)
      .post(`/api/devices/${device.id}/link`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`);
    expect(res.status).toBe(200);
    expect(res.body.code).toBeTruthy();
    expect(res.body.code).not.toBe('OLD12345');
    expect(res.body.qrCode).toMatch(/^data:image\/png;base64,/);

    // The expired code must not still work alongside the new one.
    const stale = await request(app).post('/api/devices/confirm').send({ code: 'OLD12345', deviceId: device.id });
    expect(stale.status).toBe(404);

    const confirm = await request(app)
      .post('/api/devices/confirm')
      .send({ code: res.body.code, deviceId: device.id });
    expect(confirm.status).toBe(200);
    expect(typeof confirm.body.deviceToken).toBe('string');
  });

  it('refuses a new code for a device that is already connected (400)', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id); // helper links by default

    const res = await request(app)
      .post(`/api/devices/${device.id}/link`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`);
    expect(res.status).toBe(400);
  });

  it('will not issue a code for another parent device (403)', async () => {
    const owner = await createUser();
    const child = await createChild(owner.id);
    const device = await pending(child.id);

    const attacker = await createUser();
    const res = await request(app)
      .post(`/api/devices/${device.id}/link`)
      .set('Authorization', `Bearer ${tokenFor(attacker)}`);
    expect(res.status).toBe(403);
  });
});

describe('Editing a device', () => {
  it('renames it and changes its type', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id, { name: 'A', type: 'android' });

    const res = await request(app)
      .patch(`/api/devices/${device.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ name: '  Sarah iPad  ', type: 'ios' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Sarah iPad'); // trimmed
    expect(res.body.type).toBe('ios');

    const reloaded = await Device.findByPk(device.id);
    expect(reloaded.name).toBe('Sarah iPad');
  });

  it('rejects a blank name and an unknown type (400)', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const auth = `Bearer ${tokenFor(parent)}`;

    const blank = await request(app).patch(`/api/devices/${device.id}`).set('Authorization', auth).send({ name: '   ' });
    expect(blank.status).toBe(400);

    const badType = await request(app).patch(`/api/devices/${device.id}`).set('Authorization', auth).send({ type: 'toaster' });
    expect(badType.status).toBe(400);

    const reloaded = await Device.findByPk(device.id);
    expect(reloaded.name).toBe('Kid Phone');
  });

  it('will not let another parent edit it (403)', async () => {
    const owner = await createUser();
    const child = await createChild(owner.id);
    const device = await createDevice(child.id);

    const attacker = await createUser();
    const res = await request(app)
      .patch(`/api/devices/${device.id}`)
      .set('Authorization', `Bearer ${tokenFor(attacker)}`)
      .send({ name: 'Pwned' });
    expect(res.status).toBe(403);
    const reloaded = await Device.findByPk(device.id);
    expect(reloaded.name).toBe('Kid Phone');
  });
});

/* The Free plan sells "1 child device" and nothing used to enforce it. The
   limit bites where the device row is created — when a code is issued, not when
   the phone confirms — or a parent could mint unlimited pending devices. */
describe('Plan device allowance', () => {
  const link = (user, childId) =>
    request(app)
      .post('/api/devices/link')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({ childId, deviceName: 'Phone' });

  it('lets a Free account link its one device, then refuses the second', async () => {
    const parent = await createUser({ plan: 'free' });
    const child = await createChild(parent.id);

    const first = await link(parent, child.id);
    expect(first.status).toBe(200);

    const second = await link(parent, child.id);
    expect(second.status).toBe(403);
    expect(second.body.upgradeRequired).toBe(true);
    expect(second.body.limit).toBe(1);
  });

  it('counts across children, not per child', async () => {
    const parent = await createUser({ plan: 'free' });
    const [a, b] = [await createChild(parent.id), await createChild(parent.id, { name: 'Second' })];

    expect((await link(parent, a.id)).status).toBe(200);
    // A second child must not reset the allowance — the plan sells one device
    // for the account, not one per profile.
    expect((await link(parent, b.id)).status).toBe(403);
  });

  it('frees the slot again when the device is removed', async () => {
    const parent = await createUser({ plan: 'free' });
    const child = await createChild(parent.id);
    const auth = `Bearer ${tokenFor(parent)}`;

    const first = await link(parent, child.id);
    await request(app).delete(`/api/devices/${first.body.device.id}`).set('Authorization', auth);

    // Removal is a soft delete; a deactivated row must not keep holding a slot.
    expect((await link(parent, child.id)).status).toBe(200);
  });

  it('gives an active trial the Premium allowance', async () => {
    const parent = await createUser({ plan: 'free', trialEndsAt: new Date(Date.now() + 3 * 86400000) });
    const child = await createChild(parent.id);

    expect((await link(parent, child.id)).status).toBe(200);
    expect((await link(parent, child.id)).status).toBe(200);
    expect((await link(parent, child.id)).status).toBe(200);
  });

  it('does not limit Premium', async () => {
    const parent = await createUser({ plan: 'premium' });
    const child = await createChild(parent.id);

    for (let i = 0; i < 4; i += 1) {
      expect((await link(parent, child.id)).status).toBe(200);
    }
  });

  it('leaves an account that is already over its allowance alone', async () => {
    // Downgrades and the newly-enforced limit both create this state. Cutting
    // existing devices off would stop monitoring a child without warning; the
    // limit only blocks adding another.
    const parent = await createUser({ plan: 'free' });
    const child = await createChild(parent.id);
    await createDevice(child.id, { name: 'One' });
    await createDevice(child.id, { name: 'Two' });

    const res = await request(app)
      .get('/api/devices')
      .set('Authorization', `Bearer ${tokenFor(parent)}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    expect((await link(parent, child.id)).status).toBe(403);
  });
});

describe('Usage-stats ingestion is idempotent per app/day (batch A regression)', () => {
  it('upserts a single row and keeps the max cumulative minutes', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const token = deviceToken(device);

    const post = (durationMinutes) =>
      request(app)
        .post('/api/devices/me/activity')
        .set('Authorization', `Bearer ${token}`)
        .send({ appPackage: 'com.tiktok', appName: 'TikTok', category: 'app_usage', durationMinutes });

    await post(10); // first sync of the day
    await post(25); // later sync — cumulative grew
    await post(20); // a partial/late sync must not shrink the total

    const rows = await ActivityLog.findAll({ where: { childId: child.id, appPackage: 'com.tiktok', category: 'app_usage' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].durationMinutes).toBe(25);
  });

  /**
   * The case the test above cannot see, because it posts no `startTime` at all.
   *
   * The device always sends one. `UsageStatsModule.getUsageStats` measures from
   * the *phone's* local midnight and reports only a running total — no start
   * instant — so `monitoring.js` synthesises `startTime` as `now - minutes`.
   * The server then looked for today's row using *its own* midnight, and Cloud
   * Run keeps UTC while the families are in Canada. From roughly 20:00 local
   * the server's day has already rolled over, so that synthesised instant is
   * yesterday by the server's clock, the lookup misses, and every sync from
   * then until the child stops using the phone appends another row.
   *
   * `getDailySummary` sums `durationMinutes` over the rows it finds, so the
   * parent's screen-time report grew by the whole day's total every fifteen
   * minutes, every evening — the one number the product exists to report.
   */
  it('folds the evening syncs onto one row when the server day has already rolled over', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const token = deviceToken(device);

    // Anchored to the server's own midnight so this is the same test whatever
    // time of day it runs at: the phone's usage window opened before it.
    const deviceDayStart = new Date();
    deviceDayStart.setHours(0, 0, 0, 0);
    deviceDayStart.setMinutes(deviceDayStart.getMinutes() - 90);

    const post = (durationMinutes, startTime) =>
      request(app)
        .post('/api/devices/me/activity')
        .set('Authorization', `Bearer ${token}`)
        .send({
          appPackage: 'com.tiktok',
          appName: 'TikTok',
          category: 'app_usage',
          durationMinutes,
          startTime: startTime.toISOString(),
          endTime: new Date().toISOString(),
        });

    // Three background syncs of one usage day. The synthesised start drifts
    // later whenever the child puts the phone down, which is why it cannot be
    // matched exactly and has to be bucketed.
    await post(140, deviceDayStart);
    await post(155, new Date(deviceDayStart.getTime() + 4 * 60000));
    await post(150, new Date(deviceDayStart.getTime() + 9 * 60000));

    const rows = await ActivityLog.findAll({
      where: { childId: child.id, appPackage: 'com.tiktok', category: 'app_usage' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].durationMinutes).toBe(155);
  });

  it('starts a new row when the phone rolls over into its next usage day', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const token = deviceToken(device);

    const post = (durationMinutes, startTime) =>
      request(app)
        .post('/api/devices/me/activity')
        .set('Authorization', `Bearer ${token}`)
        .send({
          appPackage: 'com.tiktok',
          appName: 'TikTok',
          category: 'app_usage',
          durationMinutes,
          startTime: startTime.toISOString(),
        });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    await post(220, yesterday);
    await post(6, today);

    // Two days, two rows — and yesterday's total is not carried into today by
    // the `Math.max` that stops a partial sync shrinking the current day.
    const rows = await ActivityLog.findAll({
      where: { childId: child.id, appPackage: 'com.tiktok', category: 'app_usage' },
      order: [['startTime', 'ASC']],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.durationMinutes)).toEqual([220, 6]);
  });

  it('still appends discrete non-usage events (e.g. web visits)', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const token = deviceToken(device);

    const post = () =>
      request(app)
        .post('/api/devices/me/activity')
        .set('Authorization', `Bearer ${token}`)
        .send({ category: 'web', url: 'https://example.com', startTime: new Date().toISOString(), durationMinutes: 1 });

    await post();
    await post();
    const rows = await ActivityLog.findAll({ where: { childId: child.id, category: 'web' } });
    expect(rows.length).toBe(2);
  });
});
