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

  it('does not grant a trial-only feature that the trial tier lacks', async () => {
    // ai_safety belongs to `family`, not to the `premium` trial tier.
    const parent = await createUser({ plan: 'free', trialEndsAt: new Date(Date.now() + 3 * DAY) });

    const res = await request(app)
      .post('/api/safety/analyze')
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({});

    expect(res.status).toBe(403);
  });

  it('never downgrades a paid plan to the trial tier', async () => {
    // An expired trial marker must not strip entitlements from a paying account.
    const parent = await createUser({ plan: 'family', trialEndsAt: new Date(Date.now() - DAY) });

    const res = await request(app)
      .post('/api/safety/analyze')
      .set('Authorization', `Bearer ${tokenFor(parent)}`)
      .send({});

    expect(res.status).not.toBe(403);
  });
});
