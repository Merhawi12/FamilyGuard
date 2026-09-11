const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/db');
const {
  ActivityLog, AuditLog, Session, User, AppRule, WebsiteRule, ScreenTimeRule,
} = require('../src/models');
const { SESSION_TOUCH_INTERVAL_MS } = require('../src/middleware/auth');
const { LEVELS, levelFor } = require('../src/utils/logSeverity');
const { encrypt, blindIndex } = require('../src/utils/crypto');
const { createUser, createChild, createDevice, tokenFor } = require('./helpers');

/**
 * What the hot paths are allowed to cost.
 *
 * These are not micro-benchmarks — a timing assertion on a shared CI box tells
 * you about the box. They pin the two things that actually drive cost on Cloud
 * SQL and that a refactor can silently undo: **how many statements** a request
 * issues, and **whether a read path writes**.
 *
 * The counts are asserted as ceilings rather than equalities, so a change that
 * removes a query does not fail the suite that exists to encourage exactly that.
 */

/**
 * Identifier quoting, removed.
 *
 * The two engines quote differently — `` `sessions` `` on SQLite, `"sessions"`
 * on Postgres — so a matcher written against one silently passes on it and fails
 * on the other. That is the same trap `utils/aggregate.js` warns about, and this
 * suite runs on both (`npm run test:pg`), so the matching has to be neutral.
 */
const unquoted = (sql) => String(sql).replace(/^Executing \(default\): /, '').replace(/[`"]/g, '');

/** Runs `fn` with every SQL statement captured, quoting stripped. */
const countingSql = async (fn) => {
  const statements = [];
  const previous = sequelize.options.logging;
  sequelize.options.logging = (sql) => statements.push(unquoted(sql));
  try {
    await fn();
  } finally {
    sequelize.options.logging = previous;
  }
  return statements;
};

const writesTo = (statements, table) =>
  statements.filter((s) => new RegExp(`^\\s*(UPDATE|INSERT INTO)\\s+${table}\\b`, 'i').test(s));

/** A parent token that names a real session, which `tokenFor` deliberately does not. */
const sessionTokenFor = async (user) => {
  const session = await Session.create({ userId: user.id });
  return {
    session,
    token: jwt.sign({ id: user.id, sid: session.id }, process.env.JWT_SECRET, { expiresIn: '1h' }),
  };
};

describe('the session touch on every authenticated request', () => {
  it('writes once, then not again until the interval has passed', async () => {
    const parent = await createUser();
    const { session, token } = await sessionTokenFor(parent);
    const bearer = { Authorization: `Bearer ${token}` };

    // The first call through has a session whose `lastActiveAt` was set at
    // creation, so it is already fresh — the write is skipped, which is the
    // point. Age it deliberately to see the write happen.
    await session.update({ lastActiveAt: new Date(Date.now() - SESSION_TOUCH_INTERVAL_MS - 5000) });

    const first = await countingSql(async () => {
      expect((await request(app).get('/api/children').set(bearer)).status).toBe(200);
    });
    expect(writesTo(first, 'sessions')).toHaveLength(1);

    // The write above is deliberately not awaited by the request, so give the
    // fire-and-forget update a turn of the loop to land before asking again.
    await new Promise((resolve) => setImmediate(resolve));

    // A burst of calls immediately afterwards — a dashboard opening — must add
    // no further writes. This is the whole saving: it used to be one UPDATE per
    // request, for ever.
    const burst = await countingSql(async () => {
      for (let i = 0; i < 5; i += 1) {
        expect((await request(app).get('/api/children').set(bearer)).status).toBe(200);
      }
    });
    expect(writesTo(burst, 'sessions')).toHaveLength(0);
  });

  it('still reads the session every time, so a revocation takes effect at once', async () => {
    const parent = await createUser();
    const { session, token } = await sessionTokenFor(parent);
    const bearer = { Authorization: `Bearer ${token}` };

    expect((await request(app).get('/api/children').set(bearer)).status).toBe(200);

    // Revoked between two calls, with no write from the first to invalidate any
    // cache — because there is no cache. Skipping the *write* must not become
    // skipping the *check*.
    await session.update({ revoked: true });
    expect((await request(app).get('/api/children').set(bearer)).status).toBe(401);
  });
});

describe('the device rules sync, which every linked device makes every 5 minutes', () => {
  it('reads the child and the device from the token check rather than re-querying', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id, { name: 'Robin' });
    const device = await createDevice(child.id);
    await AppRule.create({
      childId: child.id, appPackage: 'com.example', appName: 'Example', action: 'block',
    });
    await WebsiteRule.create({ childId: child.id, url: 'example.com', action: 'block' });
    await ScreenTimeRule.create({ childId: child.id, dailyLimitMinutes: 120 });

    const token = jwt.sign(
      { deviceId: device.id, childId: child.id }, process.env.JWT_SECRET, { expiresIn: '1h' },
    );

    let body;
    const statements = await countingSql(async () => {
      const res = await request(app).get('/api/devices/me/rules')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      body = res.body;
    });

    // The name and the pause both still arrive — they are just no longer worth
    // a query each.
    expect(body.childName).toBe('Robin');
    expect(body.blocked).toBeNull();
    expect(body.appRules).toHaveLength(1);
    expect(body.screenTimeRule.dailyLimitMinutes).toBe(120);

    /**
     * Six: the auth lookup, one select per rule table, the grants, and the
     * content policy. The last of those is only here because `db.setup.js`
     * clears the settings cache before every test — in a warm process it is
     * served from memory and the real cost is five. The ceiling is what guards
     * the two extra `findByPk`s this used to make for `childName` and
     * `blockedAt`, which no cache would have covered.
     */
    expect(statements.length).toBeLessThanOrEqual(6);
    // And nothing on a pure read path writes.
    expect(statements.filter((s) => /^\s*(UPDATE|INSERT)/i.test(s))).toHaveLength(0);
  });

  it('still reports a paused device, from the row the token check loaded', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id, { blockedAt: new Date() });
    const token = jwt.sign(
      { deviceId: device.id, childId: child.id }, process.env.JWT_SECRET, { expiresIn: '1h' },
    );

    const res = await request(app).get('/api/devices/me/rules')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.blocked).toMatchObject({ reason: 'blocked_by_parent' });
    expect(typeof res.body.blocked.since).toBe('string');
  });
});

describe('the Overview level counts', () => {
  /** An audit entry at a chosen age — `createdAt` needs a silent write. */
  const entry = (action) => AuditLog.create(
    { action, entity: 'Test', createdAt: new Date(Date.now() - 3600_000) },
    { silent: true },
  );

  it('counts every level in one pass over the window', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const bearer = { Authorization: `Bearer ${tokenFor(admin)}` };

    await entry('admin.user_deleted');   // critical
    await entry('auth.login_failed');    // error
    await entry('admin.plan_changed');   // warning
    await entry('device.linked');        // info

    let body;
    const statements = await countingSql(async () => {
      const res = await request(app).get('/api/admin/platform-health?window=30d').set(bearer);
      expect(res.status).toBe(200);
      body = res.body;
    });

    // Every level is present, including the ones with no rows.
    expect(body.levels.map((l) => l.level)).toEqual(LEVELS);

    // This was one COUNT per level, each carrying the negation of every level
    // above it as a leading-wildcard LIKE — four scans of the window over the
    // busiest table on the platform. One grouped statement replaces them.
    const auditReads = statements.filter((s) => /FROM\s+audit_logs\b/i.test(s));
    expect(auditReads.filter((s) => /GROUP BY/i.test(s))).toHaveLength(1);
    expect(auditReads.filter((s) => /count\(\*\)/i.test(s))).toHaveLength(0);
  });

  it('agrees with the log filter it links to, level for level', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const bearer = { Authorization: `Bearer ${tokenFor(admin)}` };

    for (const action of [
      'admin.user_deleted', 'staff.deleted', 'auth.login_failed', 'auth.mfa_failed',
      'admin.plan_changed', 'auth.password_reset', 'device.linked', 'upload.avatar',
      'audit.entries_deleted', 'admin.settings_updated', 'auth.login_blocked_locked',
    ]) await entry(action);

    const health = await request(app).get('/api/admin/platform-health?window=30d').set(bearer);
    const tile = new Map(health.body.levels.map((l) => [l.level, l.count]));

    // The tile is summed in JavaScript with `levelFor`; the listing filters in
    // SQL with `levelCondition`. They are two expressions of one rule set and
    // this is what keeps them the same one.
    for (const level of LEVELS) {
      const listed = await request(app)
        .get(`/api/audit?level=${level}&limit=200`).set(bearer);
      expect(listed.status).toBe(200);
      expect(listed.body.rows.every((row) => levelFor(row.action) === level)).toBe(true);
      expect(listed.body.count).toBe(tile.get(level));
    }
  });
});

describe('an activity row this deployment cannot decrypt', () => {
  it('does not take the endpoint down with it', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const bearer = { Authorization: `Bearer ${tokenFor(parent)}` };

    const readable = 'https://readable.example.com/page';
    await ActivityLog.create({
      childId: child.id, deviceId: device.id, appName: 'Browser', category: 'web_visit',
      url: readable, startTime: new Date(),
    });

    /**
     * A row whose `url` this key cannot open. `bulkCreate` without
     * `individualHooks` is the shortest way to write one, and is also one of the
     * real ways it happens — alongside a restored dump from another environment
     * and a rotated `FIELD_ENCRYPTION_KEY`.
     *
     * The "stored before encryption was enabled" passthrough in `decrypt` does
     * not save this: it returns a value unchanged only when it carries no `:`,
     * and every url carries one in `https://`.
     */
    await ActivityLog.bulkCreate([{
      childId: child.id, deviceId: device.id, appName: 'Browser', category: 'web_visit',
      url: 'https://unreadable.example.com/page', startTime: new Date(),
    }]);

    const res = await request(app).get(`/api/activity/${child.id}?limit=50`).set(bearer);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);

    // The readable row is readable, and the other is left exactly as stored
    // rather than nulled — a caller sees a value it cannot make sense of instead
    // of being told the child visited nothing.
    const urls = res.body.rows.map((r) => r.url);
    expect(urls).toContain(readable);
    expect(urls).toContain('https://unreadable.example.com/page');
  });

  it('still decrypts a row written the normal way', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const url = 'https://normal.example.com/x';

    // Pre-sealed the way the hook would, to prove the read path is real and not
    // just passing ciphertext through.
    await ActivityLog.bulkCreate([{
      childId: child.id, deviceId: device.id, appName: 'Browser', category: 'web_visit',
      url: encrypt(url), urlHash: blindIndex(url), startTime: new Date(),
    }]);

    const res = await request(app).get(`/api/activity/${child.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`);
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.url)).toContain(url);
  });
});

describe('GET /admin/clients', () => {
  it('pages, rather than returning every customer on the platform', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const bearer = { Authorization: `Bearer ${tokenFor(admin)}` };

    await User.bulkCreate(
      Array.from({ length: 60 }, (unused, i) => ({
        name: `Bulk ${i}`, email: `bulk_${i}@clients.test`, passwordHash: 'x', role: 'parent',
      })),
      { hooks: false },
    );

    const first = await request(app).get('/api/admin/clients').set(bearer);
    expect(first.status).toBe(200);
    // The default page, not the table.
    expect(first.body).toHaveLength(50);

    const second = await request(app).get('/api/admin/clients?limit=10&offset=50').set(bearer);
    expect(second.status).toBe(200);
    expect(second.body).toHaveLength(10);
    // A real second page: no id repeats from the first.
    const firstIds = new Set(first.body.map((u) => u.id));
    expect(second.body.some((u) => firstIds.has(u.id))).toBe(false);

    // And the ceiling holds against a caller asking for everything.
    const greedy = await request(app).get('/api/admin/clients?limit=100000').set(bearer);
    expect(greedy.body.length).toBeLessThanOrEqual(200);
  });
});
