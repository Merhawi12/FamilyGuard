/**
 * `dangerous_content`, now that something raises it.
 *
 * The type sat in the platform's alert catalogue with a socket handler waiting
 * on an `alert:dangerous_content` the device has never sent and cannot: naming
 * a page dangerous means seeing the page, and the phone sees DNS names. The
 * console listed it as a rule and the family app offered a preference for it,
 * and in two years it had never once fired.
 *
 * It is raised from the domains the device already reports, against the category
 * table the platform already has. What these checks pin is the part that decides
 * whether it is worth having at all — that one browsing session cannot turn into
 * a page of identical high-severity alerts, each of them an email and a push.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { Alert } = require('../src/models');
const { flushBackground } = require('../src/utils/background');
const { createUser, createChild, createDevice, deviceToken } = require('./helpers');

const post = (device, domains) =>
  request(app)
    .post('/api/devices/me/web-history')
    .set('Authorization', `Bearer ${deviceToken(device)}`)
    .send({
      visits: domains.map((domain) => ({
        domain, firstSeen: Date.now(), lastSeen: Date.now(), count: 1,
      })),
    });

const alertsFor = (childId) =>
  Alert.findAll({ where: { childId, type: 'dangerous_content' }, order: [['createdAt', 'ASC']] });

let parent;
let child;
let device;

beforeEach(async () => {
  parent = await createUser();
  child = await createChild(parent.id, { name: 'Ada' });
  device = await createDevice(child.id);
});

describe('a risky site opened on a child device', () => {
  it('raises an alert naming the category and the domain', async () => {
    const res = await post(device, ['pornhub.com']);
    expect(res.status).toBe(201);
    await flushBackground();

    const [alert] = await alertsFor(child.id);
    expect(alert).toBeTruthy();
    expect(alert.severity).toBe('high');
    expect(alert.message).toMatch(/adult content/i);
    expect(alert.message).toContain('pornhub.com');
    expect(JSON.parse(alert.metadata)).toMatchObject({ category: 'adult', domain: 'pornhub.com' });
  });

  it('fires even though the parent had not blocked the category', async () => {
    // Blocking is the parent's configuration; the lookup is the child's
    // behaviour. A parent who has not switched the category on is exactly the
    // parent who has not learned they need to.
    await post(device, ['bet365.com']);
    await flushBackground();

    const alerts = await alertsFor(child.id);
    expect(alerts).toHaveLength(1);
    expect(JSON.parse(alerts[0].metadata).category).toBe('gambling');
  });

  it('matches a subdomain the way the device matches a rule', async () => {
    await post(device, ['www.xvideos.com']);
    await flushBackground();

    expect(await alertsFor(child.id)).toHaveLength(1);
  });

  it('says nothing about an ordinary site', async () => {
    await post(device, ['wikipedia.org', 'bbc.co.uk', 'khanacademy.org']);
    await flushBackground();

    expect(await alertsFor(child.id)).toHaveLength(0);
  });

  /**
   * The check that decides whether this feature is usable. Social media, gaming
   * and streaming are in the catalogue so a parent can *limit* them; one alert
   * per youtube.com lookup would bury the two categories that mean something.
   */
  it('says nothing about a category a parent only wants to limit', async () => {
    await post(device, ['youtube.com', 'roblox.com', 'instagram.com']);
    await flushBackground();

    expect(await alertsFor(child.id)).toHaveLength(0);
  });

  it('speaks once for a whole batch, however many lookups it holds', async () => {
    // One page load resolves the same host many times over.
    await post(device, ['pornhub.com', 'xvideos.com', 'xnxx.com']);
    await flushBackground();

    const alerts = await alertsFor(child.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toMatch(/and 2 others/);
  });

  it('does not alert again for the same category in the same hour', async () => {
    await post(device, ['pornhub.com']);
    await flushBackground();
    await post(device, ['xhamster.com']);
    await flushBackground();

    expect(await alertsFor(child.id)).toHaveLength(1);
  });

  it('still reports a different category in that hour', async () => {
    await post(device, ['pornhub.com']);
    await flushBackground();
    await post(device, ['bet365.com']);
    await flushBackground();

    const categories = (await alertsFor(child.id)).map((a) => JSON.parse(a.metadata).category);
    expect(categories.sort()).toEqual(['adult', 'gambling']);
  });

  it('keeps one family’s browsing out of another family’s alerts', async () => {
    const other = await createUser();
    const otherChild = await createChild(other.id);
    const otherDevice = await createDevice(otherChild.id);

    await post(otherDevice, ['pornhub.com']);
    await flushBackground();

    expect(await alertsFor(child.id)).toHaveLength(0);
    expect(await alertsFor(otherChild.id)).toHaveLength(1);
  });

  it('stores the visits even if the alert cannot be raised', async () => {
    // The device is waiting to clear its queue; an alert failure must never turn
    // a successful upload into a retry.
    const spy = jest.spyOn(Alert, 'create').mockRejectedValue(new Error('alerts are down'));

    const res = await post(device, ['pornhub.com']);
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(1);
    await flushBackground();

    spy.mockRestore();
  });
});
