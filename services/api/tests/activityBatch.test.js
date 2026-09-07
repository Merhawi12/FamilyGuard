const request = require('supertest');
const { app } = require('../src/app');
const { ActivityLog, Device } = require('../src/models');
const { createUser, createChild, createDevice, deviceToken } = require('./helpers');

/**
 * `POST /api/devices/me/activity/batch` — a whole usage sync in one request.
 *
 * The child app and the desktop agent both used to post one request per app, in
 * an awaited loop, on every sync. What matters about the replacement is not that
 * it is faster but that it is *identical*: the single-item route is still live
 * for APKs already in the field, and the two handlers write to the same rows. A
 * batch that bucketed days differently, or let a late sync shrink a total, would
 * corrupt the one number this product exists to report — and would do it only on
 * the devices that had updated.
 *
 * So most of what is pinned here is equivalence with the old behaviour.
 */

/** The usage day the device reports against — its own local midnight. */
const deviceDayStart = () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start;
};

const send = (token, samples) =>
  request(app)
    .post('/api/devices/me/activity/batch')
    .set('Authorization', `Bearer ${token}`)
    .send({ samples });

const sample = (appPackage, durationMinutes, startTime = deviceDayStart()) => ({
  appPackage,
  appName: appPackage,
  category: 'app_usage',
  startTime: new Date(startTime).toISOString(),
  endTime: new Date().toISOString(),
  durationMinutes,
});

const setup = async () => {
  const parent = await createUser();
  const child = await createChild(parent.id);
  const device = await createDevice(child.id);
  return { parent, child, device, token: deviceToken(device) };
};

describe('Activity batch ingestion', () => {
  it('writes one row per app and reports what it did', async () => {
    const { child, token } = await setup();

    const res = await send(token, [
      sample('com.tiktok', 40),
      sample('com.youtube', 25),
      sample('com.chrome', 10),
    ]);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 3, updated: 0, unchanged: 0, rejected: 0, received: 3 });

    const rows = await ActivityLog.findAll({ where: { childId: child.id, category: 'app_usage' } });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.appPackage).sort()).toEqual(['com.chrome', 'com.tiktok', 'com.youtube']);
  });

  /**
   * The property the whole design rests on: the device sends today's *cumulative*
   * total every sync, so a second batch must land on the first batch's rows.
   * If this ever appends instead, `getDailySummary` sums the duplicates and the
   * parent's screen-time figure grows by a whole day every fifteen minutes.
   */
  it('upserts a single row per app and day across repeated syncs', async () => {
    const { child, token } = await setup();

    await send(token, [sample('com.tiktok', 40), sample('com.youtube', 25)]);
    const second = await send(token, [sample('com.tiktok', 55), sample('com.youtube', 25)]);

    expect(second.body).toMatchObject({ created: 0, updated: 1, unchanged: 1 });

    const rows = await ActivityLog.findAll({ where: { childId: child.id, category: 'app_usage' } });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.appPackage === 'com.tiktok').durationMinutes).toBe(55);
  });

  /** A late or partial sync must never shrink a total already recorded. */
  it('keeps the larger cumulative total when a sync reports less', async () => {
    const { child, token } = await setup();

    await send(token, [sample('com.tiktok', 90)]);
    await send(token, [sample('com.tiktok', 12)]);

    const rows = await ActivityLog.findAll({ where: { childId: child.id, appPackage: 'com.tiktok' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].durationMinutes).toBe(90);
  });

  /**
   * The single-item route is still what an APK in the field posts to. A household
   * mid-rollout has one phone on each, and both must land on the same row.
   */
  it('shares its rows with the single-item route', async () => {
    const { child, token } = await setup();

    await request(app)
      .post('/api/devices/me/activity')
      .set('Authorization', `Bearer ${token}`)
      .send(sample('com.tiktok', 30));

    const res = await send(token, [sample('com.tiktok', 45)]);
    expect(res.body).toMatchObject({ created: 0, updated: 1 });

    const rows = await ActivityLog.findAll({ where: { childId: child.id, appPackage: 'com.tiktok' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].durationMinutes).toBe(45);
  });

  /**
   * The evening rollover, which is where the per-item handler was caught before.
   * The device stamps every sample with its own local midnight; the server must
   * bucket by that, not by its own clock, or from ~20:00 Canadian time every
   * sync appends a fresh row carrying the whole day's total.
   */
  it('folds an evening sync onto the same row when the reported day is behind the server day', async () => {
    const { child, token } = await setup();

    const early = deviceDayStart();
    early.setMinutes(early.getMinutes() - 90);

    await send(token, [sample('com.tiktok', 140, early)]);
    await send(token, [sample('com.tiktok', 155, new Date(early.getTime() + 4 * 60000))]);
    await send(token, [sample('com.tiktok', 150, new Date(early.getTime() + 9 * 60000))]);

    const rows = await ActivityLog.findAll({
      where: { childId: child.id, appPackage: 'com.tiktok', category: 'app_usage' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].durationMinutes).toBe(155);
  });

  it('drops a malformed sample and counts it rather than failing the batch', async () => {
    const { child, token } = await setup();

    const res = await send(token, [
      sample('com.tiktok', 20),
      { category: 'app_usage', durationMinutes: 5 }, // no appPackage
      { appPackage: '   ', durationMinutes: 5 },
    ]);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, rejected: 2, received: 3 });
    expect(await ActivityLog.count({ where: { childId: child.id } })).toBe(1);
  });

  it('refuses a batch larger than the ceiling, and a body that is not an array', async () => {
    const { token } = await setup();

    const tooMany = await send(token, Array.from({ length: 201 }, (_, i) => sample(`com.app${i}`, 1)));
    expect(tooMany.status).toBe(400);

    const notAnArray = await send(token, undefined);
    expect(notAnArray.status).toBe(400);
  });

  it('refreshes the device as seen, even for an empty batch', async () => {
    const { device, token } = await setup();
    await Device.update({ lastSeen: new Date(0) }, { where: { id: device.id } });

    const res = await send(token, []);
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(0);

    const after = await Device.findByPk(device.id);
    expect(new Date(after.lastSeen).getTime()).toBeGreaterThan(0);
  });

  it('needs a device token — a parent token is not one', async () => {
    const { parent } = await setup();
    const { tokenFor } = require('./helpers');

    const res = await request(app)
      .post('/api/devices/me/activity/batch')
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({ samples: [sample('com.tiktok', 5)] });

    expect(res.status).toBe(401);
  });

  /**
   * One family's device must never write into another's rows. The child is
   * derived from the device token and nothing in the body can influence it —
   * pinned here because the batch handler reads more of the body than the
   * per-item one does, and a `childId` accepted from it would be a tenancy hole.
   */
  it('ignores a childId in the body and files against the token holder', async () => {
    const { child, token } = await setup();
    const other = await createChild((await createUser()).id);

    await send(token, [{ ...sample('com.tiktok', 15), childId: other.id }]);

    expect(await ActivityLog.count({ where: { childId: other.id } })).toBe(0);
    expect(await ActivityLog.count({ where: { childId: child.id } })).toBe(1);
  });
});
