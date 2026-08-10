/**
 * App rules that the phone can actually carry out.
 *
 * The parent app offered three actions — Block, Allow only, Limit time — and a
 * package name marked "Optional". Only one of those four combinations did
 * anything: the device blocks by package name, ignores every action but `block`,
 * and drops a rule with no package. Everything else appeared in "Active app
 * rules" with a badge and changed nothing on the child's phone, which is the
 * worst possible failure for a control a parent believes they have set.
 *
 * These pin the shape the API now refuses, and the one it now supports.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { AppRule, ActivityLog } = require('../src/models');
const { createUser, tokenFor, createChild, createDevice } = require('./helpers');

let parent; let token; let child;

beforeEach(async () => {
  parent = await createUser();
  token = tokenFor(parent);
  child = await createChild(parent.id);
});

const addRule = (body) =>
  request(app).post(`/api/blocking/${child.id}/apps`).set('Authorization', `Bearer ${token}`).send(body);

describe('an app rule has to name an app the device can recognise', () => {
  it('creates a block rule with a package name', async () => {
    const res = await addRule({ appName: 'TikTok', appPackage: 'com.zhiliaoapp.musically' });

    expect(res.status).toBe(201);
    expect(res.body.action).toBe('block');
    expect(res.body.appPackage).toBe('com.zhiliaoapp.musically');
  });

  it('refuses a rule with no package name', async () => {
    // This used to be accepted and stored. The phone matches on package and
    // nothing else, so the row was decoration.
    const res = await addRule({ appName: 'Roblox' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/package name/i);
    expect(await AppRule.count({ where: { childId: child.id } })).toBe(0);
  });

  it('refuses a rule with no app name', async () => {
    const res = await addRule({ appPackage: 'com.roblox.client' });
    expect(res.status).toBe(400);
  });

  it('refuses an action nothing implements', async () => {
    // 'allow' was in the dropdown. For apps it meant blocking every other app on
    // the phone, which the device has no way to express, so it meant nothing.
    const res = await addRule({ appName: 'YouTube', appPackage: 'com.google.android.youtube', action: 'allow' });

    expect(res.status).toBe(400);
    expect(await AppRule.count({ where: { childId: child.id } })).toBe(0);
  });

  it('refuses an action that is not an action at all', async () => {
    const res = await addRule({ appName: 'X', appPackage: 'com.x', action: 'whatever' });
    expect(res.status).toBe(400);
  });
});

describe('a time limit is stored with the number it needs', () => {
  it('creates a limit rule', async () => {
    const res = await addRule({
      appName: 'YouTube', appPackage: 'com.google.android.youtube', action: 'limit', dailyLimitMinutes: 45,
    });

    expect(res.status).toBe(201);
    expect(res.body.action).toBe('limit');
    expect(res.body.dailyLimitMinutes).toBe(45);
  });

  it('refuses a limit rule with no limit', async () => {
    // Without a number there is nothing to compare the day's usage against, so
    // the rule would sit on the phone doing exactly what the old one did.
    const res = await addRule({ appName: 'YouTube', appPackage: 'com.google.android.youtube', action: 'limit' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/daily limit/i);
  });

  it.each([0, -5, 1441, 12.5])('refuses a limit of %p', async (dailyLimitMinutes) => {
    const res = await addRule({
      appName: 'YouTube', appPackage: 'com.google.android.youtube', action: 'limit', dailyLimitMinutes,
    });
    expect(res.status).toBe(400);
  });

  it('leaves the limit unset on a plain block rule', async () => {
    const res = await addRule({ appName: 'TikTok', appPackage: 'com.tiktok', action: 'block', dailyLimitMinutes: 30 });

    expect(res.status).toBe(201);
    // A block is not a limit. Carrying the number would make the device's
    // "is this app over its limit" check answer for a rule that has no limit.
    expect(res.body.dailyLimitMinutes).toBeNull();
  });
});

describe('the rule body cannot reassign the row it creates', () => {
  it('ignores an id supplied by the caller', async () => {
    const res = await addRule({
      id: '11111111-1111-1111-1111-111111111111',
      appName: 'TikTok',
      appPackage: 'com.tiktok',
    });

    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe('11111111-1111-1111-1111-111111111111');
  });

  it('ignores a childId supplied by the caller', async () => {
    const other = await createChild(parent.id, { name: 'Other' });
    const res = await addRule({ childId: other.id, appName: 'TikTok', appPackage: 'com.tiktok' });

    expect(res.status).toBe(201);
    expect(res.body.childId).toBe(child.id);
  });
});

describe('the apps a parent can choose from are the ones the phone reported', () => {
  it('lists them most-used first, with their package names', async () => {
    const device = await createDevice(child.id);
    await ActivityLog.create({
      childId: child.id, deviceId: device.id, category: 'app_usage',
      appName: 'YouTube', appPackage: 'com.google.android.youtube', durationMinutes: 30, startTime: new Date(),
    });
    await ActivityLog.create({
      childId: child.id, deviceId: device.id, category: 'app_usage',
      appName: 'Roblox', appPackage: 'com.roblox.client', durationMinutes: 90, startTime: new Date(),
    });

    const res = await request(app)
      .get(`/api/blocking/${child.id}/apps/known`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.map((a) => a.appPackage)).toEqual(['com.roblox.client', 'com.google.android.youtube']);
    expect(res.body[0]).toMatchObject({ appName: 'Roblox', totalMinutes: 90 });
  });

  it('sums the samples for one app rather than listing it twice', async () => {
    const device = await createDevice(child.id);
    for (const durationMinutes of [10, 25]) {
      await ActivityLog.create({
        childId: child.id, deviceId: device.id, category: 'app_usage',
        appName: 'Roblox', appPackage: 'com.roblox.client', durationMinutes, startTime: new Date(),
      });
    }

    const res = await request(app)
      .get(`/api/blocking/${child.id}/apps/known`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].totalMinutes).toBe(35);
  });

  it('leaves out browsing history, which is not an app', async () => {
    const device = await createDevice(child.id);
    await ActivityLog.create({
      childId: child.id, deviceId: device.id, category: 'browsing', url: 'example.com', durationMinutes: 5, startTime: new Date(),
    });

    const res = await request(app)
      .get(`/api/blocking/${child.id}/apps/known`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.body).toEqual([]);
  });

  it('is not readable for another parent\'s child', async () => {
    const stranger = await createUser();
    const res = await request(app)
      .get(`/api/blocking/${child.id}/apps/known`)
      .set('Authorization', `Bearer ${tokenFor(stranger)}`);

    expect(res.status).toBe(404);
  });
});

describe('a website rule still has to say what it applies to', () => {
  // Website filtering is plan-gated, and the default account is on `free` with
  // no trial date, so without this every case here answers 403 and proves
  // nothing about the validation it is aimed at.
  beforeEach(async () => {
    await parent.update({ plan: 'premium' });
  });

  const addWebsite = (body) =>
    request(app).post(`/api/blocking/${child.id}/websites`).set('Authorization', `Bearer ${token}`).send(body);

  it('accepts a domain', async () => {
    const res = await addWebsite({ url: 'https://example.com/some/page' });
    expect(res.status).toBe(201);
    expect(res.body.url).toBe('example.com');
  });

  it('accepts a category with no domain', async () => {
    const res = await addWebsite({ category: 'adult' });
    expect(res.status).toBe(201);
    expect(res.body.category).toBe('adult');
  });

  it('refuses a rule that names neither', async () => {
    // `category: 'custom'` is what the form sends when the domain box is empty,
    // and it produced a row matching nothing at all.
    const res = await addWebsite({ category: 'custom' });
    expect(res.status).toBe(400);
  });

  it('keeps allow, which the content policy really does apply', async () => {
    const res = await addWebsite({ url: 'khanacademy.org', action: 'allow' });
    expect(res.status).toBe(201);
    expect(res.body.action).toBe('allow');
  });

  it('refuses an action that is neither', async () => {
    const res = await addWebsite({ url: 'example.com', action: 'limit' });
    expect(res.status).toBe(400);
  });
});
