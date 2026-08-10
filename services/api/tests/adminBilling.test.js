const request = require('supertest');
const { app } = require('../src/app');
const { Transaction } = require('../src/models');
const { createUser, tokenFor } = require('./helpers');

const bearer = (u) => ({ Authorization: `Bearer ${tokenFor(u)}` });

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS);

const list = (admin, query = '') => request(app)
  .get(`/api/admin/transactions${query}`)
  .set(bearer(admin))
  .then((r) => r.body);

const summaryFor = (admin) => list(admin).then((b) => b.summary);

let seq = 0;
/**
 * A transaction as the Stripe webhook would have written it.
 *
 * `createdAt` is Sequelize's column, so it ignores a value passed to `create`
 * unless the write is `silent` — without that every seeded payment lands today
 * and each window in the summary sees exactly the same thing.
 */
const payment = (userId, overrides = {}) => Transaction.create(
  {
    userId,
    stripeEventId: `evt_test_${seq++}`,
    type: 'invoice_paid',
    amount: 999,
    currency: 'usd',
    plan: 'premium',
    status: 'succeeded',
    ...overrides,
  },
  { silent: true },
);

/**
 * The schema is built once per file and the rows accumulate across the tests in
 * it, so a platform-wide summary is asserted as a delta against a snapshot taken
 * first — the same way the directory's tiles are tested.
 */

describe('GET /admin/transactions — access', () => {
  it('401 without a token, 403 for a parent, 403 for staff without manage_billing', async () => {
    expect((await request(app).get('/api/admin/transactions')).status).toBe(401);

    const parent = await createUser({ role: 'parent' });
    expect((await request(app).get('/api/admin/transactions').set(bearer(parent))).status).toBe(403);

    const support = await createUser({ role: 'support', permissions: ['manage_users'] });
    expect((await request(app).get('/api/admin/transactions').set(bearer(support))).status).toBe(403);
  });

  it('200 for finance and for a super admin', async () => {
    const finance = await createUser({ role: 'finance', permissions: ['manage_billing'] });
    const admin = await createUser({ role: 'super_admin' });
    expect((await request(app).get('/api/admin/transactions').set(bearer(finance))).status).toBe(200);
    expect((await request(app).get('/api/admin/transactions').set(bearer(admin))).status).toBe(200);
  });
});

// Nothing above this point sells anything: the accounts created so far are free
// or staff. This is the screen a platform sees on its first day.
describe('GET /admin/transactions — a platform with no subscriptions', () => {
  it('answers zeroes for the totals and null for the rates it cannot derive', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const summary = await summaryFor(admin);

    expect(summary.subscribers).toBe(0);
    expect(summary.mrr).toBe(0);
    expect(summary.arpu).toBe(0);
    expect(summary.billed).toEqual({ month: 0, previousMonth: 0 });
    // A rate with no base is unknown, not zero — a churn of 0% would read as
    // "nobody is leaving" on a platform where nobody could.
    expect(summary.churn.rate).toBeNull();
    expect(summary.mrrChange).toBeNull();
    expect(summary.subscriberChange).toBeNull();
    expect(summary.currency).toBe('usd');
  });
});

describe('GET /admin/transactions — the payment log', () => {
  it('carries the customer behind each payment and searches by their name or email', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const payer = await createUser({ role: 'parent', name: 'Nadia Okonkwo', plan: 'premium' });
    await payment(payer.id);
    await payment(payer.id, { type: 'invoice_failed', status: 'failed' });

    const all = await list(admin);
    expect(all.rows.find((t) => t.user?.name === 'Nadia Okonkwo')).toBeTruthy();

    // The search reaches a payment through the account that made it, which only
    // resolves against a real join — the reason the query runs without subQuery.
    const byName = await list(admin, '?search=nadia');
    expect(byName.count).toBe(2);
    expect(byName.rows.every((t) => t.user.name === 'Nadia Okonkwo')).toBe(true);

    const byEmail = await list(admin, `?search=${payer.email}`);
    expect(byEmail.count).toBe(2);

    // Search and filter narrow together rather than one replacing the other.
    const failed = await list(admin, '?search=nadia&status=failed');
    expect(failed.count).toBe(1);
    expect(failed.rows[0].status).toBe('failed');
  });
});

describe('GET /admin/transactions — the summary', () => {
  it('reports the run rate from the plan each customer is on, not from what was billed', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const before = await summaryFor(admin);

    await createUser({ role: 'parent', plan: 'premium' });
    await createUser({ role: 'parent', plan: 'premium' });
    await createUser({ role: 'parent', plan: 'free' });

    const summary = await summaryFor(admin);
    expect(summary.subscribers - before.subscribers).toBe(2);
    expect(summary.mrr - before.mrr).toBe(2 * 999);
    expect(summary.customers - before.customers).toBe(3);
    expect(summary.arpu).toBe(Math.round(summary.mrr / summary.subscribers));

    const premium = summary.plans.find((p) => p.key === 'premium');
    expect(premium.paid).toBe(true);
    expect(premium.amount).toBe(999);
    expect(premium.mrr).toBe(premium.subscribers * 999);
    // Free is in the mix whether or not anyone is on it: a legend that drops an
    // empty tier reads as a broken chart rather than as an unsold one.
    expect(summary.plans.map((p) => p.key)).toEqual(['free', 'premium']);
    expect(summary.plans.reduce((sum, p) => sum + p.subscribers, 0)).toBe(summary.customers);
  });

  it('counts staff out of every billing number', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const before = await summaryFor(admin);

    await createUser({ role: 'finance', permissions: ['manage_billing'], plan: 'premium' });
    await createUser({ role: 'parent', plan: 'premium' });

    const summary = await summaryFor(admin);
    // Two premium accounts added; the finance colleague is not a customer.
    expect(summary.customers - before.customers).toBe(1);
    expect(summary.subscribers - before.subscribers).toBe(1);
    expect(summary.mrr - before.mrr).toBe(999);
  });

  it('bills only what landed, and splits the last 30 days from the 30 before', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const payer = await createUser({ role: 'parent', plan: 'premium' });
    const before = await summaryFor(admin);

    await payment(payer.id, { createdAt: daysAgo(2) });
    await payment(payer.id, { createdAt: daysAgo(10) });
    await payment(payer.id, { createdAt: daysAgo(45) });
    // Neither of these is money: one failed, the other is a status change.
    await payment(payer.id, { createdAt: daysAgo(3), type: 'invoice_failed', status: 'failed' });
    await payment(payer.id, { createdAt: daysAgo(3), type: 'subscription_updated', status: 'active', amount: null });

    const summary = await summaryFor(admin);
    expect(summary.billed.month - before.billed.month).toBe(2 * 999);
    expect(summary.billed.previousMonth - before.billed.previousMonth).toBe(999);
    expect(summary.failedPayments - before.failedPayments).toBe(1);
  });

  it('gives the revenue trend a continuous axis on all three ranges', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const payer = await createUser({ role: 'parent', plan: 'premium' });
    const before = await summaryFor(admin);

    await payment(payer.id, { createdAt: daysAgo(1) });
    await payment(payer.id, { createdAt: daysAgo(200) });

    const { revenue } = await summaryFor(admin);
    // Zero-filled, so a quiet week is a gap in the line rather than a period the
    // chart silently skips.
    expect(revenue.day).toHaveLength(30);
    expect(revenue.week).toHaveLength(12);
    expect(revenue.month).toHaveLength(12);

    const sum = (series) => series.reduce((total, b) => total + b.amount, 0);
    expect(sum(revenue.day) - sum(before.revenue.day)).toBe(999);
    expect(sum(revenue.week) - sum(before.revenue.week)).toBe(999);
    // Only the twelve-month range reaches back far enough to see the older one.
    expect(sum(revenue.month) - sum(before.revenue.month)).toBe(2 * 999);

    // Every bucket says where it starts, and the ranges run forward to now.
    expect(revenue.month.every((b) => !Number.isNaN(Date.parse(b.start)))).toBe(true);
    expect(Date.parse(revenue.day.at(-1).start)).toBeGreaterThan(Date.parse(revenue.day[0].start));
  });

  it('derives churn from what was cancelled against the base it was cancelled from', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const payer = await createUser({ role: 'parent', plan: 'free' });
    const before = await summaryFor(admin);

    await payment(payer.id, {
      createdAt: daysAgo(5), type: 'subscription_cancelled', status: 'cancelled', amount: null, plan: 'free',
    });

    const { churn, subscribers } = await summaryFor(admin);
    expect(churn.cancellations - before.churn.cancellations).toBe(1);

    // The base is today's subscriber count walked back through the month's wins
    // and losses; the rate is one against the other, to a tenth of a percent.
    const base = subscribers - churn.newSubscriptions + churn.cancellations;
    expect(churn.rate).toBe(Math.round((churn.cancellations / base) * 1000) / 10);
  });

  it('counts a checkout as a subscription won', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const payer = await createUser({ role: 'parent', plan: 'premium' });
    const before = await summaryFor(admin);

    await payment(payer.id, { createdAt: daysAgo(4), type: 'checkout_completed' });

    const summary = await summaryFor(admin);
    expect(summary.churn.newSubscriptions - before.churn.newSubscriptions).toBe(1);
    // A checkout is money as well as a win, so it lands in the month's revenue.
    expect(summary.billed.month - before.billed.month).toBe(999);
  });

  it('does not move when the log below it is filtered', async () => {
    const admin = await createUser({ role: 'super_admin' });
    const payer = await createUser({ role: 'parent', name: 'Filter Proof', plan: 'premium' });
    await payment(payer.id, { createdAt: daysAgo(1) });
    await payment(payer.id, { createdAt: daysAgo(2), type: 'invoice_failed', status: 'failed' });

    const all = await list(admin);
    const narrowed = await list(admin, '?search=Filter%20Proof&status=failed');

    expect(narrowed.count).toBe(1);
    expect(all.count).toBeGreaterThan(narrowed.count);
    // The tiles describe the platform, so narrowing the table must not move them.
    expect(narrowed.summary).toEqual(all.summary);
  });
});
