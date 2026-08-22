const request = require('supertest');
const { app } = require('../src/app');
const {
  Device, AppRule, WebsiteRule, ScreenTimeRule,
} = require('../src/models');
const {
  createUser, tokenFor, createChild, createDevice, deviceToken,
} = require('./helpers');
const { rulesVisibleTo } = require('../src/utils/deviceScope');

/**
 * One child, two devices — the case every assertion here is about.
 *
 * A family with a phone and a laptop on one child had a single lever for both:
 * rules were keyed on the child alone and the only per-device action was
 * removal. Everything below exists to pin the line between "this device" and
 * "this child", because getting it wrong is silent in both directions — a rule
 * meant for the laptop quietly reaching the phone, or an exception the dashboard
 * shows as set that the device never receives.
 */
const family = async () => {
  // Premium because website filtering is plan-gated and two devices exceed the
  // Free allowance. The gate is not what these tests are about.
  const parent = await createUser({ plan: 'premium' });
  const child = await createChild(parent.id);
  const phone = await createDevice(child.id, { name: 'Phone', type: 'android' });
  const laptop = await createDevice(child.id, { name: 'Laptop', type: 'windows' });
  return {
    parent,
    child,
    phone,
    laptop,
    auth: `Bearer ${tokenFor(parent)}`,
    phoneAuth: `Bearer ${deviceToken(phone)}`,
    laptopAuth: `Bearer ${deviceToken(laptop)}`,
  };
};

const syncFor = (auth) => request(app).get('/api/devices/me/rules').set('Authorization', auth);

describe('Blocking one device', () => {
  it('pauses only the device named, and leaves its sibling alone', async () => {
    const f = await family();

    const res = await request(app)
      .post(`/api/devices/${f.phone.id}/block`).set('Authorization', f.auth);
    expect(res.status).toBe(200);

    await f.phone.reload();
    await f.laptop.reload();
    expect(f.phone.blockedAt).toBeTruthy();
    expect(f.laptop.blockedAt).toBeNull();
  });

  /*
   * The design decision worth protecting: a block is not a revocation. If the
   * token stopped working the phone would go dark while still enforcing its
   * last-known rules, so the parent would read "paused" on a device they had
   * actually just lost sight of — and the unblock would have no way to reach it.
   */
  it('leaves the blocked device authenticated and still reporting', async () => {
    const f = await family();
    await request(app).post(`/api/devices/${f.phone.id}/block`).set('Authorization', f.auth);

    const sync = await syncFor(f.phoneAuth);
    expect(sync.status).toBe(200);

    const beat = await request(app)
      .post('/api/devices/me/heartbeat')
      .set('Authorization', f.phoneAuth)
      .send({ batteryLevel: 42 });
    expect(beat.status).toBe(200);
  });

  it('tells the device it is blocked, and why', async () => {
    const f = await family();
    await request(app).post(`/api/devices/${f.phone.id}/block`).set('Authorization', f.auth);

    const phone = await syncFor(f.phoneAuth);
    expect(phone.body.blocked).toMatchObject({ reason: 'blocked_by_parent' });
    expect(phone.body.blocked.since).toBeTruthy();

    const laptop = await syncFor(f.laptopAuth);
    expect(laptop.body.blocked).toBeNull();
  });

  it('unblocks, and the device is told on its next sync', async () => {
    const f = await family();
    await request(app).post(`/api/devices/${f.phone.id}/block`).set('Authorization', f.auth);
    await request(app).post(`/api/devices/${f.phone.id}/unblock`).set('Authorization', f.auth);

    await f.phone.reload();
    expect(f.phone.blockedAt).toBeNull();
    expect((await syncFor(f.phoneAuth)).body.blocked).toBeNull();
  });

  // The button sits on a list that may be seconds stale, and a parent who taps
  // Block twice means it once.
  it('is idempotent', async () => {
    const f = await family();
    const first = await request(app).post(`/api/devices/${f.phone.id}/block`).set('Authorization', f.auth);
    await f.phone.reload();
    const at = f.phone.blockedAt;

    const second = await request(app).post(`/api/devices/${f.phone.id}/block`).set('Authorization', f.auth);
    await f.phone.reload();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(f.phone.blockedAt.toISOString()).toBe(at.toISOString());
  });

  /*
   * Removed is not paused. Un-pausing a removed device would imply the removal
   * could be undone; it cannot — the child app has already forgotten its
   * credentials and needs a fresh code.
   */
  it('refuses to pause a device that was removed', async () => {
    const f = await family();
    await request(app).delete(`/api/devices/${f.phone.id}`).set('Authorization', f.auth);

    // A removed row is already invisible to every owned-device lookup, so this
    // is the same 404 a made-up id gets — which is the honest answer: as far as
    // the account is concerned that device is gone.
    const res = await request(app)
      .post(`/api/devices/${f.phone.id}/block`).set('Authorization', f.auth);
    expect(res.status).toBe(404);

    await f.phone.reload();
    expect(f.phone.blockedAt).toBeNull();
  });

  it('clears the pause when a device is removed, so a re-link does not inherit it', async () => {
    const f = await family();
    await request(app).post(`/api/devices/${f.phone.id}/block`).set('Authorization', f.auth);
    await request(app).delete(`/api/devices/${f.phone.id}`).set('Authorization', f.auth);

    await f.phone.reload();
    expect(f.phone.blockedAt).toBeNull();
  });

  it('will not let one parent pause another family device', async () => {
    const f = await family();
    const stranger = await createUser();

    const res = await request(app)
      .post(`/api/devices/${f.phone.id}/block`)
      .set('Authorization', `Bearer ${tokenFor(stranger)}`);
    expect(res.status).toBe(403);

    await f.phone.reload();
    expect(f.phone.blockedAt).toBeNull();
  });
});

describe('Rules narrowed to one device', () => {
  it('sends a device rule only to that device', async () => {
    const f = await family();

    const res = await request(app)
      .post(`/api/blocking/${f.child.id}/apps`)
      .set('Authorization', f.auth)
      .send({ appName: 'Roblox', appPackage: 'com.roblox.client', deviceId: f.laptop.id });
    expect(res.status).toBe(201);
    expect(res.body.deviceId).toBe(f.laptop.id);

    const laptop = await syncFor(f.laptopAuth);
    const phone = await syncFor(f.phoneAuth);
    expect(laptop.body.appRules.map((r) => r.appPackage)).toContain('com.roblox.client');
    expect(phone.body.appRules.map((r) => r.appPackage)).not.toContain('com.roblox.client');
  });

  it('still sends a child-wide rule to every device, which is what a rule was before', async () => {
    const f = await family();
    await request(app)
      .post(`/api/blocking/${f.child.id}/apps`)
      .set('Authorization', f.auth)
      .send({ appName: 'TikTok', appPackage: 'com.zhiliaoapp.musically' });

    for (const auth of [f.phoneAuth, f.laptopAuth]) {
      const sync = await syncFor(auth);
      expect(sync.body.appRules.map((r) => r.appPackage)).toContain('com.zhiliaoapp.musically');
    }
  });

  /*
   * Override, not union — the whole reason the column exists. A union would keep
   * the child-wide block in force on the laptop and the exception would do
   * nothing, which is exactly the shape of failure that is invisible from the
   * dashboard.
   */
  it('lets a device rule override the child-wide rule for that device only', async () => {
    const f = await family();
    const pkg = 'com.roblox.client';

    await request(app).post(`/api/blocking/${f.child.id}/apps`).set('Authorization', f.auth)
      .send({ appName: 'Roblox', appPackage: pkg, action: 'block' });
    await request(app).post(`/api/blocking/${f.child.id}/apps`).set('Authorization', f.auth)
      .send({
        appName: 'Roblox', appPackage: pkg, action: 'limit', dailyLimitMinutes: 60, deviceId: f.laptop.id,
      });

    const laptop = await syncFor(f.laptopAuth);
    const phone = await syncFor(f.phoneAuth);

    const onLaptop = laptop.body.appRules.filter((r) => r.appPackage === pkg);
    const onPhone = phone.body.appRules.filter((r) => r.appPackage === pkg);

    // One rule each, not two: the device row replaces the child-wide row rather
    // than sitting beside it.
    expect(onLaptop).toHaveLength(1);
    expect(onLaptop[0].action).toBe('limit');
    expect(onLaptop[0].dailyLimitMinutes).toBe(60);
    expect(onPhone).toHaveLength(1);
    expect(onPhone[0].action).toBe('block');
  });

  it('overrides a website rule on the same domain, rather than shipping both', async () => {
    const f = await family();

    await request(app).post(`/api/blocking/${f.child.id}/websites`).set('Authorization', f.auth)
      .send({ url: 'youtube.com', action: 'block' });
    await request(app).post(`/api/blocking/${f.child.id}/websites`).set('Authorization', f.auth)
      .send({ url: 'youtube.com', action: 'allow', deviceId: f.laptop.id });

    const laptop = await syncFor(f.laptopAuth);
    const phone = await syncFor(f.phoneAuth);

    /*
     * `deviceWebsiteRules` hands the device the parent's own rows plus the
     * domains a category expands to, and an `allow` row travels with the rest —
     * it is how an exception is expressed to the resolver. So the assertion is
     * on the action each device is given for the domain, not on whether the
     * domain appears: it appears either way, and asserting on its presence
     * would pass while the laptop was still being told to block it.
     */
    const ruleFor = (body) => body.websiteRules.filter((r) => r.url === 'youtube.com');

    expect(ruleFor(phone.body)).toHaveLength(1);
    expect(ruleFor(phone.body)[0].action).toBe('block');

    // One row, not two — the device row replaced the child-wide one rather than
    // arriving beside it, where which won would depend on array order.
    expect(ruleFor(laptop.body)).toHaveLength(1);
    expect(ruleFor(laptop.body)[0].action).toBe('allow');
  });

  it('refuses a rule scoped to a device that is not this child\'s', async () => {
    const f = await family();
    const other = await createUser({ plan: 'premium' });
    const otherChild = await createChild(other.id);
    const otherDevice = await createDevice(otherChild.id);

    const res = await request(app)
      .post(`/api/blocking/${f.child.id}/apps`)
      .set('Authorization', f.auth)
      .send({ appName: 'X', appPackage: 'com.x', deviceId: otherDevice.id });
    expect(res.status).toBe(400);
    expect(await AppRule.count({ where: { deviceId: otherDevice.id } })).toBe(0);
  });
});

describe('Screen time per device', () => {
  /*
   * Reading a device's scope must not create an exception for it. The Screen
   * Time page reads every device at once to mark which tabs carry an override —
   * if that created rows, opening the page would override every device and the
   * child-wide limit would stop reaching any of them.
   */
  it('reading a device scope shows the shared rule and creates nothing', async () => {
    const f = await family();

    await request(app).put(`/api/screen-time/${f.child.id}`).set('Authorization', f.auth)
      .send({ dailyLimitMinutes: 45 });

    const res = await request(app)
      .get(`/api/screen-time/${f.child.id}`).query({ deviceId: f.laptop.id })
      .set('Authorization', f.auth);

    expect(res.status).toBe(200);
    expect(res.body.dailyLimitMinutes).toBe(45);
    // null is how the caller tells "shared rule" from "this device's exception".
    expect(res.body.deviceId).toBeNull();
    expect(await ScreenTimeRule.count({ where: { deviceId: f.laptop.id } })).toBe(0);
  });

  it('starts a device rule as a copy of the child rule, not as the defaults', async () => {
    const f = await family();

    await request(app).put(`/api/screen-time/${f.child.id}`).set('Authorization', f.auth)
      .send({ dailyLimitMinutes: 45, bedtimeEnabled: true, bedtimeStart: '20:30', bedtimeEnd: '06:30' });

    // Written, not read: the exception comes into existence on the first save.
    await request(app).put(`/api/screen-time/${f.child.id}`).query({ deviceId: f.laptop.id })
      .set('Authorization', f.auth)
      .send({ dailyLimitMinutes: 180 });

    const res = await request(app)
      .get(`/api/screen-time/${f.child.id}`).query({ deviceId: f.laptop.id })
      .set('Authorization', f.auth);

    expect(res.body.deviceId).toBe(f.laptop.id);
    expect(res.body.dailyLimitMinutes).toBe(180);
    // The model default bedtime is 21:00. Inheriting the model defaults instead
    // of the child's rule would silently change a bedtime the parent never
    // touched on this screen.
    expect(res.body.bedtimeStart).toBe('20:30');
    expect(res.body.bedtimeEnabled).toBe(true);
  });

  it('gives each device the limit that applies to it', async () => {
    const f = await family();

    await request(app).put(`/api/screen-time/${f.child.id}`).set('Authorization', f.auth)
      .send({ dailyLimitMinutes: 60 });
    await request(app).put(`/api/screen-time/${f.child.id}`).query({ deviceId: f.laptop.id })
      .set('Authorization', f.auth)
      .send({ dailyLimitMinutes: 180 });

    expect((await syncFor(f.phoneAuth)).body.screenTimeRule.dailyLimitMinutes).toBe(60);
    expect((await syncFor(f.laptopAuth)).body.screenTimeRule.dailyLimitMinutes).toBe(180);
  });

  it('drops the exception and returns the device to the child rule', async () => {
    const f = await family();

    await request(app).put(`/api/screen-time/${f.child.id}`).set('Authorization', f.auth)
      .send({ dailyLimitMinutes: 60 });
    await request(app).put(`/api/screen-time/${f.child.id}`).query({ deviceId: f.laptop.id })
      .set('Authorization', f.auth)
      .send({ dailyLimitMinutes: 180 });

    const res = await request(app)
      .delete(`/api/screen-time/${f.child.id}`).query({ deviceId: f.laptop.id })
      .set('Authorization', f.auth);
    expect(res.status).toBe(200);

    expect((await syncFor(f.laptopAuth)).body.screenTimeRule.dailyLimitMinutes).toBe(60);
    expect(await ScreenTimeRule.count({ where: { deviceId: f.laptop.id } })).toBe(0);
  });

  it('will not let a body field move a rule onto a sibling', async () => {
    const f = await family();

    await request(app).put(`/api/screen-time/${f.child.id}`).query({ deviceId: f.laptop.id })
      .set('Authorization', f.auth)
      .send({ dailyLimitMinutes: 180, deviceId: f.phone.id, childId: 'nope' });

    // The query string named the laptop; the body must not be able to redirect it.
    expect(await ScreenTimeRule.count({ where: { deviceId: f.phone.id } })).toBe(0);
    expect(await ScreenTimeRule.count({ where: { deviceId: f.laptop.id } })).toBe(1);
  });
});

describe('Removing a device', () => {
  it('takes its own rules with it and leaves the child rules standing', async () => {
    const f = await family();

    await request(app).post(`/api/blocking/${f.child.id}/apps`).set('Authorization', f.auth)
      .send({ appName: 'Steam', appPackage: 'com.valve.steam', deviceId: f.laptop.id });
    await request(app).post(`/api/blocking/${f.child.id}/apps`).set('Authorization', f.auth)
      .send({ appName: 'TikTok', appPackage: 'com.zhiliaoapp.musically' });
    await request(app).put(`/api/screen-time/${f.child.id}`).query({ deviceId: f.laptop.id })
      .set('Authorization', f.auth).send({ dailyLimitMinutes: 180 });

    await request(app).delete(`/api/devices/${f.laptop.id}`).set('Authorization', f.auth);

    expect(await AppRule.count({ where: { deviceId: f.laptop.id } })).toBe(0);
    expect(await ScreenTimeRule.count({ where: { deviceId: f.laptop.id } })).toBe(0);
    // The child-wide rule belongs to the child, not to any device.
    expect(await AppRule.count({ where: { childId: f.child.id, deviceId: null } })).toBe(1);

    // And the sibling is untouched.
    const phone = await syncFor(f.phoneAuth);
    expect(phone.body.appRules.map((r) => r.appPackage)).toContain('com.zhiliaoapp.musically');
  });
});

describe('rulesVisibleTo', () => {
  /*
   * `deviceId: undefined` is dropped by Sequelize, which would silently turn a
   * device-scoped read into a read of every rule the family owns — including a
   * sibling's. Refusing to build the clause is the only safe answer.
   */
  it('refuses to build a clause without a device', () => {
    expect(() => rulesVisibleTo('child-id', undefined)).toThrow(/deviceId/);
    expect(() => rulesVisibleTo('child-id', null)).toThrow(/deviceId/);
  });
});

describe('The sync a device already makes', () => {
  it('carries the block, so a device that missed the event still comes back locked', async () => {
    const f = await family();
    // No socket in this test at all — the block is applied and the device is
    // told by the poll, which is the path that has to work when the event is
    // missed or the phone was switched off.
    await Device.update({ blockedAt: new Date() }, { where: { id: f.phone.id } });

    const sync = await syncFor(f.phoneAuth);
    expect(sync.body.blocked).toMatchObject({ reason: 'blocked_by_parent' });
  });

  it('never mentions a sibling device rule', async () => {
    const f = await family();
    await request(app).post(`/api/blocking/${f.child.id}/websites`).set('Authorization', f.auth)
      .send({ url: 'minecraft.net', deviceId: f.laptop.id });

    const phone = await syncFor(f.phoneAuth);
    expect(JSON.stringify(phone.body)).not.toContain('minecraft.net');
    expect(await WebsiteRule.count({ where: { deviceId: f.laptop.id } })).toBe(1);
  });
});
