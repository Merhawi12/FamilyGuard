const request = require('supertest');
const { app } = require('../src/app');
const { WebsiteRule, SystemSetting } = require('../src/models');
const { domainsForCategory } = require('../src/config/contentCategories');
const { resolveBlockedDomains } = require('../src/utils/contentPolicy');
const { createUser, tokenFor, createChild, createDevice, deviceToken } = require('./helpers');

const bearer = (u) => ({ Authorization: `Bearer ${tokenFor(u)}` });

const getPolicy = (admin) => request(app).get('/api/admin/content-filtering').set(bearer(admin));
const putPolicy = (admin, body) => request(app).put('/api/admin/content-filtering').set(bearer(admin)).send(body);

const deviceRules = (device) => request(app)
  .get('/api/devices/me/rules')
  .set('Authorization', `Bearer ${deviceToken(device)}`);

const reportVisits = (device, visits) => request(app)
  .post('/api/devices/me/web-history')
  .set('Authorization', `Bearer ${deviceToken(device)}`)
  .send({ visits });

const visit = (domain, overrides = {}) => ({
  domain, firstSeen: Date.now(), lastSeen: Date.now(), count: 1, blocked: false, ...overrides,
});

// The policy is one row shared by every test in the file, so each one that
// changes it puts it back.
afterEach(async () => { await SystemSetting.destroy({ where: { key: 'contentFiltering' } }); });

describe('the platform-wide filtering policy', () => {
  it('is gated by manage_settings, not by the directory permission', async () => {
    const parent = await createUser({ role: 'parent' });
    const support = await createUser({ role: 'support', permissions: ['manage_users'] });
    const ops = await createUser({ role: 'operations', permissions: ['manage_settings'] });

    expect((await request(app).get('/api/admin/content-filtering')).status).toBe(401);
    expect((await getPolicy(parent)).status).toBe(403);
    expect((await getPolicy(support)).status).toBe(403);
    expect((await putPolicy(support, { categories: ['adult'] })).status).toBe(403);
    expect((await getPolicy(ops)).status).toBe(200);
  });

  it('starts empty — a platform does not block anything nobody asked it to', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const res = await getPolicy(admin);

    expect(res.status).toBe(200);
    expect(res.body.policy).toEqual({ categories: [], domainRules: [] });
    expect(res.body.strength).toBe('off');
    expect(res.body.enforcedDomains).toBe(0);
    expect(res.body.catalogue.length).toBeGreaterThanOrEqual(6);
    expect(res.body.catalogue[0]).toMatchObject({ key: 'adult', label: 'Adult Content' });
  });

  it('saves categories and reports how many domains they put in force', async () => {
    const admin = await createUser({ role: 'super_admin' });

    const saved = await putPolicy(admin, { categories: ['adult', 'gambling'] });
    expect(saved.status).toBe(200);
    expect(saved.body.policy.categories.sort()).toEqual(['adult', 'gambling']);

    const res = await getPolicy(admin);
    expect(res.body.enforcedDomains).toBe(
      domainsForCategory('adult').length + domainsForCategory('gambling').length
    );
    expect(res.body.strength).toBe('standard');
  });

  it('refuses a category it has no domains for, and a domain it could never match', async () => {
    const admin = await createUser({ role: 'super_admin' });

    const unknown = await putPolicy(admin, { categories: ['violence'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/Unknown category/);

    const bad = await putPolicy(admin, { domainRules: [{ domain: 'not a domain!!', action: 'block' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/not a domain!!/);
  });

  it('takes a pasted URL and stores the hostname the device can match', async () => {
    const admin = await createUser({ role: 'super_admin' });

    // What an operator copies out of the address bar. Storing it as typed would
    // be a rule that looks enforced and never matches a DNS lookup.
    const res = await putPolicy(admin, { domainRules: [{ domain: 'https://www.example.com/watch?v=1', action: 'block' }] });
    expect(res.status).toBe(200);
    expect(res.body.policy.domainRules[0].domain).toBe('example.com');
  });

  it('normalizes a domain rule and stamps who added it', async () => {
    const admin = await createUser({ role: 'super_admin', name: 'Dana Ops' });

    const res = await putPolicy(admin, { domainRules: [{ domain: 'WWW.Roblox.com', action: 'block' }] });
    expect(res.status).toBe(200);
    expect(res.body.policy.domainRules).toHaveLength(1);
    expect(res.body.policy.domainRules[0]).toMatchObject({ domain: 'roblox.com', action: 'block', addedBy: 'Dana Ops' });
  });

  it('keeps the original author when an untouched rule is saved again', async () => {
    const first = await createUser({ role: 'super_admin', name: 'First Operator' });
    const second = await createUser({ role: 'super_admin', name: 'Second Operator' });

    await putPolicy(first, { domainRules: [{ domain: 'roblox.com', action: 'block' }] });
    const after = await putPolicy(second, {
      domainRules: [
        { domain: 'roblox.com', action: 'block' },
        { domain: 'stake.com', action: 'block' },
      ],
    });

    const byDomain = Object.fromEntries(after.body.policy.domainRules.map((r) => [r.domain, r]));
    expect(byDomain['roblox.com'].addedBy).toBe('First Operator');
    expect(byDomain['stake.com'].addedBy).toBe('Second Operator');
  });

  it('leaves the half of the policy the request did not mention alone', async () => {
    const admin = await createUser({ role: 'super_admin' });

    await putPolicy(admin, { categories: ['gambling'] });
    await putPolicy(admin, { domainRules: [{ domain: 'example.com', action: 'block' }] });

    const res = await getPolicy(admin);
    expect(res.body.policy.categories).toEqual(['gambling']);
    expect(res.body.policy.domainRules).toHaveLength(1);
  });

  it('writes an audit entry naming what changed', async () => {
    const admin = await createUser({ role: 'super_admin' });
    await putPolicy(admin, { categories: ['adult'] });

    const logs = await request(app).get('/api/audit?action=admin.content_filtering_updated').set(bearer(admin));
    expect(logs.status).toBe(200);
    expect(logs.body.rows.length).toBeGreaterThan(0);
    const { metadata } = logs.body.rows[0];
    expect(typeof metadata === 'string' ? JSON.parse(metadata) : metadata).toMatchObject({ categories: ['adult'] });
  });
});

/**
 * The part that matters most: a category is only a promise until the device
 * receives domains it can block. Every case here is a rule a parent or an
 * operator can set, checked at the endpoint the phone actually calls.
 */
describe('what a device is told to block', () => {
  const setup = async () => {
    const parent = await createUser({ role: 'parent', plan: 'premium' });
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);
    return { parent, child, device };
  };

  const blockedDomains = (body) => body.websiteRules.filter((r) => r.action === 'block').map((r) => r.url);

  it('expands the platform policy into domains the device can match', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const { device } = await setup();

    await putPolicy(admin, { categories: ['gambling'] });

    const res = await deviceRules(device);
    expect(res.status).toBe(200);
    expect(blockedDomains(res.body)).toEqual(expect.arrayContaining(domainsForCategory('gambling')));
  });

  it("expands a parent's own category rule, which used to block nothing at all", async () => {
    const { child, device } = await setup();
    await WebsiteRule.create({ childId: child.id, category: 'social_media', action: 'block' });

    const domains = blockedDomains((await deviceRules(device)).body);
    expect(domains).toEqual(expect.arrayContaining(['tiktok.com', 'instagram.com']));
  });

  it('lets a parent allow one site the platform blocks by category', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const { child, device } = await setup();

    await putPolicy(admin, { categories: ['streaming'] });
    await WebsiteRule.create({ childId: child.id, url: 'youtube.com', action: 'allow' });

    const domains = blockedDomains((await deviceRules(device)).body);
    expect(domains).not.toContain('youtube.com');
    expect(domains).toContain('netflix.com');
  });

  it('keeps the parent\'s own rows intact so the family app can still delete them', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const { child, device } = await setup();

    const own = await WebsiteRule.create({ childId: child.id, url: 'example.com', action: 'block' });
    await putPolicy(admin, { categories: ['adult'] });

    const rules = (await deviceRules(device)).body.websiteRules;
    const mine = rules.find((r) => r.url === 'example.com');
    expect(mine.id).toBe(own.id);
    expect(mine.derived).toBeUndefined();
    expect(rules.filter((r) => r.derived).length).toBeGreaterThan(0);
  });

  it('never sends the same domain twice', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const { child, device } = await setup();

    await WebsiteRule.create({ childId: child.id, url: 'stake.com', action: 'block' });
    await putPolicy(admin, { categories: ['gambling'], domainRules: [{ domain: 'stake.com', action: 'block' }] });

    const domains = blockedDomains((await deviceRules(device)).body);
    expect(new Set(domains).size).toBe(domains.length);
  });
});

describe('the resolver itself', () => {
  it('puts a child block above a global allow, and a child allow above everything', () => {
    const policy = {
      categories: ['gaming'],
      domainRules: [{ domain: 'roblox.com', action: 'allow' }, { domain: 'example.com', action: 'block' }],
    };

    const globalAllow = resolveBlockedDomains({
      policy,
      childRules: [{ url: 'roblox.com', action: 'block', category: 'custom' }],
    }).map((r) => r.url);
    expect(globalAllow).toContain('roblox.com');

    const childAllow = resolveBlockedDomains({
      policy,
      childRules: [{ url: 'example.com', action: 'allow' }],
    }).map((r) => r.url);
    expect(childAllow).not.toContain('example.com');
  });

  it('says where each domain came from', () => {
    const resolved = resolveBlockedDomains({
      policy: { categories: ['adult'], domainRules: [{ domain: 'example.com', action: 'block' }] },
      childRules: [],
    });

    expect(resolved.find((r) => r.url === 'example.com').source).toBe('global_domain');
    expect(resolved.find((r) => r.url === 'pornhub.com')).toMatchObject({ source: 'global_category', category: 'adult' });
  });
});

/**
 * The blocked flag is the one signal that makes the console's activity figures
 * real. The device has always sent it; the API used to drop it.
 */
describe('blocked lookups', () => {
  it('stores the flag the device reports, and keeps it across a merge', async () => {
    const parent = await createUser({ role: 'parent' });
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    await reportVisits(device, [visit('pornhub.com', { blocked: true }), visit('example.com')]);
    // The same domain again in the same window, this time allowed: it was still
    // a blocked attempt.
    await reportVisits(device, [visit('pornhub.com', { blocked: false })]);

    const history = await request(app)
      .get(`/api/activity/${child.id}/web-history`)
      .set(bearer(parent));

    const rows = Object.fromEntries(history.body.rows.map((r) => [r.url, r]));
    expect(rows['pornhub.com'].blocked).toBe(true);
    expect(rows['pornhub.com'].visitCount).toBe(2);
    expect(rows['example.com'].blocked).toBe(false);
  });

  it('counts them by category for the console, without decrypting a single url', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const parent = await createUser({ role: 'parent' });
    const child = await createChild(parent.id);
    const device = await createDevice(child.id);

    await reportVisits(device, [
      visit('pornhub.com', { blocked: true, count: 3 }),
      visit('stake.com', { blocked: true, count: 2 }),
      visit('example.com', { blocked: true }),
      visit('wikipedia.org'),
    ]);

    const { body } = await getPolicy(admin);
    const byKey = Object.fromEntries(body.summary.blockedAttempts.byCategory.map((c) => [c.key, c.attempts]));

    expect(byKey.adult).toBeGreaterThanOrEqual(3);
    expect(byKey.gambling).toBeGreaterThanOrEqual(2);
    // A domain no category claims is still an attempt, and is not silently lost.
    expect(byKey.other).toBeGreaterThanOrEqual(1);
    expect(body.summary.blockedAttempts.total).toBeGreaterThanOrEqual(6);
    expect(body.summary.blockedAttempts.topDomains[0].domain).toBe('pornhub.com');
  });

  it('reports the fleet the policy reaches', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const parent = await createUser({ role: 'parent' });
    const child = await createChild(parent.id);
    await createDevice(child.id);
    await WebsiteRule.create({ childId: child.id, url: 'example.com', action: 'block' });

    const { body } = await getPolicy(admin);
    expect(body.summary.children).toBeGreaterThanOrEqual(1);
    expect(body.summary.devices).toBeGreaterThanOrEqual(1);
    expect(body.summary.customDomains).toBeGreaterThanOrEqual(1);
  });
});
