const request = require('supertest');
const { app } = require('../src/app');
const { User } = require('../src/models');
const { createUser, tokenFor, createChild } = require('./helpers');
const { effectivePlan } = require('../src/middleware/featureGate');

/**
 * A subscription that has stopped paying stops entitling.
 *
 * `subscriptionStatus` was written by five Stripe webhook handlers and read by
 * nothing. Entitlements came from `user.plan` alone, and the only handler that
 * ever lowers `plan` is `customer.subscription.deleted` — so an account whose
 * payments had failed kept full Premium indefinitely whenever Stripe did not
 * delete the subscription. That is not an edge case: it is what Stripe does when
 * an account's dunning setting is "mark unpaid" or "pause" instead of "cancel".
 * The status was recorded, displayed nowhere, and enforced nowhere.
 *
 * Two things are load-bearing besides the rule itself, and both are asserted
 * here because getting either wrong is silent:
 *
 *   - `past_due` still entitles. Stripe is still retrying the card and most of
 *     those recover; cutting a family off from safety alerts over a card that
 *     expired yesterday is the worse failure. It is a policy, not an oversight.
 *   - `user.plan` is never rewritten. Only the entitlement falls back, so the
 *     plan screen still says Premium and billing can still be repaired.
 */

const premium = (overrides) => ({
  plan: 'premium',
  stripeSubscriptionId: 'sub_123',
  subscriptionStatus: 'active',
  ...overrides,
});

describe('effectivePlan and a subscription that stopped paying', () => {
  it('entitles an active subscriber', () => {
    expect(effectivePlan(premium())).toBe('premium');
  });

  it.each(['unpaid', 'incomplete_expired', 'paused'])(
    'withholds entitlements when Stripe has given up (%s)',
    (subscriptionStatus) => {
      expect(effectivePlan(premium({ subscriptionStatus }))).toBe('free');
    }
  );

  it('keeps entitlements while Stripe is still retrying the card (past_due)', () => {
    expect(effectivePlan(premium({ subscriptionStatus: 'past_due' }))).toBe('premium');
  });

  /**
   * The reason the rule is gated on there being a subscription at all.
   *
   * An account put on a plan by hand from the console has no
   * `stripeSubscriptionId`, and a status left over from something else must not
   * quietly cancel a grant staff have just made.
   */
  it('ignores a stale status on an account with no Stripe subscription', () => {
    expect(effectivePlan({
      plan: 'premium', stripeSubscriptionId: null, subscriptionStatus: 'unpaid',
    })).toBe('premium');
  });

  it('leaves the free tier and its trial exactly as they were', () => {
    const future = new Date(Date.now() + 86400000);
    expect(effectivePlan({ plan: 'free', trialEndsAt: future })).toBe('premium');
    expect(effectivePlan({ plan: 'free', trialEndsAt: new Date(Date.now() - 1000) })).toBe('free');
    expect(effectivePlan({ plan: 'free' })).toBe('free');
  });

  it('leaves a suspended account suspended rather than promoting it', () => {
    expect(effectivePlan({ plan: 'suspended', subscriptionStatus: 'active' })).toBe('suspended');
  });
});

describe('The gate a customer actually meets', () => {
  /** Safe zones are Premium-only, so this is the entitlement in practice. */
  const listZones = (token) => request(app).get('/api/safe-zones').set('Authorization', `Bearer ${token}`);

  it('lets an active subscriber through', async () => {
    const parent = await createUser(premium({ trialEndsAt: new Date(Date.now() - 1000) }));
    const res = await listZones(tokenFor(parent));
    expect(res.status).toBe(200);
  });

  it('turns an unpaid subscriber away, and says an upgrade is what is needed', async () => {
    const parent = await createUser(premium({
      subscriptionStatus: 'unpaid',
      // Past, so the trial is not what is answering here.
      trialEndsAt: new Date(Date.now() - 1000),
    }));

    const res = await listZones(tokenFor(parent));
    expect(res.status).toBe(403);
    expect(res.body.upgradeRequired).toBe(true);

    // And the account is still on Premium as far as the record and the plan
    // screen are concerned — this withholds features, it does not downgrade.
    await parent.reload();
    expect(parent.plan).toBe('premium');
  });

  it('still serves a past_due subscriber', async () => {
    const parent = await createUser(premium({
      subscriptionStatus: 'past_due',
      trialEndsAt: new Date(Date.now() - 1000),
    }));
    expect((await listZones(tokenFor(parent))).status).toBe(200);
  });
});

describe('A plan set by hand from the console', () => {
  /**
   * Without this, staff moving a lapsed customer back onto Premium would save
   * the plan, log the change, show it in the directory — and grant nothing,
   * because the dangling `unpaid` status would go on answering for a Stripe
   * arrangement that no longer exists.
   */
  it('clears a status that would otherwise cancel the grant', async () => {
    const staff = await createUser({ role: 'super_admin' });
    const client = await createUser(premium({ plan: 'free', subscriptionStatus: 'unpaid' }));

    const res = await request(app)
      .patch(`/api/admin/clients/${client.id}/plan`)
      .set('Authorization', `Bearer ${tokenFor(staff)}`)
      .send({ plan: 'premium' });

    expect(res.status).toBe(200);
    await client.reload();
    expect(client.plan).toBe('premium');
    expect(client.subscriptionStatus).toBe('manual');
    expect(effectivePlan(client)).toBe('premium');
  });

  it('leaves a healthy subscription status alone', async () => {
    const staff = await createUser({ role: 'super_admin' });
    const client = await createUser(premium({ subscriptionStatus: 'active' }));

    await request(app)
      .patch(`/api/admin/clients/${client.id}/plan`)
      .set('Authorization', `Bearer ${tokenFor(staff)}`)
      .send({ plan: 'free' });

    await client.reload();
    expect(client.subscriptionStatus).toBe('active');
  });

  it('does not resurrect entitlements while suspending an account', async () => {
    const staff = await createUser({ role: 'super_admin' });
    const client = await createUser(premium({ subscriptionStatus: 'unpaid' }));

    await request(app)
      .patch(`/api/admin/clients/${client.id}/plan`)
      .set('Authorization', `Bearer ${tokenFor(staff)}`)
      .send({ plan: 'suspended' });

    await client.reload();
    expect(client.plan).toBe('suspended');
    expect(client.subscriptionStatus).toBe('unpaid');
    expect(client.isActive).toBe(false);
  });
});

describe('The device allowance follows the same rule', () => {
  it('drops an unpaid Premium account back to the free allowance', async () => {
    const parent = await createUser(premium({
      subscriptionStatus: 'unpaid',
      trialEndsAt: new Date(Date.now() - 1000),
    }));
    const child = await createChild(parent.id);

    // Free allows one device; the second is the one that must be refused.
    const auth = `Bearer ${tokenFor(parent)}`;
    const first = await request(app).post('/api/devices/link').set('Authorization', auth)
      .send({ childId: child.id, deviceName: 'Phone', type: 'android' });
    expect(first.status).toBe(200);

    const second = await request(app).post('/api/devices/link').set('Authorization', auth)
      .send({ childId: child.id, deviceName: 'Tablet', type: 'android' });
    expect(second.status).toBe(403);
    expect(second.body.upgradeRequired || second.body.error).toBeTruthy();

    // The account itself is untouched — only what it may do changed.
    const after = await User.findByPk(parent.id);
    expect(after.plan).toBe('premium');
  });
});
