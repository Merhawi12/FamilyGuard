const request = require('supertest');
const { app } = require('../src/app');
const { ActivityLog } = require('../src/models');
const { blindIndex } = require('../src/utils/crypto');
const { createUser, tokenFor, createChild, createDevice, deviceToken } = require('./helpers');

const post = (device, visits) =>
  request(app)
    .post('/api/devices/me/web-history')
    .set('Authorization', `Bearer ${deviceToken(device)}`)
    .send({ visits });

const read = (parent, childId, query = {}) =>
  request(app)
    .get(`/api/activity/${childId}/web-history`)
    .set('Authorization', `Bearer ${tokenFor(parent)}`)
    .query(query);

const visit = (domain, overrides = {}) => ({
  domain,
  firstSeen: Date.now(),
  lastSeen: Date.now(),
  count: 1,
  blocked: false,
  ...overrides,
});

describe('Web history — collection', () => {
  it('stores a visit reported by the device and returns it to the parent', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const res = await post(device, [visit('example.com')]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: 1, merged: 0, rejected: 0, received: 1 });

    const history = await read(parent, child.id);
    expect(history.status).toBe(200);
    expect(history.body.count).toBe(1);
    expect(history.body.rows[0]).toMatchObject({ url: 'example.com', category: 'browsing' });
    expect(history.body.rows[0].deviceId).toBe(device.id);
  });

  it('stores the domain encrypted, not in the clear', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    await post(device, [visit('secret-site.com')]);

    // Read past the model hooks to see what is actually on disk.
    const [row] = await ActivityLog.sequelize.query(
      'SELECT url, url_hash FROM activity_logs WHERE child_id = ?',
      { replacements: [child.id], type: ActivityLog.sequelize.QueryTypes.SELECT },
    );
    expect(row.url).not.toContain('secret-site.com');
    expect(row.url).toMatch(/^[^:]+:[^:]+:.+$/); // iv:tag:ciphertext
    expect(row.url_hash).toBe(blindIndex('secret-site.com'));
  });

  it('folds repeat lookups of one domain into a single row', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    await post(device, [visit('news.example.com', { count: 3 })]);
    await post(device, [visit('news.example.com', { count: 2 })]);
    await post(device, [visit('news.example.com', { count: 1 })]);

    const history = await read(parent, child.id);
    expect(history.body.count).toBe(1);
    expect(history.body.rows[0].visitCount).toBe(6);
  });

  it('starts a new row once the visit window has passed', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const old = Date.now() - 2 * 60 * 60 * 1000;
    await post(device, [visit('example.org', { firstSeen: old, lastSeen: old })]);
    await post(device, [visit('example.org')]);

    const history = await read(parent, child.id);
    expect(history.body.count).toBe(2);
  });

  it('accepts a batch of different domains in one request', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const res = await post(device, [visit('a.example.com'), visit('b.example.com'), visit('c.example.com')]);
    expect(res.body.created).toBe(3);

    const history = await read(parent, child.id);
    expect(history.body.count).toBe(3);
  });

  it('drops malformed entries without failing the rest of the batch', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const res = await post(device, [
      visit('good.example.com'),
      visit(''),
      visit('not a domain'),
      visit('javascript:alert(1)'),
      { domain: null },
      visit('also-good.example.com'),
    ]);

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(2);
    expect(res.body.rejected).toBe(4);

    const history = await read(parent, child.id);
    expect(history.body.rows.map((r) => r.url).sort()).toEqual(['also-good.example.com', 'good.example.com']);
  });

  it('rejects a payload that is not an array, and one that is too large', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    expect((await post(device, 'nope')).status).toBe(400);
    expect((await post(device, Array.from({ length: 201 }, (_, i) => visit(`d${i}.example.com`)))).status).toBe(400);
  });

  it('accepts an empty batch as a no-op', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const res = await post(device, []);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: 0, merged: 0, received: 0 });
  });

  it('updates the device\'s lastSeen when history arrives', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id, { lastSeen: new Date(Date.now() - 60 * 60 * 1000) });
    const before = device.lastSeen;

    await post(device, [visit('ping.example.com')]);
    await device.reload();
    expect(new Date(device.lastSeen).getTime()).toBeGreaterThan(new Date(before).getTime());
  });
});

describe('Web history — dashboard queries', () => {
  const seed = async (device, domains) => {
    for (const d of domains) {
      // Spread them apart so each is its own visit rather than a merge.
      const at = Date.now() - domains.indexOf(d) * 2 * 60 * 60 * 1000;
      await post(device, [visit(d, { firstSeen: at, lastSeen: at })]);
    }
  };

  it('filters by date range', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    const longAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    await post(device, [visit('old.example.com', { firstSeen: longAgo, lastSeen: longAgo })]);
    await post(device, [visit('recent.example.com')]);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const res = await read(parent, child.id, { from: since });
    expect(res.body.rows.map((r) => r.url)).toEqual(['recent.example.com']);
  });

  it('searches by exact domain and by fragment', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    await seed(device, ['youtube.com', 'youtube-nocookie.com', 'wikipedia.org']);

    const exact = await read(parent, child.id, { search: 'youtube.com' });
    expect(exact.body.rows.map((r) => r.url)).toEqual(['youtube.com']);

    // A fragment cannot use the blind index, so this exercises the decrypt-and-
    // filter path.
    const fragment = await read(parent, child.id, { search: 'youtube' });
    expect(fragment.body.rows.map((r) => r.url).sort())
      .toEqual(['youtube-nocookie.com', 'youtube.com']);

    const none = await read(parent, child.id, { search: 'nothing-here' });
    expect(none.body.count).toBe(0);
    expect(none.body.rows).toEqual([]);
  });

  it('paginates', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    await seed(device, Array.from({ length: 6 }, (_, i) => `site${i}.example.com`));

    const first = await read(parent, child.id, { limit: 2, offset: 0 });
    const second = await read(parent, child.id, { limit: 2, offset: 2 });

    expect(first.body.count).toBe(6);
    expect(first.body.rows).toHaveLength(2);
    expect(second.body.rows[0].id).not.toBe(first.body.rows[0].id);
  });

  it('returns an empty result rather than an error when there is no history', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);

    const res = await read(parent, child.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 0, rows: [], truncated: false });
  });

  it('does not mix app-usage rows into web history', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    await request(app).post('/api/devices/me/activity')
      .set('Authorization', `Bearer ${deviceToken(device)}`)
      .send({ appName: 'A Game', appPackage: 'com.example.game', category: 'app_usage', durationMinutes: 20 });
    await post(device, [visit('browsed.example.com')]);

    const history = await read(parent, child.id);
    expect(history.body.rows.map((r) => r.url)).toEqual(['browsed.example.com']);
  });
});

describe('Web history — isolation and authorization', () => {
  it('keeps one child\'s history out of another child\'s', async () => {
    const parent = await createUser();
    const ada = await createChild(parent.id, { name: 'Ada' });
    const ben = await createChild(parent.id, { name: 'Ben' });
    const adaDevice = await createDevice(ada.id);

    await post(adaDevice, [visit('ada-only.example.com')]);

    expect((await read(parent, ada.id)).body.rows.map((r) => r.url)).toEqual(['ada-only.example.com']);
    expect((await read(parent, ben.id)).body.rows).toEqual([]);
  });

  it('refuses to show one parent another family\'s history', async () => {
    const owner = await createUser();
    const child = await createChild(owner.id);
    const device = await createDevice(child.id);
    await post(device, [visit('private.example.com')]);

    const attacker = await createUser();
    const res = await request(app)
      .get(`/api/activity/${child.id}/web-history`)
      .set('Authorization', `Bearer ${tokenFor(attacker)}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('private.example.com');
  });

  it('records history against the device\'s own child, whatever the body claims', async () => {
    const parent = await createUser();
    const ada = await createChild(parent.id, { name: 'Ada' });
    const ben = await createChild(parent.id, { name: 'Ben' });
    const adaDevice = await createDevice(ada.id);

    await request(app)
      .post('/api/devices/me/web-history')
      .set('Authorization', `Bearer ${deviceToken(adaDevice)}`)
      // A compromised device trying to write into a sibling's history.
      .send({ childId: ben.id, deviceId: 'anything', visits: [visit('injected.example.com')] });

    expect((await read(parent, ben.id)).body.rows).toEqual([]);
    expect((await read(parent, ada.id)).body.rows.map((r) => r.url)).toEqual(['injected.example.com']);
  });

  // See contactSync.test.js for why this matters: Postgres 500s on a malformed
  // UUID where SQLite quietly matches nothing.
  it('treats a malformed childId as not found rather than erroring', async () => {
    const parent = await createUser();
    for (const bad of ['not-a-uuid', '0', "' OR 1=1--"]) {
      const res = await request(app)
        .get(`/api/activity/${encodeURIComponent(bad)}/web-history`)
        .set('Authorization', `Bearer ${tokenFor(parent)}`);
      expect(res.status).toBe(404);
    }
  });

  it('rejects unauthenticated, malformed and parent tokens on the device endpoint', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    await createDevice(child.id);

    expect((await request(app).post('/api/devices/me/web-history').send({ visits: [] })).status).toBe(401);

    expect((await request(app).post('/api/devices/me/web-history')
      .set('Authorization', 'Bearer garbage').send({ visits: [] })).status).toBe(401);

    expect((await request(app).post('/api/devices/me/web-history')
      .set('Authorization', `Bearer ${tokenFor(parent)}`).send({ visits: [] })).status).toBe(401);
  });

  it('rejects a revoked device', async () => {
    const parent = await createUser();
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    const token = deviceToken(device);

    await device.update({ isActive: false });
    const res = await request(app).post('/api/devices/me/web-history')
      .set('Authorization', `Bearer ${token}`).send({ visits: [visit('after-revoke.example.com')] });
    expect(res.status).toBe(401);
    expect(await ActivityLog.count({ where: { childId: child.id } })).toBe(0);
  });
});
