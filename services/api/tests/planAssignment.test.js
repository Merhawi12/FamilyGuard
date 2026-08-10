/**
 * What the console can assign has to match what Stripe can sell, and changing a
 * plan must not quietly change whether the account is blocked.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { createUser, tokenFor } = require('./helpers');
const { ROLES } = require('../src/config/roles');
const { DEFAULT_PLAN_FEATURES, SUSPENDED_PLAN } = require('../src/config/plans');

const setPlan = (admin, client, plan) =>
  request(app).patch(`/api/admin/clients/${client.id}/plan`)
    .set('Authorization', `Bearer ${tokenFor(admin)}`)
    .send({ plan });

describe('admin plan assignment', () => {
  it.each(Object.keys(DEFAULT_PLAN_FEATURES))('accepts the %s plan', async (plan) => {
    const admin = await createUser({ role: ROLES.SUPER_ADMIN });
    const client = await createUser();

    const res = await setPlan(admin, client, plan);

    expect(res.status).toBe(200);
    expect(res.body.plan).toBe(plan);
  });

  it('rejects a plan that is not in the catalogue', async () => {
    const admin = await createUser({ role: ROLES.SUPER_ADMIN });
    const client = await createUser();

    await expect(setPlan(admin, client, 'platinum').then((r) => r.status)).resolves.toBe(400);
  });

  it('switches the account off when it is suspended', async () => {
    const admin = await createUser({ role: ROLES.SUPER_ADMIN });
    const client = await createUser();

    const res = await setPlan(admin, client, SUSPENDED_PLAN);

    expect(res.body.isActive).toBe(false);
  });

  it.each(Object.keys(DEFAULT_PLAN_FEATURES))('lifting a suspension onto %s reactivates the account', async (plan) => {
    const admin = await createUser({ role: ROLES.SUPER_ADMIN });
    const client = await createUser({ plan: SUSPENDED_PLAN, isActive: false });

    const res = await setPlan(admin, client, plan);

    expect(res.body.isActive).toBe(true);
  });

  it('does not undo a block when an unrelated plan change is made', async () => {
    const admin = await createUser({ role: ROLES.SUPER_ADMIN });
    // Blocked through toggle-block, not through suspension.
    const client = await createUser({ plan: 'free', isActive: false });

    const res = await setPlan(admin, client, 'premium');

    expect(res.body.isActive).toBe(false);
  });
});
