const request = require('supertest');
const { app } = require('../src/app');
const { createUser, tokenFor, createChild } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;

/**
 * Registration grants a 7-day trial and the welcome email promises full access
 * during it, so the feature gate has to honour that — otherwise every premium
 * screen a new parent opens returns "upgrade required" on day one.
 */
describe('trial entitlements', () => {
  it('lets a free account inside its trial use a premium feature', async () => {
    const parent = await createUser({ plan: 'free', trialEndsAt: new Date(Date.now() + 3 * DAY) });
    const child = await createChild(parent.id);

    const res = await request(app)
      .get(`/api/locations/${child.id}/current`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`);

    expect(res.status).toBe(200);
  });

  it('blocks the same feature once the trial has expired', async () => {
    const parent = await createUser({ plan: 'free', trialEndsAt: new Date(Date.now() - DAY) });
    const child = await createChild(parent.id);

    const res = await request(app)
      .get(`/api/locations/${child.id}/current`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`);

    expect(res.status).toBe(403);
    expect(res.body.upgradeRequired).toBe(true);
  });

  it('blocks a free account that never had a trial', async () => {
    const parent = await createUser({ plan: 'free', trialEndsAt: null });
    const child = await createChild(parent.id);

    const res = await request(app)
      .get(`/api/locations/${child.id}/current`)
      .set('Authorization', `Bearer ${tokenFor(parent)}`);

    expect(res.status).toBe(403);
  });

  it('grants the whole Premium set during the trial, ai_safety included', async () => {
    // ai_safety used to belong to `family` and so was withheld from the trial.
    // Premium absorbed that tier, and the welcome email promises full access for
    // seven days — so the trial has to reach every Premium feature, not most.
    const parent = await createUser({ plan: 'free', trialEndsAt: new Date(Date.now() + 3 * DAY) });

    const res = await request(app)
      .post('/api/safety/analyze')
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({});

    expect(res.status).not.toBe(403);
  });

  it('withholds every paid feature once the trial has lapsed', async () => {
    const parent = await createUser({ plan: 'free', trialEndsAt: new Date(Date.now() - DAY) });

    const res = await request(app)
      .post('/api/safety/analyze')
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.upgradeRequired).toBe(true);
  });

  it('never downgrades a paid plan to the trial tier', async () => {
    // An expired trial marker must not strip entitlements from a paying account.
    const parent = await createUser({ plan: 'premium', trialEndsAt: new Date(Date.now() - DAY) });

    const res = await request(app)
      .post('/api/safety/analyze')
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({});

    expect(res.status).not.toBe(403);
  });
});
