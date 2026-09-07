/**
 * Buying Premium, end to end.
 *
 * Every part of this chain already had a test. What none of them had was the
 * chain: `checkoutConfirmation` proves the grant, `billingNotifications` proves
 * the receipt, `adminBilling` proves the console's listing — each against its
 * own seeded fixture, so all three could pass while a real purchase fell down
 * between them. That is not hypothetical here; the invoice link this suite
 * asserts on was missing from the activation email for exactly that reason, and
 * every one of those suites was green throughout.
 *
 * So this walks one payment through the whole product, in order, and asserts
 * what a customer and an operator can each see afterwards:
 *
 *   1. the customer picks Premium and Checkout opens;
 *   2. the payment completes;
 *   3. Premium is activated on the account;
 *   4. the subscription and the payment appear in the Admin Dashboard;
 *   5. a confirmation email arrives saying the payment succeeded;
 *   6. that email carries the invoice and the subscription's details;
 *   7. the payment and the subscription status are correct in the database.
 *
 * Deliberately one test rather than seven. The ordering *is* the property — an
 * assertion that the console lists a payment means nothing unless the payment
 * got there by being made — and splitting it would re-create the same
 * seeded-fixture blindness this file exists to close.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { User, Transaction, Notification } = require('../src/models');
const { createUser, tokenFor } = require('./helpers');
const Stripe = require('stripe'); // the manual mock in __mocks__/stripe.js

jest.mock('../src/services/mailer', () => ({
  send: jest.fn().mockResolvedValue(true),
  isEnabled: jest.fn().mockReturnValue(true),
}));

jest.mock('../src/utils/pushService', () => ({
  ...jest.requireActual('../src/utils/pushService'),
  sendToUser: jest.fn().mockResolvedValue({ sent: 1, failed: 0, recipients: 1 }),
}));

const mailer = require('../src/services/mailer');
const { flushBackground } = require('../src/utils/background');

const bearer = (u) => ({ Authorization: `Bearer ${tokenFor(u)}` });
const sessions = Stripe.__mock.checkout.sessions;

beforeEach(() => {
  mailer.send.mockClear();
  mailer.send.mockResolvedValue(true);
  mailer.isEnabled.mockReturnValue(true);
});

describe('a parent subscribes to Premium', () => {
  it('is charged, upgraded, told, invoiced, recorded and visible to staff', async () => {
    const parent = await createUser({ plan: 'free', email: 'buyer@example.com' });
    // Finance rather than super_admin: the billing screens are what this
    // department exists for, so it is the account that must be able to see a
    // sale. A test that only proved it to a super admin would not notice the
    // permission being tightened out from under the people who use it.
    const staff = await createUser({
      role: 'finance', permissions: ['manage_billing'], email: 'ops@example.com',
    });

    // ── 1. The customer selects Premium ──────────────────────────────────────
    // The real thing, not a stubbed grant: this is the route the Upgrade button
    // calls, and it is where a missing price ID or a dead `stripeCustomerId`
    // would 503 rather than open a payment form.
    const checkout = await request(app)
      .post('/api/payments/create-checkout-session')
      .set(bearer(parent))
      .send({ plan: 'premium' });

    expect(checkout.status).toBe(200);
    expect(checkout.body.url).toMatch(/^https:\/\//);

    // ── 2. The payment completes ─────────────────────────────────────────────
    // Stripe reports the session as complete and paid, and carries the invoice
    // it raised for it.
    const sessionId = 'cs_premium_flow';
    sessions.retrieve.mockImplementation(async (id) => ({
      id,
      status: 'complete',
      payment_status: 'paid',
      customer: 'cus_test',
      subscription: 'sub_premium_flow',
      invoice: 'in_premium_flow',
      amount_total: 999,
      currency: 'cad',
      metadata: { userId: parent.id, plan: 'premium' },
    }));

    const confirm = await request(app)
      .post('/api/payments/checkout/confirm')
      .set(bearer(parent))
      .send({ sessionId });

    expect(confirm.status).toBe(200);

    // ── 3. Premium is activated ──────────────────────────────────────────────
    expect(confirm.body.activated).toBe(true);
    expect(confirm.body.plan).toBe('premium');
    // Handed straight back, so the plan screen does not need a second call to
    // learn what it just bought.
    expect(confirm.body.user.plan).toBe('premium');

    await flushBackground();

    // ── 4. The subscription and payment appear in the Admin Dashboard ────────
    const console_ = await request(app)
      .get('/api/admin/transactions')
      .set(bearer(staff))
      .then((r) => r.body);

    const sale = console_.rows.find((row) => row.userId === parent.id);
    expect(sale).toBeDefined();
    // `checkout_completed` is what the console renders as "New subscription".
    expect(sale.type).toBe('checkout_completed');
    expect(sale.status).toBe('succeeded');
    expect(sale.amount).toBe(999);
    expect(sale.plan).toBe('premium');
    // The joined account, so an operator sees who paid rather than a bare id.
    expect(sale.user.email).toBe('buyer@example.com');
    expect(sale.user.plan).toBe('premium');

    // The business summary the tiles above the table are drawn from moves too —
    // a sale that lists but does not count is the failure this catches.
    expect(console_.summary.subscribers).toBeGreaterThanOrEqual(1);

    // And the same payment on the account's own record in the console.
    const perUser = await request(app)
      .get(`/api/admin/users/${parent.id}/transactions`)
      .set(bearer(staff))
      .then((r) => r.body);
    expect(perUser.map((t) => t.type)).toContain('checkout_completed');

    // ── 5. A confirmation email says the payment succeeded ───────────────────
    const emails = mailer.send.mock.calls
      .map(([msg]) => msg)
      .filter((msg) => msg.to === 'buyer@example.com');

    expect(emails).toHaveLength(1);
    const [receipt] = emails;
    expect(receipt.subject).toMatch(/Premium Plan is active/i);
    expect(receipt.html).toMatch(/payment of <strong>\$9\.99<\/strong> was\s+successful/);

    // ── 6. It carries the invoice and the subscription's details ─────────────
    expect(receipt.html).toContain('https://stripe.test/invoice/in_premium_flow');
    expect(receipt.html).toMatch(/download your invoice/i);
    expect(receipt.html).toContain('Premium Plan');
    expect(receipt.html).toContain('$9.99');
    expect(receipt.html).toMatch(/monthly subscription/i);
    expect(receipt.html).toMatch(/next payment/i);

    // The bell and the push carry the same payment, so a customer who never
    // opens the email still learns of it.
    const bell = await Notification.findAll({ where: { userId: parent.id } });
    expect(bell).toHaveLength(1);
    expect(bell[0].type).toBe('success');
    expect(bell[0].message).toContain('$9.99');

    // ── 7. The database holds the payment and the subscription status ────────
    const stored = await User.findByPk(parent.id);
    expect(stored.plan).toBe('premium');
    expect(stored.subscriptionStatus).toBe('active');
    // The Stripe handle, without which the account can never be cancelled or
    // renewed — and which `featureGate` reads alongside the status.
    expect(stored.stripeSubscriptionId).toBe('sub_premium_flow');
    expect(stored.stripeCustomerId).toBe('cus_test');

    const rows = await Transaction.findAll({ where: { userId: parent.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].stripeEventId).toBe(`checkout:${sessionId}`);
    expect(rows[0].currency).toBe('cad');
  });
});
