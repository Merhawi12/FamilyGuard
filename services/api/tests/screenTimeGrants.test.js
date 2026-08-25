/**
 * Extra minutes for today, and the day boundary nobody on the server may decide.
 *
 * Both lock screens and the child app's Messages have long offered "ask for more
 * time" with nothing on this side to answer it, so a parent who wanted to say yes
 * raised `dailyLimitMinutes` and was supposed to lower it in the morning. These
 * pin the alternative: a row that expires on its own, leaves the rule alone, and
 * reaches the device fast enough to be worth tapping while the child is standing
 * there.
 *
 * The recurring trap in this area is the one the whole feature is arranged
 * around: this process runs in UTC and the families are in Canada, so anything
 * that computes "today" here is wrong from about 20:00 local. The API therefore
 * answers with instants and lets the browser and the device apply their own
 * midnights — asserted below by checking that no total is ever returned.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { ScreenTimeGrant, ScreenTimeRule } = require('../src/models');
const { createUser, tokenFor, createChild, createDevice, deviceToken } = require('./helpers');

let parent; let token; let child;

beforeEach(async () => {
  parent = await createUser();
  token = tokenFor(parent);
  child = await createChild(parent.id);
});

const grant = (body, query = '') =>
  request(app)
    .post(`/api/screen-time/${child.id}/grant${query}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);

const listGrants = (query = '') =>
  request(app)
    .get(`/api/screen-time/${child.id}/grant${query}`)
    .set('Authorization', `Bearer ${token}`);

describe('granting extra time', () => {
  it('creates a grant without touching the rule', async () => {
    // The rule has to exist first, or there is nothing to prove was left alone.
    await request(app)
      .put(`/api/screen-time/${child.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ dailyLimitMinutes: 90 });

    const res = await grant({ minutes: 15 });

    expect(res.status).toBe(201);
    expect(res.body.minutes).toBe(15);

    // The whole point: the policy is unchanged, so tomorrow is still 90 minutes.
    const rule = await ScreenTimeRule.findOne({ where: { childId: child.id, deviceId: null } });
    expect(rule.dailyLimitMinutes).toBe(90);
  });

  it('stacks rather than replacing', async () => {
    await grant({ minutes: 15 });
    await grant({ minutes: 15 });

    const res = await listGrants();
    expect(res.body.grants).toHaveLength(2);
    expect(res.body.grants.reduce((t, g) => t + g.minutes, 0)).toBe(30);
  });

  it('answers with instants, never a total for "today"', async () => {
    await grant({ minutes: 15 });
    const res = await listGrants();

    // A `minutes` total computed here would be right for about four hours a day.
    // The contract is deliberately rows-and-timestamps; the browser and the
    // device each apply their own midnight.
    expect(res.body.minutes).toBeUndefined();
    expect(res.body.grants[0].grantedAt).toEqual(expect.any(String));
    expect(Number.isNaN(new Date(res.body.grants[0].grantedAt).getTime())).toBe(false);
  });

  it.each([0, -15, 4, 241, 12.5, '15', null])('refuses %p minutes', async (minutes) => {
    const res = await grant({ minutes });
    expect(res.status).toBe(400);
    expect(await ScreenTimeGrant.count({ where: { childId: child.id } })).toBe(0);
  });

  it('refuses another parent\'s child', async () => {
    const stranger = await createUser();
    const res = await request(app)
      .post(`/api/screen-time/${child.id}/grant`)
      .set('Authorization', `Bearer ${tokenFor(stranger)}`)
      .send({ minutes: 15 });

    expect(res.status).toBe(404);
    expect(await ScreenTimeGrant.count({ where: { childId: child.id } })).toBe(0);
  });

  it('refuses a device that is not this child\'s', async () => {
    const otherChild = await createChild(parent.id, { name: 'Sibling' });
    const siblingDevice = await createDevice(otherChild.id);

    const res = await grant({ minutes: 15, deviceId: siblingDevice.id });
    expect(res.status).toBe(400);
    expect(await ScreenTimeGrant.count({ where: { childId: child.id } })).toBe(0);
  });
});

describe('a grant can be narrowed to one device', () => {
  let laptop; let phone;

  beforeEach(async () => {
    laptop = await createDevice(child.id, { name: 'Laptop' });
    phone = await createDevice(child.id, { name: 'Phone' });
  });

  it('reaches only the device it names', async () => {
    await grant({ minutes: 30 }, `?deviceId=${laptop.id}`);

    const laptopRules = await request(app)
      .get('/api/devices/me/rules')
      .set('Authorization', `Bearer ${deviceToken(laptop)}`);
    const phoneRules = await request(app)
      .get('/api/devices/me/rules')
      .set('Authorization', `Bearer ${deviceToken(phone)}`);

    expect(laptopRules.body.screenTimeGrants).toHaveLength(1);
    expect(laptopRules.body.screenTimeGrants[0].minutes).toBe(30);
    // The sibling never learns a grant for the laptop exists — the same rule the
    // three rule tables follow, enforced in SQL rather than after the fact.
    expect(phoneRules.body.screenTimeGrants).toEqual([]);
  });

  /**
   * The one place grants deliberately differ from rules.
   *
   * A device-specific *rule* overrides the child-wide one, because two rules are
   * two answers to the same question. Two grants are two gifts of minutes, and a
   * parent who added fifteen to the child and fifteen more to the laptop has
   * plainly given that laptop thirty.
   */
  it('adds to the child-wide grant instead of overriding it', async () => {
    await grant({ minutes: 15 });
    await grant({ minutes: 15 }, `?deviceId=${laptop.id}`);

    const laptopRules = await request(app)
      .get('/api/devices/me/rules')
      .set('Authorization', `Bearer ${deviceToken(laptop)}`);
    const phoneRules = await request(app)
      .get('/api/devices/me/rules')
      .set('Authorization', `Bearer ${deviceToken(phone)}`);

    expect(laptopRules.body.screenTimeGrants.reduce((t, g) => t + g.minutes, 0)).toBe(30);
    expect(phoneRules.body.screenTimeGrants.reduce((t, g) => t + g.minutes, 0)).toBe(15);
  });

  it('shows a device its own grants plus the shared ones when the parent narrows the view', async () => {
    await grant({ minutes: 15 });
    await grant({ minutes: 45 }, `?deviceId=${laptop.id}`);

    const res = await listGrants(`?deviceId=${laptop.id}`);
    expect(res.body.grants.reduce((t, g) => t + g.minutes, 0)).toBe(60);
  });
});

describe('the device sync carries the grants', () => {
  it('sends an empty list when nothing has been granted', async () => {
    const device = await createDevice(child.id);
    const res = await request(app)
      .get('/api/devices/me/rules')
      .set('Authorization', `Bearer ${deviceToken(device)}`);

    // Present and empty, not absent: the clients merge the payload over their
    // defaults, and a missing key would be indistinguishable from an API too old
    // to know about grants.
    expect(res.body.screenTimeGrants).toEqual([]);
  });

  /**
   * A grant old enough to be outside every timezone's "today" is not sent.
   *
   * 48 hours is the window, and the reason it is not 24 is that the device — not
   * this process — decides which grants are still live. Sending it a stale row is
   * harmless; failing to send a live one silently takes back minutes a parent gave.
   */
  it('leaves out a grant from three days ago', async () => {
    const device = await createDevice(child.id);
    await ScreenTimeGrant.create({ childId: child.id, minutes: 60, grantedBy: parent.id });
    await ScreenTimeGrant.update(
      { createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
      { where: { childId: child.id }, silent: true },
    );

    const res = await request(app)
      .get('/api/devices/me/rules')
      .set('Authorization', `Bearer ${deviceToken(device)}`);

    expect(res.body.screenTimeGrants).toEqual([]);
  });

  it('keeps a grant from this morning', async () => {
    const device = await createDevice(child.id);
    await ScreenTimeGrant.create({ childId: child.id, minutes: 20, grantedBy: parent.id });

    const res = await request(app)
      .get('/api/devices/me/rules')
      .set('Authorization', `Bearer ${deviceToken(device)}`);

    expect(res.body.screenTimeGrants).toHaveLength(1);
    expect(res.body.screenTimeGrants[0]).toMatchObject({ minutes: 20 });
  });
});
