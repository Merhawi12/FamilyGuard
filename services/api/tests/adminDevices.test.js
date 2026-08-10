const request = require('supertest');
const { app } = require('../src/app');
const { AppRule, WebsiteRule, ScreenTimeRule } = require('../src/models');
const { createUser, createChild, createDevice, tokenFor } = require('./helpers');

const bearer = (u) => ({ Authorization: `Bearer ${tokenFor(u)}` });

const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);

/** A parent with one child and one device, ready to be found by the console. */
const fleetOf = async (deviceOverrides = {}, userOverrides = {}) => {
  const parent = await createUser({ role: 'parent', ...userOverrides });
  const child = await createChild(parent.id, { name: 'Ethan' });
  const device = await createDevice(child.id, deviceOverrides);
  return { parent, child, device };
};

describe('GET /admin/devices — access', () => {
  it('401 without a token, 403 for a parent, 403 for staff without manage_users', async () => {
    expect((await request(app).get('/api/admin/devices')).status).toBe(401);

    const parent = await createUser({ role: 'parent' });
    expect((await request(app).get('/api/admin/devices').set(bearer(parent))).status).toBe(403);

    const finance = await createUser({ role: 'finance', permissions: ['manage_billing'] });
    expect((await request(app).get('/api/admin/devices').set(bearer(finance))).status).toBe(403);
  });

  it('200 for support with manage_users and for a super admin', async () => {
    const support = await createUser({ role: 'support', permissions: ['manage_users'] });
    const admin = await createUser({ role: 'super_admin' });
    expect((await request(app).get('/api/admin/devices').set(bearer(support))).status).toBe(200);
    expect((await request(app).get('/api/admin/devices').set(bearer(admin))).status).toBe(200);
  });
});

describe('GET /admin/devices — the fleet', () => {
  it('reports a device with its child, its owner and its policy, and never its push token', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const { parent, child } = await fleetOf({
      name: "Ethan's iPhone", type: 'ios', osVersion: '16.5.1',
      lastSeen: minutesAgo(2), pushToken: 'secret-token',
    });
    await AppRule.create({ childId: child.id, appName: 'TikTok' });
    await WebsiteRule.create({ childId: child.id, url: 'example.com' });
    await ScreenTimeRule.create({ childId: child.id, dailyLimitMinutes: 90, bedtimeEnabled: true });

    const res = await request(app).get('/api/admin/devices').set(bearer(admin));
    expect(res.status).toBe(200);

    const row = res.body.rows.find((d) => d.name === "Ethan's iPhone");
    expect(row.status).toBe('online');
    expect(row.child.name).toBe('Ethan');
    expect(row.owner.email).toBe(parent.email);
    expect(row.policy).toEqual({
      appRules: 1, websiteRules: 1, dailyLimitMinutes: 90, bedtimeEnabled: true,
    });
    expect(row.pushRegistered).toBe(true);
    expect(JSON.stringify(row)).not.toContain('secret-token');
  });

  it('derives online, offline and pending from the last heartbeat', async () => {
    const admin = await createUser({ role: 'super_admin' });
    await fleetOf({ name: 'Live phone', lastSeen: minutesAgo(3) });
    await fleetOf({ name: 'Quiet phone', lastSeen: minutesAgo(14 * 60) });
    await fleetOf({ name: 'Never linked', isLinked: false, lastSeen: null });

    const res = await request(app).get('/api/admin/devices').set(bearer(admin));
    const status = (name) => res.body.rows.find((d) => d.name === name).status;

    expect(status('Live phone')).toBe('online');
    expect(status('Quiet phone')).toBe('offline');
    expect(status('Never linked')).toBe('pending');
  });

  it('filters by status and by platform', async () => {
    const admin = await createUser({ role: 'super_admin' });
    await fleetOf({ name: 'Filter live', type: 'ios', lastSeen: minutesAgo(1) });
    await fleetOf({ name: 'Filter quiet', type: 'android', lastSeen: minutesAgo(600) });
    await fleetOf({ name: 'Filter pending', type: 'android', isLinked: false, lastSeen: null });

    const names = (query) => request(app).get(`/api/admin/devices?${query}`).set(bearer(admin))
      .then((r) => r.body.rows.map((d) => d.name));

    const online = await names('status=online');
    expect(online).toContain('Filter live');
    expect(online).not.toContain('Filter quiet');

    const offline = await names('status=offline');
    expect(offline).toContain('Filter quiet');
    expect(offline).not.toContain('Filter pending');

    const pending = await names('status=pending');
    expect(pending).toEqual(expect.arrayContaining(['Filter pending']));
    expect(pending).not.toContain('Filter live');

    const ios = await names('platform=ios');
    expect(ios).toContain('Filter live');
    expect(ios).not.toContain('Filter quiet');
  });

  it('searches the device name, the child and the owner, ignoring case', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const parent = await createUser({ role: 'parent', name: 'Wilhelmina Smith' });
    const child = await createChild(parent.id, { name: 'Chloe' });
    await createDevice(child.id, { name: 'Galaxy Tab', lastSeen: minutesAgo(5) });

    const names = (query) => request(app).get(`/api/admin/devices?search=${query}`).set(bearer(admin))
      .then((r) => r.body.rows.map((d) => d.name));

    expect(await names('galaxy')).toContain('Galaxy Tab');
    expect(await names('chloe')).toContain('Galaxy Tab');
    expect(await names('wilhelmina')).toContain('Galaxy Tab');
    expect(await names(encodeURIComponent(parent.email.toUpperCase()))).toContain('Galaxy Tab');
    expect(await names('nobody-by-that-name')).toEqual([]);
  });

  it('summarises the whole fleet, not the filtered page', async () => {
    const admin = await createUser({ role: 'super_admin' });
    // Measured as a delta: the suite shares one database, so the fleet is not
    // empty when this test starts.
    const before = (await request(app).get('/api/admin/devices').set(bearer(admin))).body.summary;

    await fleetOf({ name: 'Summary live', type: 'ios', lastSeen: minutesAgo(2) });
    await fleetOf({ name: 'Summary stale', type: 'android', lastSeen: minutesAgo(3 * 24 * 60) });
    await fleetOf({ name: 'Summary pending', type: 'android', isLinked: false, lastSeen: null });

    const res = await request(app).get('/api/admin/devices?platform=ios&limit=1').set(bearer(admin));
    const { summary } = res.body;
    const grew = (key) => summary[key] - before[key];

    // One row asked for, one row returned — and the tiles still count the fleet.
    expect(res.body.rows).toHaveLength(1);
    expect(grew('total')).toBe(3);
    expect(grew('linked')).toBe(2);
    expect(grew('online')).toBe(1);
    expect(grew('offline')).toBe(1);
    expect(grew('pending')).toBe(1);
    expect(summary.reporting.live - before.reporting.live).toBe(1);
    expect(summary.reporting.stale - before.reporting.stale).toBe(1);
    expect(summary.syncRate).toBe(Math.round((summary.reporting.live + summary.reporting.today)
      / summary.linked * 100));

    const platformCount = (rows, platform) => rows.find((p) => p.platform === platform)?.count || 0;
    expect(platformCount(summary.byPlatform, 'ios') - platformCount(before.byPlatform, 'ios')).toBe(1);
    expect(platformCount(summary.byPlatform, 'android') - platformCount(before.byPlatform, 'android')).toBe(2);
  });

  it('leaves a removed device out of the fleet entirely', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const { device } = await fleetOf({ name: 'Removed phone', lastSeen: minutesAgo(5) });
    await device.update({ isActive: false });

    const res = await request(app).get('/api/admin/devices').set(bearer(admin));
    expect(res.body.rows.map((d) => d.name)).not.toContain('Removed phone');
  });

  it('orders most recently seen first and never-seen last', async () => {
    const admin = await createUser({ role: 'super_admin' });
    await fleetOf({ name: 'Order never', isLinked: false, lastSeen: null });
    await fleetOf({ name: 'Order old', lastSeen: minutesAgo(500) });
    await fleetOf({ name: 'Order fresh', lastSeen: minutesAgo(1) });

    const res = await request(app).get('/api/admin/devices').set(bearer(admin));
    const order = res.body.rows.map((d) => d.name);

    expect(order.indexOf('Order fresh')).toBeLessThan(order.indexOf('Order old'));
    expect(order.indexOf('Order old')).toBeLessThan(order.indexOf('Order never'));
  });
});
