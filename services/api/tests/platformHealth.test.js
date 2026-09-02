const request = require('supertest');
const { app } = require('../src/app');
const { AuditLog, SystemSetting } = require('../src/models');
const { createAlert } = require('../src/utils/alertHelper');
const pushService = require('../src/utils/pushService');
const { createUser, tokenFor, createChild } = require('./helpers');

// `sendAlertEmail` is destructured inside alertHelper, so the module has to be
// replaced rather than spied on — the same approach alertPrefs.test.js takes.
jest.mock('../src/utils/email', () => ({ sendAlertEmail: jest.fn(async () => {}) }));
const { sendAlertEmail } = require('../src/utils/email');

const bearer = (u) => ({ Authorization: `Bearer ${tokenFor(u)}` });

const health = (admin, query = '') => request(app)
  .get(`/api/admin/platform-health${query}`)
  .set(bearer(admin));

const acknowledge = (admin, entryId) => request(app)
  .post('/api/admin/platform-health/acknowledge')
  .set(bearer(admin))
  .send({ entryId });

const setMuted = (admin, muted) => request(app)
  .put('/api/admin/platform-health/alert-delivery')
  .set(bearer(admin))
  .send({ muted });

/** An audit entry at a chosen age — `createdAt` needs a silent write. */
const entry = (action, { userId = null, hoursAgo = 1 } = {}) => AuditLog.create(
  { userId, action, entity: 'Test', ipAddress: '127.0.0.1', createdAt: new Date(Date.now() - hoursAgo * 3600_000) },
  { silent: true },
);

const io = { to: () => ({ emit: () => {} }) };

afterEach(async () => {
  await SystemSetting.destroy({ where: { key: 'mutedAlertTypes' } });
  await SystemSetting.destroy({ where: { key: 'criticalAcknowledgement' } });
  jest.restoreAllMocks();
});

describe('the Overview alert summary', () => {
  it('needs the permission that opens the logs it counts', async () => {
    const parent = await createUser({ role: 'parent' });
    const finance = await createUser({ role: 'finance', permissions: ['manage_billing'] });
    const support = await createUser({ role: 'support', permissions: ['view_audit_logs'] });

    expect((await request(app).get('/api/admin/platform-health')).status).toBe(401);
    expect((await health(parent)).status).toBe(403);
    expect((await health(finance)).status).toBe(403);
    expect((await health(support)).status).toBe(200);
  });

  it('counts by the same severity rules the log filter uses', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const before = (await health(admin)).body;
    const count = (body, level) => body.levels.find((l) => l.level === level).count;

    await entry('admin.user_deleted');       // critical
    await entry('auth.login_failed');        // error
    await entry('admin.plan_changed');       // warning
    await entry('device.linked');            // info

    const after = (await health(admin)).body;
    expect(count(after, 'critical')).toBe(count(before, 'critical') + 1);
    expect(count(after, 'error')).toBe(count(before, 'error') + 1);
    expect(count(after, 'warning')).toBe(count(before, 'warning') + 1);
    expect(count(after, 'info')).toBeGreaterThan(count(before, 'info'));

    // And the same query, asked of the log endpoint the tile links to.
    const logs = await request(app).get('/api/audit?level=critical').set(bearer(admin));
    expect(logs.body.rows.every((row) => row.level === 'critical')).toBe(true);
  });

  it('honours the window rather than counting everything', async () => {
    const admin = await createUser({ role: 'super_admin' });
    await entry('admin.user_deleted', { hoursAgo: 72 });

    const day = (await health(admin, '?window=24h')).body;
    const week = (await health(admin, '?window=7d')).body;
    const criticals = (body) => body.levels.find((l) => l.level === 'critical').count;

    expect(criticals(week)).toBeGreaterThan(criticals(day));
    expect(day.windowLabel).toBe('Last 24 hours');
  });

  it('surfaces the newest critical entry with the operator behind it', async () => {
    const admin = await createUser({ role: 'super_admin', name: 'Rae Iyer' });
    await entry('staff.deleted', { userId: admin.id, hoursAgo: 0 });

    const { body } = await health(admin);
    expect(body.critical.entry.action).toBe('staff.deleted');
    expect(body.critical.entry.level).toBe('critical');
    expect(body.critical.entry.actor.name).toBe('Rae Iyer');
    expect(body.critical.acknowledged).toBe(false);
  });

  it('acknowledges one entry, and a newer critical brings the banner back', async () => {
    const admin = await createUser({ role: 'super_admin', name: 'Rae Iyer' });
    // Newer than anything an earlier test in this file wrote — the entries
    // accumulate, and "the newest critical" is the whole subject here.
    const first = await entry('admin.user_deleted', { hoursAgo: 0 });

    expect((await acknowledge(admin, first.id)).status).toBe(200);
    let { body } = await health(admin);
    expect(body.critical.entry.id).toBe(first.id);
    expect(body.critical.acknowledged).toBe(true);
    expect(body.critical.acknowledgedBy).toBe('Rae Iyer');

    await entry('staff.deleted', { hoursAgo: 0 });
    ({ body } = await health(admin));
    expect(body.critical.acknowledged).toBe(false);
  });

  it('refuses to acknowledge something that is not critical', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const warning = await entry('admin.plan_changed');

    expect((await acknowledge(admin, warning.id)).status).toBe(400);
    expect((await acknowledge(admin, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('reports the channels an alert can really leave by, and does not invent one', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const { body } = await health(admin);
    const byKey = Object.fromEntries(body.channels.map((c) => [c.key, c]));

    expect(Object.keys(byKey).sort()).toEqual(['email', 'payments', 'push', 'sms']);
    // Nothing configures a provider in the test environment, so the honest
    // answer is that neither is active — and SMS is not integrated at all.
    expect(byKey.sms.status).toBe('unavailable');
    expect(byKey.push.status).toBe('inactive');
    expect(body.channels.some((c) => /slack/i.test(c.label))).toBe(false);
  });

  /**
   * Half-configured Stripe, which is the state with no symptom anywhere else.
   *
   * `env.setup.js` gives the suite a secret key and a price and no webhook
   * secret — which is exactly the shape that takes a customer's money and then
   * never hears about the renewal, the cancellation or the failed card, because
   * every delivery fails signature verification. It is neither "Active" nor
   * "Not configured", and reporting it as either is how it went unnoticed.
   */
  it('reports payments as degraded when it can sell but cannot hear back', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const { body } = await health(admin);
    const payments = body.channels.find((c) => c.key === 'payments');

    expect(payments.status).toBe('degraded');
    // The detail is the whole value of the tile: it has to name the variable an
    // operator must set, not merely say something is wrong.
    expect(payments.detail).toMatch(/STRIPE_WEBHOOK_SECRET/);
  });

  it('reports payments as inactive when there is no Stripe at all', async () => {
    const { env } = require('../src/config/env');
    const admin = await createUser({ role: 'super_admin' });
    const saved = env.stripe.secretKey;
    env.stripe.secretKey = '';
    try {
      const { body } = await health(admin);
      const payments = body.channels.find((c) => c.key === 'payments');
      expect(payments.status).toBe('inactive');
      expect(payments.detail).toMatch(/STRIPE_SECRET_KEY/);
    } finally {
      env.stripe.secretKey = saved;
    }
  });

  it('lists every alert type the platform can raise', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const { body } = await health(admin);

    expect(body.alertTypes.length).toBeGreaterThanOrEqual(8);
    expect(body.alertTypes.every((t) => t.condition && t.severity)).toBe(true);
    expect(body.alertTypes.map((t) => t.key)).toContain('emergency_button');
  });
});

/**
 * Muting is the one part of the alert table that changes behaviour, and the
 * behaviour has to be exactly this: no email, no push, but the alert is still
 * recorded and still broadcast. On a child-safety platform, an operator's kill
 * switch must cost a notification and never a fact.
 */
describe('holding an alert type back from email and push', () => {
  it('is a settings decision, not a log-reading one', async () => {
    const reader = await createUser({ role: 'support', permissions: ['view_audit_logs'] });
    const ops = await createUser({ role: 'operations', permissions: ['manage_settings'] });

    expect((await setMuted(reader, ['blocked_app_attempt'])).status).toBe(403);
    expect((await setMuted(ops, ['blocked_app_attempt'])).status).toBe(200);
  });

  it('refuses a type the platform cannot raise', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const res = await setMuted(admin, ['cpu_utilization_high']);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown alert type/);
  });

  it('stops the email and the push, and still records the alert', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const parent = await createUser({ role: 'parent' });
    const child = await createChild(parent.id);

    sendAlertEmail.mockClear();
    const sendEmail = sendAlertEmail;
    const sendPush = jest.spyOn(pushService, 'sendToUser').mockResolvedValue({ ok: true });

    await setMuted(admin, ['emergency_button']);
    const alert = await createAlert(io, {
      parentId: parent.id, childId: child.id, type: 'emergency_button',
      message: 'Emergency alert from child', severity: 'high',
    });

    expect(alert.id).toBeTruthy();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendPush).not.toHaveBeenCalled();

    // Unmuted, the same alert goes out — so the test above is about the mute and
    // not about a broken sender.
    await setMuted(admin, []);
    await createAlert(io, {
      parentId: parent.id, childId: child.id, type: 'emergency_button',
      message: 'Emergency alert from child', severity: 'high',
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  it('leaves the parent still able to see it in their own alert list', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const parent = await createUser({ role: 'parent' });
    const child = await createChild(parent.id);

    jest.spyOn(pushService, 'sendToUser').mockResolvedValue({ ok: true });

    await setMuted(admin, ['cyberbullying']);
    await createAlert(io, {
      parentId: parent.id, childId: child.id, type: 'cyberbullying',
      message: 'Possible cyberbullying detected', severity: 'high',
    });

    const alerts = await request(app).get('/api/alerts').set(bearer(parent));
    expect(alerts.status).toBe(200);
    const rows = alerts.body.rows || alerts.body;
    expect(rows.some((a) => a.type === 'cyberbullying')).toBe(true);
  });

  it('writes an audit entry for the change', async () => {
    const admin = await createUser({ role: 'super_admin' });
    await setMuted(admin, ['app_installed']);

    const logs = await request(app)
      .get('/api/audit?action=admin.alert_delivery_updated')
      .set(bearer(admin));
    expect(logs.body.rows.length).toBeGreaterThan(0);
  });
});

describe('the alert catalogue', () => {
  const { ALERT_TYPES } = require('../src/config/alertTypes');
  const { ALERT_LABELS } = { ALERT_LABELS: null };

  it('describes every type with a condition somebody can check against the source', () => {
    for (const type of ALERT_TYPES) {
      expect(type.condition.length).toBeGreaterThan(10);
      expect(['high', 'medium']).toContain(type.severity);
      /**
       * A file path, or an explicit null.
       *
       * This required a path unconditionally, which is why three entries kept
       * naming `sockets/deviceEvents.js` for a producer that does not exist —
       * the only way to pass was to name *something*, so the check rewarded the
       * claim it was meant to verify. `null` is now a legitimate answer, and
       * alertCatalogue.test.js is what checks that a named producer is real.
       */
      if (type.producer !== null) expect(type.producer).toMatch(/\.(js|kt)$/);
    }
    expect(ALERT_LABELS).toBeNull(); // labels live in the shared constants file
  });

  it('has an entry for every type the API actually emits', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const walk = (dir, out = []) => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) walk(full, out);
        else if (item.name.endsWith('.js')) out.push(full);
      }
      return out;
    };

    const emitted = [...new Set(
      walk(path.join(__dirname, '../src'))
        .flatMap((file) => [...fs.readFileSync(file, 'utf8')
          .matchAll(/createAlert\([\s\S]{0,400}?type:\s*'([a-z_]+)'/g)])
        .map((m) => m[1])
    )];

    expect(emitted.length).toBeGreaterThanOrEqual(8);
    const described = ALERT_TYPES.map((t) => t.key);
    expect(emitted.filter((type) => !described.includes(type))).toEqual([]);
  });
});
