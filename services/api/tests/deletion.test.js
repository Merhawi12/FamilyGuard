const request = require('supertest');
const { app } = require('../src/app');
const { Alert, ActivityLog, AuditLog } = require('../src/models');
const {
  createUser, tokenFor, createChild, createDevice,
} = require('./helpers');

/**
 * Deleting alerts, web history and activity records.
 *
 * The thing these tests exist to hold still: **web history and the activity log
 * are one table**. A browsing row is an `ActivityLog` row with
 * `category: 'browsing'`, and the Activity Log screen shows every category — so
 * a delete on one screen is visible on the other, and a bulk clear on the
 * Activity Log takes the browsing rows with it. That is correct, it is what the
 * confirmation dialogs say, and an "improvement" that quietly changed it would
 * make one of those dialogs lie.
 */
const family = async () => {
  const parent = await createUser();
  const child = await createChild(parent.id);
  const device = await createDevice(child.id);
  return { parent, child, device, auth: `Bearer ${tokenFor(parent)}` };
};

const makeAlert = (parentId, over = {}) => Alert.create({
  parentId, type: 'blocked_app_attempt', message: 'Something happened', severity: 'medium', ...over,
});

const makeEntry = (f, over = {}) => ActivityLog.create({
  deviceId: f.device.id,
  childId: f.child.id,
  appName: 'Chrome',
  category: 'other',
  startTime: new Date('2026-08-12T10:00:00Z'),
  durationMinutes: 5,
  ...over,
});

describe('Deleting alerts', () => {
  it('deletes one alert and leaves the rest', async () => {
    const f = await family();
    const doomed = await makeAlert(f.parent.id, { message: 'Delete me' });
    const keeper = await makeAlert(f.parent.id, { message: 'Keep me' });

    const res = await request(app).delete(`/api/alerts/${doomed.id}`).set('Authorization', f.auth);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);

    expect(await Alert.findByPk(doomed.id)).toBeNull();
    expect(await Alert.findByPk(keeper.id)).not.toBeNull();
  });

  it('will not delete another family alert', async () => {
    const f = await family();
    const stranger = await createUser();
    const theirs = await makeAlert(stranger.id);

    // "Not found" rather than 403 — a 403 would confirm the row exists.
    const res = await request(app).delete(`/api/alerts/${theirs.id}`).set('Authorization', f.auth);
    expect(res.status).toBe(404);
    expect(await Alert.findByPk(theirs.id)).not.toBeNull();
  });

  it('clears every alert the account owns when nothing is filtered', async () => {
    const f = await family();
    await makeAlert(f.parent.id, { severity: 'high' });
    await makeAlert(f.parent.id, { severity: 'low' });
    const stranger = await createUser();
    const theirs = await makeAlert(stranger.id);

    const res = await request(app).delete('/api/alerts').set('Authorization', f.auth);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);

    expect(await Alert.count({ where: { parentId: f.parent.id } })).toBe(0);
    // Another family's alerts are not "everything".
    expect(await Alert.findByPk(theirs.id)).not.toBeNull();
  });

  /*
   * The filter is the point. A parent looking at "High" and pressing Clear is
   * asking about high-severity alerts; a clear that took the rest would destroy
   * rows they had filtered away and could not see, which is the one outcome a
   * confirmation dialog cannot warn about.
   */
  it('clears only the severity the screen is showing', async () => {
    const f = await family();
    await makeAlert(f.parent.id, { severity: 'high' });
    await makeAlert(f.parent.id, { severity: 'high' });
    await makeAlert(f.parent.id, { severity: 'low' });

    const res = await request(app)
      .delete('/api/alerts').query({ severity: 'high' }).set('Authorization', f.auth);
    expect(res.body.deleted).toBe(2);
    expect(await Alert.count({ where: { parentId: f.parent.id } })).toBe(1);
  });

  it('clears only unread when that is the filter', async () => {
    const f = await family();
    await makeAlert(f.parent.id, { isRead: false });
    await makeAlert(f.parent.id, { isRead: true });

    const res = await request(app)
      .delete('/api/alerts').query({ unreadOnly: 'true' }).set('Authorization', f.auth);
    expect(res.body.deleted).toBe(1);
    expect(await Alert.count({ where: { parentId: f.parent.id } })).toBe(1);
  });

  /*
   * An unknown severity must not fall through to "no filter". Dropping the key
   * from the clause would turn a narrow request into "delete everything" — the
   * worst possible reading of an unrecognised value.
   */
  it('refuses an unknown severity rather than widening to everything', async () => {
    const f = await family();
    await makeAlert(f.parent.id, { severity: 'high' });

    const res = await request(app)
      .delete('/api/alerts').query({ severity: 'catastrophic' }).set('Authorization', f.auth);
    expect(res.status).toBe(400);
    expect(await Alert.count({ where: { parentId: f.parent.id } })).toBe(1);
  });

  it('records the deletion in the audit log', async () => {
    const f = await family();
    const alert = await makeAlert(f.parent.id);
    await request(app).delete(`/api/alerts/${alert.id}`).set('Authorization', f.auth);

    const entry = await AuditLog.findOne({
      where: { userId: f.parent.id, action: 'alert.deleted' },
    });
    expect(entry).not.toBeNull();
  });
});

describe('Deleting activity and web history', () => {
  it('deletes one entry', async () => {
    const f = await family();
    const doomed = await makeEntry(f);
    const keeper = await makeEntry(f, { appName: 'Edge' });

    const res = await request(app)
      .delete(`/api/activity/${f.child.id}/entries/${doomed.id}`).set('Authorization', f.auth);
    expect(res.status).toBe(200);

    expect(await ActivityLog.findByPk(doomed.id)).toBeNull();
    expect(await ActivityLog.findByPk(keeper.id)).not.toBeNull();
  });

  it('will not delete an entry belonging to another family', async () => {
    const f = await family();
    const other = await family();
    const theirs = await makeEntry(other);

    const res = await request(app)
      .delete(`/api/activity/${f.child.id}/entries/${theirs.id}`).set('Authorization', f.auth);
    expect(res.status).toBe(404);
    expect(await ActivityLog.findByPk(theirs.id)).not.toBeNull();
  });

  it('clears web history without touching app usage', async () => {
    const f = await family();
    const browsing = await makeEntry(f, { category: 'browsing', url: 'example.com' });
    const usage = await makeEntry(f, { category: 'other', appName: 'Chrome' });

    const res = await request(app)
      .delete(`/api/activity/${f.child.id}/web-history`).set('Authorization', f.auth);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);

    expect(await ActivityLog.findByPk(browsing.id)).toBeNull();
    expect(await ActivityLog.findByPk(usage.id)).not.toBeNull();
  });

  /*
   * The asymmetry a parent has to be told about, and the reason both dialogs
   * spell it out: the Activity Log screen shows browsing rows too, so clearing
   * it clears the web history as well.
   */
  it('clearing the activity log takes the browsing rows with it', async () => {
    const f = await family();
    const browsing = await makeEntry(f, { category: 'browsing', url: 'example.com' });
    const usage = await makeEntry(f, { category: 'other' });

    const res = await request(app)
      .delete(`/api/activity/${f.child.id}`).set('Authorization', f.auth);
    expect(res.body.deleted).toBe(2);

    expect(await ActivityLog.findByPk(browsing.id)).toBeNull();
    expect(await ActivityLog.findByPk(usage.id)).toBeNull();
  });

  it('honours the date range so a clear removes only what the screen shows', async () => {
    const f = await family();
    const inRange = await makeEntry(f, { startTime: new Date('2026-08-12T10:00:00Z') });
    const outside = await makeEntry(f, { startTime: new Date('2026-07-01T10:00:00Z') });

    const res = await request(app)
      .delete(`/api/activity/${f.child.id}`)
      .query({ from: '2026-08-01', to: '2026-08-31' })
      .set('Authorization', f.auth);
    expect(res.body.deleted).toBe(1);

    expect(await ActivityLog.findByPk(inRange.id)).toBeNull();
    expect(await ActivityLog.findByPk(outside.id)).not.toBeNull();
  });

  it('will not clear another family activity', async () => {
    const f = await family();
    const other = await family();
    await makeEntry(other);

    const res = await request(app)
      .delete(`/api/activity/${other.child.id}`).set('Authorization', f.auth);
    expect(res.status).toBe(404);
    expect(await ActivityLog.count({ where: { childId: other.child.id } })).toBe(1);
  });

  it('records the clear in the audit log, with the count and the range', async () => {
    const f = await family();
    await makeEntry(f);
    await request(app)
      .delete(`/api/activity/${f.child.id}`)
      .query({ from: '2026-08-01' })
      .set('Authorization', f.auth);

    const entry = await AuditLog.findOne({
      where: { userId: f.parent.id, action: 'activity.cleared' },
    });
    expect(entry).not.toBeNull();
    const meta = typeof entry.metadata === 'string' ? JSON.parse(entry.metadata) : entry.metadata;
    expect(meta.deleted).toBe(1);
    expect(meta.from).toBe('2026-08-01');
  });

  /*
   * The url is encrypted on the row precisely so it is not sitting in plain text
   * anywhere else. An audit log is somewhere else.
   */
  it('never writes a browsed url into the audit metadata', async () => {
    const f = await family();
    const row = await makeEntry(f, { category: 'browsing', url: 'secret-example.com' });
    await request(app)
      .delete(`/api/activity/${f.child.id}/entries/${row.id}`).set('Authorization', f.auth);

    const entry = await AuditLog.findOne({
      where: { userId: f.parent.id, action: 'activity.entry_deleted' },
    });
    expect(JSON.stringify(entry.metadata)).not.toContain('secret-example.com');
  });

  it('answers 404 for a malformed id rather than failing the query', async () => {
    const f = await family();
    const res = await request(app)
      .delete(`/api/activity/${f.child.id}/entries/not-a-uuid`).set('Authorization', f.auth);
    expect(res.status).toBe(404);
  });
});

describe('Deletion needs a session', () => {
  it.each([
    ['delete', '/api/alerts/00000000-0000-4000-8000-000000000000'],
    ['delete', '/api/alerts'],
  ])('%s %s is 401 anonymous', async (method, path) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(401);
  });

  it('activity deletion is 401 anonymous', async () => {
    const f = await family();
    expect((await request(app).delete(`/api/activity/${f.child.id}`)).status).toBe(401);
    expect((await request(app).delete(`/api/activity/${f.child.id}/web-history`)).status).toBe(401);
  });
});
