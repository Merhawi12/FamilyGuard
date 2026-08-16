/**
 * A screen-time rule the device cannot act on must not be accepted.
 *
 * The phone reads a bedtime with `/^(\d{1,2}):(\d{2})$/` and treats anything
 * else as "no window at all" — so "9pm" was stored, listed back to the parent as
 * their bedtime, shown on the child's own screen as their bedtime, and enforced
 * by nothing. That is the exact shape of failure this codebase refuses
 * everywhere else: a control that reports a promise the platform cannot keep.
 *
 * The web form only ever emits `<input type="time">` output, so none of this
 * fires for it. The API is a surface in its own right.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { createUser, tokenFor, createChild } = require('./helpers');

const save = (parent, childId, body) =>
  request(app)
    .put(`/api/screen-time/${childId}`)
    .set('Authorization', `Bearer ${tokenFor(parent)}`)
    .send(body);

let parent;
let child;

beforeEach(async () => {
  parent = await createUser();
  child = await createChild(parent.id);
});

describe('screen-time rules the device can enforce', () => {
  it('accepts a well-formed rule', async () => {
    const res = await save(parent, child.id, {
      dailyLimitMinutes: 120,
      bedtimeEnabled: true,
      bedtimeStart: '21:00',
      bedtimeEnd: '07:00',
      schedule: { monday: { enabled: true, start: '08:00', end: '20:00' } },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dailyLimitMinutes: 120, bedtimeStart: '21:00' });
  });

  it('refuses a bedtime it cannot parse rather than storing one that does nothing', async () => {
    const res = await save(parent, child.id, { bedtimeEnabled: true, bedtimeStart: '9pm' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/24-hour time/);
  });

  it('refuses a bedtime hour that is not on the clock', async () => {
    expect((await save(parent, child.id, { bedtimeEnd: '25:00' })).status).toBe(400);
    expect((await save(parent, child.id, { bedtimeEnd: '07:60' })).status).toBe(400);
  });

  it('refuses a daily limit that could never be met', async () => {
    // A negative limit satisfies `todayMinutes >= limit` on the very first
    // sample, so the phone locks itself and can never be unlocked by using less.
    expect((await save(parent, child.id, { dailyLimitMinutes: -30 })).status).toBe(400);
    expect((await save(parent, child.id, { dailyLimitMinutes: 5000 })).status).toBe(400);
    expect((await save(parent, child.id, { dailyLimitMinutes: '120' })).status).toBe(400);
  });

  it('still allows 0, which is how "no daily limit" is expressed', async () => {
    const res = await save(parent, child.id, { dailyLimitMinutes: 0 });
    expect(res.status).toBe(200);
    expect(res.body.dailyLimitMinutes).toBe(0);
  });

  it('refuses an allowed-hours window whose times are unusable', async () => {
    const res = await save(parent, child.id, {
      schedule: { tuesday: { enabled: true, start: 'morning', end: '20:00' } },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/schedule\.tuesday\.start/);
  });

  it('ignores the times on a day that is switched off', async () => {
    // An off day carries no restriction, and the form leaves its inputs at
    // whatever they last held — refusing it would block saving the other six.
    const res = await save(parent, child.id, {
      schedule: { wednesday: { enabled: false, start: '', end: '' } },
    });
    expect(res.status).toBe(200);
  });

  it('refuses a day name nothing on the device will ever look up', async () => {
    const res = await save(parent, child.id, {
      schedule: { caturday: { enabled: true, start: '08:00', end: '20:00' } },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown day/);
  });

  it('leaves the stored rule untouched when it refuses one', async () => {
    await save(parent, child.id, { bedtimeEnabled: true, bedtimeStart: '21:00', bedtimeEnd: '07:00' });
    await save(parent, child.id, { bedtimeStart: 'nonsense' });

    const res = await request(app)
      .get(`/api/screen-time/${child.id}`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`);

    expect(res.body.bedtimeStart).toBe('21:00');
  });
});
