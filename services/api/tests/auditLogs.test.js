const request = require('supertest');
const { app } = require('../src/app');
const { AuditLog } = require('../src/models');
const { createUser, tokenFor } = require('./helpers');
const { levelFor, serviceFor } = require('../src/utils/logSeverity');

const bearer = (u) => ({ Authorization: `Bearer ${tokenFor(u)}` });

const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);

/**
 * The console reads this endpoint as a log stream: every entry carries a level
 * and a service that no column holds, and every filter has to narrow the query
 * rather than the page — a level applied in the browser would leave `count`
 * describing a set the operator cannot see.
 */
const write = (overrides) => AuditLog.create({
  action: 'auth.login',
  ipAddress: '10.0.0.1',
  createdAt: minutesAgo(1),
  ...overrides,
});

// The schema is created once per file, so each case starts from an empty stream
// rather than inheriting the entries the one before it wrote.
beforeEach(() => AuditLog.destroy({ where: {}, truncate: true }));

describe('log severity — derived from the action name', () => {
  it('reads the level off the action, most severe rule first', () => {
    expect(levelFor('admin.user_deleted')).toBe('critical');
    expect(levelFor('auth.login_blocked_locked')).toBe('critical');
    expect(levelFor('auth.login_failed')).toBe('error');
    expect(levelFor('auth.mfa_failed')).toBe('error');
    expect(levelFor('admin.role_changed')).toBe('warning');
    // Matched by suffix, so an action nobody listed still classifies.
    expect(levelFor('device.removed')).toBe('warning');
    expect(levelFor('safezone.deleted')).toBe('warning');
    expect(levelFor('widget.frobnicated_failed')).toBe('error');
    // The code flows' refusals. `forgot-password` cannot tell the caller it
    // declined to send — that would confirm the address has an account — so
    // this entry is the only place a mail-bombed parent is visible at all.
    expect(levelFor('auth.password_reset_throttled')).toBe('warning');
    expect(levelFor('auth.phone_code_throttled')).toBe('warning');
    expect(levelFor('auth.password_reset_code_failed')).toBe('error');
    expect(levelFor('auth.login')).toBe('info');
    expect(levelFor(undefined)).toBe('info');
  });

  it('reads the service off the prefix, and names an unprefixed action', () => {
    expect(serviceFor('auth.login')).toBe('auth');
    expect(serviceFor('admin.user_deleted')).toBe('admin');
    expect(serviceFor('startup')).toBe('platform');
  });
});

describe('GET /audit — access', () => {
  it('401 without a token, 403 for a parent, 403 for staff without view_audit_logs', async () => {
    expect((await request(app).get('/api/audit')).status).toBe(401);

    const parent = await createUser({ role: 'parent' });
    expect((await request(app).get('/api/audit').set(bearer(parent))).status).toBe(403);

    const finance = await createUser({ role: 'finance', permissions: ['manage_billing'] });
    expect((await request(app).get('/api/audit').set(bearer(finance))).status).toBe(403);
  });

  it('200 for staff holding the permission and for a super admin', async () => {
    const ops = await createUser({ role: 'operations', permissions: ['view_audit_logs'] });
    const admin = await createUser({ role: 'super_admin' });
    expect((await request(app).get('/api/audit').set(bearer(ops))).status).toBe(200);
    expect((await request(app).get('/api/audit').set(bearer(admin))).status).toBe(200);
  });
});

describe('GET /audit — the stream', () => {
  it('labels every entry with a level and a service, newest first', async () => {
    const admin = await createUser({ role: 'super_admin', name: 'Ada Reeve' });
    await write({ action: 'auth.login', userId: admin.id, createdAt: minutesAgo(5) });
    await write({ action: 'admin.user_deleted', entity: 'User', createdAt: minutesAgo(1) });

    const res = await request(app).get('/api/audit').set(bearer(admin));
    expect(res.status).toBe(200);

    const [newest, older] = res.body.rows;
    expect(newest.action).toBe('admin.user_deleted');
    expect(newest.level).toBe('critical');
    expect(newest.service).toBe('admin');
    expect(older.level).toBe('info');
    expect(older.user.name).toBe('Ada Reeve');
  });

  it('filters by level without letting a more severe entry through', async () => {
    const admin = await createUser({ role: 'super_admin' });
    await write({ action: 'auth.login_failed' });
    await write({ action: 'admin.user_deleted' });   // critical, not an error
    await write({ action: 'device.removed' });       // warning, by suffix
    await write({ action: 'auth.login' });

    const errors = await request(app).get('/api/audit?level=error').set(bearer(admin));
    expect(errors.body.rows.map((r) => r.action)).toEqual(['auth.login_failed']);

    const critical = await request(app).get('/api/audit?level=critical').set(bearer(admin));
    expect(critical.body.rows.map((r) => r.action)).toEqual(['admin.user_deleted']);

    const warnings = await request(app).get('/api/audit?level=warning').set(bearer(admin));
    expect(warnings.body.rows.map((r) => r.action)).toEqual(['device.removed']);

    // `info` is what no rule claimed, so it must exclude all three of the above.
    const info = await request(app).get('/api/audit?level=info').set(bearer(admin));
    expect(info.body.rows.map((r) => r.action)).toEqual(['auth.login']);
  });

  it('counts the filtered stream, not the whole of it', async () => {
    const admin = await createUser({ role: 'super_admin' });
    await write({ action: 'auth.login' });
    await write({ action: 'auth.login' });
    await write({ action: 'auth.login_failed' });

    const res = await request(app).get('/api/audit?level=error').set(bearer(admin));
    expect(res.body.count).toBe(1);
    expect(res.body.rows).toHaveLength(1);
  });

  it('filters by service without matching another service that starts the same', async () => {
    const admin = await createUser({ role: 'super_admin' });
    await write({ action: 'auth.login' });
    await write({ action: 'authority.something' });
    await write({ action: 'admin.settings_updated' });

    const res = await request(app).get('/api/audit?service=auth').set(bearer(admin));
    expect(res.body.rows.map((r) => r.action)).toEqual(['auth.login']);
  });

  it('searches the action, the address and the staff member behind the entry', async () => {
    const admin = await createUser({ role: 'super_admin', name: 'Wilhelmina Baye' });
    await write({ action: 'admin.settings_updated', userId: admin.id, ipAddress: '10.0.0.9' });
    await write({ action: 'auth.login', ipAddress: '172.16.4.2' });

    const byAction = await request(app).get('/api/audit?q=settings').set(bearer(admin));
    expect(byAction.body.rows.map((r) => r.action)).toEqual(['admin.settings_updated']);

    const byAddress = await request(app).get('/api/audit?q=172.16').set(bearer(admin));
    expect(byAddress.body.rows.map((r) => r.action)).toEqual(['auth.login']);

    // Reaches through the join, and ignores case — Postgres' LIKE does not.
    const byActor = await request(app).get('/api/audit?q=wilhelmina').set(bearer(admin));
    expect(byActor.body.rows.map((r) => r.action)).toEqual(['admin.settings_updated']);
    expect(byActor.body.count).toBe(1);
  });

  it('combines a level, a service and a window in one query', async () => {
    const admin = await createUser({ role: 'super_admin' });
    await write({ action: 'auth.login_failed', createdAt: minutesAgo(2) });
    await write({ action: 'auth.login_failed', createdAt: minutesAgo(600) }); // outside the window
    await write({ action: 'staff.password_reset', createdAt: minutesAgo(2) }); // wrong service
    await write({ action: 'auth.login', createdAt: minutesAgo(2) }); // wrong level

    const from = minutesAgo(15).toISOString();
    const res = await request(app)
      .get(`/api/audit?level=error&service=auth&from=${encodeURIComponent(from)}`)
      .set(bearer(admin));

    expect(res.body.count).toBe(1);
    expect(res.body.rows[0].action).toBe('auth.login_failed');
  });

  it('still takes the action prefix it has always taken', async () => {
    const admin = await createUser({ role: 'super_admin' });
    await write({ action: 'admin.plan_changed' });
    await write({ action: 'auth.login' });

    const res = await request(app).get('/api/audit?action=admin.').set(bearer(admin));
    expect(res.body.rows.map((r) => r.action)).toEqual(['admin.plan_changed']);
  });
});
