const request = require('supertest');
const { app } = require('../src/app');
const { ActivityLog } = require('../src/models');
const { createUser, tokenFor, createChild, createDevice } = require('./helpers');

/**
 * The family-wide weekly report — `GET /api/reports/weekly`.
 *
 * It exists because the dashboard's chart is a sum over every child, and it was
 * building that sum client-side from one `/reports/:childId/weekly` call per
 * child. The tests that matter are therefore the ones that pin the *equivalence*
 * with what it replaced, not just that the route answers: the totals have to
 * match the per-child endpoint bucket for bucket, and the scoping has to be as
 * tight, or the optimisation has quietly changed what a parent is shown.
 */

/**
 * A session `n` days back, at midday UTC so it cannot slide into a neighbouring
 * bucket wherever the suite is run. Every log belongs to a device, so the child
 * is given one the first time it records anything.
 */
const devices = new Map();
const deviceFor = async (childId) => {
  if (!devices.has(childId)) devices.set(childId, (await createDevice(childId)).id);
  return devices.get(childId);
};

const logAt = async (childId, daysAgo, durationMinutes, appName = 'YouTube') => {
  const at = new Date();
  at.setUTCDate(at.getUTCDate() - daysAgo);
  at.setUTCHours(12, 0, 0, 0);
  return ActivityLog.create({
    childId, deviceId: await deviceFor(childId), appName, durationMinutes, startTime: at,
  });
};

const dayKey = (daysAgo) => {
  const at = new Date();
  at.setUTCDate(at.getUTCDate() - daysAgo);
  at.setUTCHours(12, 0, 0, 0);
  return at.toISOString().split('T')[0];
};

describe('GET /api/reports/weekly', () => {
  it('sums every child in the family into one daily breakdown', async () => {
    const parent = await createUser();
    const older = await createChild(parent.id, { name: 'Older' });
    const younger = await createChild(parent.id, { name: 'Younger' });

    // Two children, same day: the point of the endpoint is that these add up.
    await logAt(older.id, 1, 30);
    await logAt(younger.id, 1, 45);
    await logAt(older.id, 3, 20);

    const res = await request(app)
      .get('/api/reports/weekly')
      .set('Authorization', `Bearer ${tokenFor(parent)}`);

    expect(res.status).toBe(200);
    expect(res.body.children).toBe(2);
    expect(res.body.totalMinutes).toBe(95);
    expect(res.body.dailyBreakdown[dayKey(1)]).toBe(75);
    expect(res.body.dailyBreakdown[dayKey(3)]).toBe(20);
  });

  /*
   * The regression this endpoint could most easily introduce: the per-child
   * route resolves ownership through `Child.findOne({ id, parentId })`, and the
   * family route has to scope by `parentId` just as tightly or one parent's
   * dashboard starts counting another family's screen time.
   */
  it('counts only the requesting parent’s own children', async () => {
    const parent = await createUser();
    const stranger = await createUser();
    const mine = await createChild(parent.id);
    const theirs = await createChild(stranger.id);

    await logAt(mine.id, 1, 10);
    await logAt(theirs.id, 1, 500);

    const res = await request(app)
      .get('/api/reports/weekly')
      .set('Authorization', `Bearer ${tokenFor(parent)}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMinutes).toBe(10);
  });

  it('ignores children the parent has removed', async () => {
    const parent = await createUser();
    const kept = await createChild(parent.id);
    const removed = await createChild(parent.id, { isActive: false });

    await logAt(kept.id, 1, 15);
    await logAt(removed.id, 1, 60);

    const res = await request(app)
      .get('/api/reports/weekly')
      .set('Authorization', `Bearer ${tokenFor(parent)}`);

    expect(res.status).toBe(200);
    expect(res.body.children).toBe(1);
    expect(res.body.totalMinutes).toBe(15);
  });

  it('leaves out activity older than the seven-day window', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);

    await logAt(child.id, 2, 25);
    await logAt(child.id, 30, 999);

    const res = await request(app)
      .get('/api/reports/weekly')
      .set('Authorization', `Bearer ${tokenFor(parent)}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMinutes).toBe(25);
    expect(res.body.dailyBreakdown[dayKey(30)]).toBeUndefined();
  });

  /*
   * `childId: []` would be rendered as `IN ()`, which Postgres refuses outright
   * — and the suite runs on SQLite, which does not, so this is exactly the shape
   * of bug that passes here and 500s in production.
   */
  it('answers an empty week for an account with no children', async () => {
    const parent = await createUser();

    const res = await request(app)
      .get('/api/reports/weekly')
      .set('Authorization', `Bearer ${tokenFor(parent)}`);

    expect(res.status).toBe(200);
    expect(res.body.children).toBe(0);
    expect(res.body.totalMinutes).toBe(0);
    expect(res.body.dailyBreakdown).toEqual({});
  });

  it('agrees with the per-child endpoint it replaced', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    await logAt(child.id, 1, 30);
    await logAt(child.id, 2, 40);

    const token = `Bearer ${tokenFor(parent)}`;
    const family = await request(app).get('/api/reports/weekly').set('Authorization', token);
    const single = await request(app).get(`/api/reports/${child.id}/weekly`).set('Authorization', token);

    expect(family.status).toBe(200);
    expect(single.status).toBe(200);
    expect(family.body.totalMinutes).toBe(single.body.totalMinutes);
    expect(family.body.dailyBreakdown).toEqual(single.body.dailyBreakdown);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await request(app).get('/api/reports/weekly');
    expect(res.status).toBe(401);
  });

  /*
   * `/weekly` is declared before `/:childId/weekly`. If that order is ever
   * reversed, Express reads the literal word "weekly" as a child id and the
   * family route becomes a 404 — silently, because the dashboard swallows a
   * failed report and just draws an empty chart.
   */
  it('does not let the per-child route shadow the family route', async () => {
    const parent = await createUser();
    const res = await request(app)
      .get('/api/reports/weekly')
      .set('Authorization', `Bearer ${tokenFor(parent)}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('children');
  });
});

describe('GET /api/reports/:childId/weekly', () => {
  it('still reports its top apps after the column projection was narrowed', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    await logAt(child.id, 1, 60, 'YouTube');
    await logAt(child.id, 2, 20, 'Roblox');

    const res = await request(app)
      .get(`/api/reports/${child.id}/weekly`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMinutes).toBe(80);
    expect(res.body.topApps[0]).toEqual(['YouTube', 60]);
  });

  it('refuses a child belonging to someone else', async () => {
    const parent = await createUser();
    const stranger = await createUser();
    const theirs = await createChild(stranger.id);

    const res = await request(app)
      .get(`/api/reports/${theirs.id}/weekly`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`);

    expect(res.status).toBe(404);
  });
});
