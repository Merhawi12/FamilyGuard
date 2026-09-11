/**
 * What a payment looks like from the console.
 *
 * Reported as "the payment completes and it is not in the Admin Dashboard".
 * Behind that one sentence were several distinct faults, and each of them
 * survived a fully green suite — because every existing billing test asserted
 * against its own seeded fixture, and the ones that drove the webhook drove it
 * with payloads Stripe does not actually send.
 *
 * What is pinned here:
 *
 *   - one payment is one row, whichever of the three events reports it first;
 *   - staff are told, once, and only the staff whose job it is;
 *   - a completed-but-unpaid checkout grants nothing and records nothing;
 *   - a delayed payment that settles later still lands, and one that fails is
 *     recorded as a failure rather than silence;
 *   - a paid invoice puts a past-due account back to active;
 *   - the console can recover payments a broken webhook never delivered, without
 *     recording any of them twice.
 */
const request = require('supertest');
const Stripe = require('stripe'); // the manual mock in __mocks__/stripe.js
const { app } = require('../src/app');
const { User, Transaction, Notification, AuditLog } = require('../src/models');
const { createUser, tokenFor } = require('./helpers');
const { flushBackground } = require('../src/utils/background');

jest.mock('../src/services/mailer', () => ({
  send: jest.fn().mockResolvedValue(true),
  isEnabled: jest.fn().mockReturnValue(true),
}));

jest.mock('../src/utils/pushService', () => ({
  ...jest.requireActual('../src/utils/pushService'),
  sendToUser: jest.fn().mockResolvedValue({ sent: 1, failed: 0, recipients: 1 }),
}));

const constructEvent = Stripe.__mock.webhooks.constructEvent;
const invoicesList = Stripe.__mock.invoices.list;

const bearer = (u) => ({ Authorization: `Bearer ${tokenFor(u)}` });

const postWebhook = (event) => {
  constructEvent.mockReturnValueOnce(event);
  return request(app)
    .post('/api/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 'test-sig')
    .send(JSON.stringify({ any: 'payload' }));
};

/** The notices are deliberately not awaited by the handlers — see `track`. */
const settle = () => flushBackground();

const bellFor = (user) => Notification.findAll({ where: { userId: user.id } });
const paymentsFor = (user) => Transaction.findAll({ where: { userId: user.id } });

let seq = 0;
const uniqueCustomer = () => `cus_visible_${seq++}`;

/** A paid Checkout session, as Stripe reports one. */
const checkoutSession = (customer, overrides = {}) => ({
  id: `cs_${seq++}`,
  status: 'complete',
  payment_status: 'paid',
  customer,
  subscription: `sub_${seq}`,
  amount_total: 999,
  currency: 'cad',
  ...overrides,
});

const invoice = (customer, overrides = {}) => ({
  id: `in_${seq++}`,
  customer,
  amount_paid: 999,
  currency: 'cad',
  billing_reason: 'subscription_cycle',
  ...overrides,
});

/** A finance account: `manage_billing` is what the Billing screen is gated on. */
const financeStaff = () => createUser({ role: 'finance', permissions: ['manage_billing'] });

beforeEach(() => {
  invoicesList.mockClear();
  invoicesList.mockResolvedValue({ data: [], has_more: false });
});

describe('staff are told about a payment', () => {
  it('writes a notification and an audit entry when a customer subscribes', async () => {
    const finance = await financeStaff();
    const customer = uniqueCustomer();
    const parent = await createUser({ plan: 'free', stripeCustomerId: customer });

    await postWebhook({
      id: `evt_${seq++}`,
      type: 'checkout.session.completed',
      data: { object: checkoutSession(customer, { invoice: 'in_staff_1', metadata: { userId: parent.id, plan: 'premium' } }) },
    });
    await settle();

    const inbox = await bellFor(finance);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].title).toMatch(/new premium subscription/i);
    // The customer, and what they paid — an operator should not have to open the
    // Billing screen to know which account and how much.
    expect(inbox[0].message).toContain(parent.email);
    expect(inbox[0].message).toContain('$9.99');
    // Straight to the screen it is about.
    expect(inbox[0].link).toBe('/billing');
    // Null, so a payment notice never appears in the console's list of
    // announcements staff have sent.
    expect(inbox[0].createdBy).toBeNull();

    // The durable half: filterable on System Logs, counted on the Overview.
    const entries = await AuditLog.findAll({ where: { action: 'billing.payment_received' } });
    const entry = entries.find((row) => row.metadata?.customerId === parent.id);
    expect(entry).toBeDefined();
    expect(entry.metadata.amount).toBe(999);
    expect(entry.metadata.plan).toBe('premium');
    // The key the transaction row carries, so an operator can tie the three
    // records together — and to Stripe.
    expect(entry.metadata.reference).toBe('invoice:in_staff_1');
  });

  /**
   * Least privilege, on a screen about customers' money.
   *
   * Marketing cannot open the Billing screen, so putting a customer's payment in
   * their bell would be telling them something they are not allowed to go and
   * read — and burying the announcements their own bell exists for.
   */
  it('does not tell staff who cannot open the billing screen', async () => {
    const marketing = await createUser({ role: 'marketing', permissions: ['send_notifications'] });
    const suspended = await createUser({ role: 'finance', permissions: ['manage_billing'], isActive: false });
    const customer = uniqueCustomer();
    const parent = await createUser({ plan: 'free', stripeCustomerId: customer });

    await postWebhook({
      id: `evt_${seq++}`,
      type: 'checkout.session.completed',
      data: { object: checkoutSession(customer, { invoice: 'in_staff_2', metadata: { userId: parent.id } }) },
    });
    await settle();

    expect(await bellFor(marketing)).toHaveLength(0);
    // A deactivated account cannot sign in to read it, and filling its bell is
    // how an unread count stops meaning anything.
    expect(await bellFor(suspended)).toHaveLength(0);
  });

  /**
   * One payment, one notice — however many times Stripe reports it.
   *
   * The webhook, the customer's return from Checkout and the subscription's
   * first invoice all describe the same money, and the first two genuinely race.
   * The transaction row is the gate, so whichever gets there first is the only
   * one that speaks.
   */
  it('tells them once for a payment reported three times', async () => {
    const finance = await financeStaff();
    const customer = uniqueCustomer();
    const parent = await createUser({ plan: 'free', stripeCustomerId: customer });
    const session = checkoutSession(customer, {
      invoice: 'in_staff_3', metadata: { userId: parent.id, plan: 'premium' },
    });

    const event = { id: `evt_${seq++}`, type: 'checkout.session.completed', data: { object: session } };
    await postWebhook(event);
    // Stripe redelivering the same event, which it does for days after any 5xx.
    await postWebhook(event);
    // And the invoice for the same charge.
    await postWebhook({
      id: `evt_${seq++}`,
      type: 'invoice.paid',
      data: { object: invoice(customer, { id: 'in_staff_3', billing_reason: 'subscription_create' }) },
    });
    await settle();

    expect(await bellFor(finance)).toHaveLength(1);
    expect(await paymentsFor(parent)).toHaveLength(1);
  });

  it('reports a failed card, and does not record it as money taken', async () => {
    const finance = await financeStaff();
    const customer = uniqueCustomer();
    const parent = await createUser({ plan: 'premium', stripeCustomerId: customer });

    await postWebhook({
      id: `evt_${seq++}`,
      type: 'invoice.payment_failed',
      data: { object: { customer, amount_due: 999, currency: 'cad', id: 'in_fail_1' } },
    });
    await settle();

    const inbox = await bellFor(finance);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].title).toMatch(/payment failed/i);
    // 'warning' rather than 'success': the colour is the first thing read.
    expect(inbox[0].type).toBe('warning');

    const [row] = await paymentsFor(parent);
    expect(row.status).toBe('failed');
    expect(row.type).toBe('invoice_failed');

    // `_failed` is an error suffix in logSeverity, so this lands on the System
    // Logs error filter without a rule being added for it.
    const entry = (await AuditLog.findAll({ where: { action: 'billing.payment_failed' } }))
      .find((log) => log.metadata?.customerId === parent.id);
    expect(entry).toBeDefined();

    expect((await User.findByPk(parent.id)).subscriptionStatus).toBe('past_due');
  });

  it('reports a cancellation, naming the plan that was lost', async () => {
    const finance = await financeStaff();
    const customer = uniqueCustomer();
    const parent = await createUser({
      plan: 'premium', subscriptionStatus: 'active', stripeCustomerId: customer, stripeSubscriptionId: 'sub_gone',
    });

    await postWebhook({
      id: `evt_${seq++}`,
      type: 'customer.subscription.deleted',
      data: { object: { customer } },
    });
    await settle();

    const inbox = await bellFor(finance);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].title).toMatch(/cancelled/i);
    // Premium, not "Free Plan" — the account has already been dropped to free by
    // the time the notice is written, so this is only right if the plan was read
    // before the write.
    expect(inbox[0].message).toMatch(/Premium Plan/);

    expect((await User.findByPk(parent.id)).plan).toBe('free');
  });
});

describe('a payment that has not settled', () => {
  /**
   * `checkout.session.completed` fires for a delayed payment method — a bank
   * debit, a voucher — with `payment_status: 'unpaid'`, hours or days before the
   * money arrives. The handler used to grant on it regardless: a `succeeded`
   * transaction for money that had not moved, Premium activated, the customer
   * congratulated and finance told a sale had landed. And because the row was
   * keyed on that invoice, nothing arriving later could correct it.
   */
  it('grants nothing and records nothing until it does', async () => {
    const finance = await financeStaff();
    const customer = uniqueCustomer();
    const parent = await createUser({ plan: 'free', stripeCustomerId: customer });

    const res = await postWebhook({
      id: `evt_${seq++}`,
      type: 'checkout.session.completed',
      data: {
        object: checkoutSession(customer, {
          id: 'cs_async_1',
          payment_status: 'unpaid',
          invoice: 'in_async_1',
          metadata: { userId: parent.id, plan: 'premium' },
        }),
      },
    });
    await settle();

    // Acknowledged, not retried: nothing is wrong, the money is simply not here.
    expect(res.status).toBe(200);
    expect((await User.findByPk(parent.id)).plan).toBe('free');
    expect(await paymentsFor(parent)).toHaveLength(0);
    expect(await bellFor(finance)).toHaveLength(0);
    expect(await bellFor(parent)).toHaveLength(0);
  });

  it('lands when the money finally arrives', async () => {
    const finance = await financeStaff();
    const customer = uniqueCustomer();
    const parent = await createUser({ plan: 'free', stripeCustomerId: customer });

    await postWebhook({
      id: `evt_${seq++}`,
      type: 'checkout.session.async_payment_succeeded',
      data: {
        object: checkoutSession(customer, {
          id: 'cs_async_2',
          invoice: 'in_async_2',
          subscription: 'sub_async_2',
          metadata: { userId: parent.id, plan: 'premium' },
        }),
      },
    });
    await settle();

    const stored = await User.findByPk(parent.id);
    expect(stored.plan).toBe('premium');
    expect(stored.subscriptionStatus).toBe('active');

    const [row] = await paymentsFor(parent);
    expect(row.status).toBe('succeeded');
    expect(row.amount).toBe(999);
    expect(await bellFor(finance)).toHaveLength(1);
  });

  it('is recorded as a failure when it never arrives', async () => {
    const finance = await financeStaff();
    const customer = uniqueCustomer();
    const parent = await createUser({ plan: 'free', stripeCustomerId: customer });

    await postWebhook({
      id: `evt_${seq++}`,
      type: 'checkout.session.async_payment_failed',
      data: {
        object: checkoutSession(customer, {
          id: 'cs_async_3',
          payment_status: 'unpaid',
          metadata: { userId: parent.id, plan: 'premium' },
        }),
      },
    });
    await settle();

    // Still on free — a failed payment must never look like a sale.
    expect((await User.findByPk(parent.id)).plan).toBe('free');

    const [row] = await paymentsFor(parent);
    expect(row.status).toBe('failed');
    expect(row.type).toBe('checkout_failed');
    expect(await bellFor(finance)).toHaveLength(1);
  });
});

describe('a renewal after a failed card', () => {
  /**
   * Stripe's retry landing left the account on `past_due` until an unrelated
   * `customer.subscription.updated` happened to arrive — and with dunning set to
   * "mark unpaid" or "pause", one that says `active` may never come. The console
   * showed a customer as behind on payments while their money was in the bank.
   */
  it('puts the subscription back to active', async () => {
    const customer = uniqueCustomer();
    const parent = await createUser({
      plan: 'premium', subscriptionStatus: 'past_due', stripeCustomerId: customer,
    });

    await postWebhook({
      id: `evt_${seq++}`,
      type: 'invoice.paid',
      data: { object: invoice(customer, { id: 'in_recovered' }) },
    });
    await settle();

    expect((await User.findByPk(parent.id)).subscriptionStatus).toBe('active');
  });

  /**
   * A staff decision about an account is not a statement about its card.
   * Suspension is applied by hand in the console and must survive a renewal.
   */
  it('does not lift a suspension', async () => {
    const customer = uniqueCustomer();
    const parent = await createUser({ plan: 'suspended', stripeCustomerId: customer });

    await postWebhook({
      id: `evt_${seq++}`,
      type: 'invoice.paid',
      data: { object: invoice(customer, { id: 'in_suspended', billing_reason: 'subscription_create' }) },
    });
    await settle();

    expect((await User.findByPk(parent.id)).plan).toBe('suspended');
  });
});

describe('reconciling against Stripe', () => {
  const sync = (staff, body = {}) => request(app)
    .post('/api/admin/billing/sync')
    .set(bearer(staff))
    .send(body);

  it('records a payment the webhook never delivered, and will not record it twice', async () => {
    const finance = await financeStaff();
    const customer = uniqueCustomer();
    const parent = await createUser({ plan: 'free', stripeCustomerId: customer });

    // What a deployment with a broken webhook secret looks like: Stripe has the
    // payment, this database has nothing.
    expect(await paymentsFor(parent)).toHaveLength(0);
    invoicesList.mockResolvedValue({
      data: [invoice(customer, { id: 'in_missed', billing_reason: 'subscription_create', subscription: 'sub_missed' })],
      has_more: false,
    });

    const first = await sync(finance);
    await settle();

    expect(first.status).toBe(200);
    expect(first.body.recorded).toBe(1);
    expect(first.body.scanned).toBe(1);

    const [row] = await paymentsFor(parent);
    expect(row.status).toBe('succeeded');
    expect(row.plan).toBe('premium');
    expect(row.stripeEventId).toBe('invoice:in_missed');

    // The account is caught up too, not just the ledger.
    const stored = await User.findByPk(parent.id);
    expect(stored.plan).toBe('premium');
    expect(stored.subscriptionStatus).toBe('active');
    expect(stored.stripeSubscriptionId).toBe('sub_missed');

    // Staff hear about it — the whole point of the backfill is that nobody knew.
    expect(await bellFor(finance)).toHaveLength(1);

    // Pressed again over the same window: recognised, not re-recorded.
    const second = await sync(finance);
    await settle();
    expect(second.body.recorded).toBe(0);
    expect(second.body.alreadyRecorded).toBe(1);
    expect(await paymentsFor(parent)).toHaveLength(1);
    expect(await bellFor(finance)).toHaveLength(1);
  });

  /**
   * A backfill is not a reason to email somebody about a charge they saw on a
   * statement in July. Staff are told; the customer is not.
   */
  it('does not send the customer a receipt for an old payment', async () => {
    const finance = await financeStaff();
    const customer = uniqueCustomer();
    const parent = await createUser({ plan: 'premium', stripeCustomerId: customer });

    invoicesList.mockResolvedValue({
      data: [invoice(customer, { id: 'in_backfill_quiet' })],
      has_more: false,
    });

    await sync(finance);
    await settle();

    expect(await paymentsFor(parent)).toHaveLength(1);
    expect(await bellFor(parent)).toHaveLength(0);
  });

  /**
   * Money Stripe took that matches no account here. The commonest cause is
   * benign and important: the key points at a Stripe account this database was
   * never the backend for, so the whole comparison is against the wrong books.
   */
  it('reports invoices it cannot attribute rather than dropping them', async () => {
    const finance = await financeStaff();

    invoicesList.mockResolvedValue({
      data: [invoice('cus_belongs_to_nobody', { id: 'in_orphan' })],
      has_more: false,
    });

    const res = await sync(finance);
    expect(res.body.recorded).toBe(0);
    expect(res.body.unattributed).toBe(1);
    expect(res.body.unattributedInvoices[0]).toMatchObject({ invoice: 'in_orphan' });
  });

  it('is audited, because it writes payments and changes subscriptions', async () => {
    const finance = await financeStaff();
    await sync(finance);
    await settle();

    const entry = (await AuditLog.findAll({ where: { action: 'billing.reconciled' } }))
      .find((log) => log.userId === finance.id);
    expect(entry).toBeDefined();
  });

  it('is refused to staff without the billing permission', async () => {
    const support = await createUser({ role: 'support', permissions: ['manage_users'] });
    expect((await sync(support)).status).toBe(403);
    // And it did not reach Stripe on the way to being refused.
    expect(invoicesList).not.toHaveBeenCalled();
  });
});

describe('the console reads what the webhook wrote', () => {
  /**
   * The failure this whole file exists for, asserted where the complaint was
   * made: on the screen. A sale reported by both events must appear once, count
   * once, and carry the customer it belongs to.
   */
  it('lists a new subscription once, with the customer and the amount', async () => {
    const finance = await financeStaff();
    const customer = uniqueCustomer();
    const parent = await createUser({
      plan: 'free', stripeCustomerId: customer, email: 'shows-up@example.com',
    });

    await postWebhook({
      id: `evt_${seq++}`,
      type: 'checkout.session.completed',
      data: {
        object: checkoutSession(customer, {
          invoice: 'in_console_1', metadata: { userId: parent.id, plan: 'premium' },
        }),
      },
    });
    await postWebhook({
      id: `evt_${seq++}`,
      type: 'invoice.paid',
      data: { object: invoice(customer, { id: 'in_console_1', billing_reason: 'subscription_create' }) },
    });
    await settle();

    const body = await request(app)
      .get('/api/admin/transactions')
      .set(bearer(finance))
      .then((r) => r.body);

    const mine = body.rows.filter((row) => row.userId === parent.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].type).toBe('checkout_completed');
    expect(mine[0].status).toBe('succeeded');
    expect(mine[0].amount).toBe(999);
    expect(mine[0].user.email).toBe('shows-up@example.com');
    // The account's current state, so a payment can be read against where the
    // subscription stands now.
    expect(mine[0].user.subscriptionStatus).toBe('active');

    // And the screen says whether it can be believed.
    expect(body.summary.configuration).toBeDefined();
    expect(Array.isArray(body.summary.configuration.gaps)).toBe(true);
  });
});
