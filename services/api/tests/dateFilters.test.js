/**
 * A day, as the person filtering meant it.
 *
 * `<input type="date">` submits `YYYY-MM-DD`, and `new Date('2026-08-12')` is
 * *midnight* on that date. Used as the upper bound of a `<=`, "From 12 Aug, To
 * 12 Aug" therefore asked for everything at or before midnight — so filtering a
 * child's activity or web history to one day returned an empty table under the
 * heading "Nothing in that range". The narrower the parent made the question,
 * the more certainly it answered nothing, and nothing about the result looked
 * like a fault.
 *
 * Every case here fails against the old `new Date(to)` bound.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { ActivityLog, AuditLog } = require('../src/models');
const { rangeEnd, rangeStart, dateRangeWhere } = require('../src/utils/dateRange');
const { createUser, tokenFor, createChild, createDevice } = require('./helpers');
const { Op } = require('sequelize');

const createStaff = () => createUser({ role: 'super_admin' });

/** Noon UTC on a fixed day, and the same day's late evening. */
const DAY = '2026-08-12';
const NOON = new Date('2026-08-12T12:00:00.000Z');
const LATE = new Date('2026-08-12T23:45:00.000Z');
const NEXT_DAY = new Date('2026-08-13T09:00:00.000Z');

describe('date bounds', () => {
  it('ends a bare date on its last millisecond, not its first', () => {
    expect(rangeStart(DAY).toISOString()).toBe('2026-08-12T00:00:00.000Z');
    expect(rangeEnd(DAY).toISOString()).toBe('2026-08-12T23:59:59.999Z');
  });

  it('passes a full timestamp through unchanged', () => {
    // The console's "last 15 minutes" window sends an instant and means it.
    const instant = '2026-08-12T12:34:56.000Z';
    expect(rangeEnd(instant).toISOString()).toBe(instant);
  });

  it('is null when neither bound was given, so the column stays out of the query', () => {
    expect(dateRangeWhere(undefined, undefined, { Op })).toBeNull();
  });

  it('ignores a bound it cannot parse rather than matching nothing', () => {
    // An Invalid Date renders as NULL in SQL and silently excludes every row.
    expect(dateRangeWhere('yesterday', undefined, { Op })).toBeNull();
  });
});

describe('activity filtered to a single day', () => {
  const seed = async (childId, deviceId) => {
    await ActivityLog.bulkCreate([
      { childId, deviceId, appName: 'Noon', category: 'app_usage', appPackage: 'a.noon', startTime: NOON, durationMinutes: 10 },
      { childId, deviceId, appName: 'Late', category: 'app_usage', appPackage: 'a.late', startTime: LATE, durationMinutes: 5 },
      { childId, deviceId, appName: 'Tomorrow', category: 'app_usage', appPackage: 'a.next', startTime: NEXT_DAY, durationMinutes: 7 },
    ]);
  };

  it('returns everything recorded on that day, including the evening', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    await seed(child.id, device.id);

    const res = await request(app)
      .get(`/api/activity/${child.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .query({ from: DAY, to: DAY });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.rows.map((r) => r.appName).sort()).toEqual(['Late', 'Noon']);
  });

  it('still excludes the next day', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    await seed(child.id, device.id);

    const res = await request(app)
      .get(`/api/activity/${child.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .query({ to: DAY });

    expect(res.status).toBe(200);
    expect(res.body.rows.some((r) => r.appName === 'Tomorrow')).toBe(false);
  });
});

describe('web history filtered to a single day', () => {
  it('returns the evening’s browsing rather than an empty table', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    await ActivityLog.bulkCreate([
      { childId: child.id, deviceId: device.id, category: 'browsing', appName: 'a.com', url: 'a.com', startTime: LATE, durationMinutes: 0 },
      { childId: child.id, deviceId: device.id, category: 'browsing', appName: 'b.com', url: 'b.com', startTime: NEXT_DAY, durationMinutes: 0 },
    ]);

    const res = await request(app)
      .get(`/api/activity/${child.id}/web-history`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .query({ from: DAY, to: DAY });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.rows[0].url).toBe('a.com');
  });
});

describe('the console’s log filter', () => {
  it('covers a whole day when given one, and an instant when given one', async () => {
    const staff = await createStaff();

    await AuditLog.bulkCreate([
      { userId: staff.id, action: 'auth.login', entity: 'User', createdAt: LATE },
      { userId: staff.id, action: 'auth.logout', entity: 'User', createdAt: NEXT_DAY },
    ], { silent: true });

    const byDay = await request(app)
      .get('/api/audit')
      .set('Authorization', `Bearer ${tokenFor(staff)}`)
      .query({ from: DAY, to: DAY });

    expect(byDay.status).toBe(200);
    const actions = byDay.body.rows.map((r) => r.action);
    expect(actions).toContain('auth.login');
    expect(actions).not.toContain('auth.logout');
  });
});
