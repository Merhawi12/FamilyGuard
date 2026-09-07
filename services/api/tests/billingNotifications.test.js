/**
 * A payment the customer is actually told about.
 *
 * Reported as "the payment completes and nothing arrives". It was accurate:
 * `applyCheckoutCompletion` upgraded the account and recorded the sale, the plan
 * screen said "Payment successful" on the page the customer was already looking
 * at, and no other channel said anything — no receipt, no bell, no push. Close
 * the tab and the only evidence was a line on a card statement a month later.
 * The monthly renewals after it were silent too, which is the half that matters
 * more: a recurring charge nobody is told about is the one people find by
 * accident.
 *
 * The properties pinned here are the ones that are easy to lose in a refactor:
 *
 *   - a successful payment reaches all three channels;
 *   - the two paths that report the *same* payment — Stripe's webhook and the
 *     customer's return from Checkout, which race each other — produce exactly
 *     one receipt between them;
 *   - the first invoice of a subscription does not congratulate somebody twice;
 *   - a later invoice does, every month, and says when the next one is due;
 *   - a redelivered event does not send a second copy;
 *   - an account with no email address still gets the other two channels.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { Notification, Transaction } = require('../src/models');
const { createUser, tokenFor } = require('./helpers');
const Stripe = require('stripe'); // the manual mock in __mocks__/stripe.js

// Replaced rather than spied on: `utils/email` destructures `send` at module
// load, so a spy attached afterwards would never be what it calls.
jest.mock('../src/services/mailer', () => ({
  send: jest.fn().mockResolvedValue(true),
  isEnabled: jest.fn().mockReturnValue(true),
}));

// Reached through the module by `billingNotice`, which is what makes this
// interceptable at all — see the comment on its require.
jest.mock('../src/utils/pushService', () => ({
  ...jest.requireActual('../src/utils/pushService'),
  sendToUser: jest.fn().mockResolvedValue({ sent: 1, failed: 0, recipients: 1 }),
}));

const mailer = require('../src/services/mailer');
const pushService = require('../src/utils/pushService');
const { flushBackground } = require('../src/utils/background');

const sessions = Stripe.__mock.checkout.sessions;
const constructEvent = Stripe.__mock.webhooks.constructEvent;

/** The notice is deliberately not awaited by the handler — see `track`. */
const settle = () => flushBackground();

const mailsTo = (address) =>
  mailer.send.mock.calls.map(([msg]) => msg).filter((msg) => msg.to === address);

const bellFor = (user) => Notification.findAll({ where: { userId: user.id } });

let counter = 0;
const nextSessionId = () => `cs_notice_${counter++}`;

/** Drives the next `sessions.retrieve` — the confirm route's source of truth. */
const stripeSession = (overrides = {}) => {
  sessions.retrieve.mockImplementation(async (id) => ({
    id,
    status: 'complete',
    payment_status: 'paid',
    customer: 'cus_test',
    subscription: 'sub_test',
    amount_total: 999,
    currency: 'cad',
    metadata: {},
    ...overrides,
  }));
};

const confirm = (user, sessionId) =>
  request(app)
    .post('/api/payments/checkout/confirm')
    .set('Authorization', `Bearer ${tokenFor(user)}`)
    .send({ sessionId });

const postWebhook = (event) => {
  constructEvent.mockReturnValueOnce(event);
  return request(app)
    .post('/api/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 'test-sig')
    .send(JSON.stringify({ any: 'payload' }));
};

beforeEach(() => {
  mailer.send.mockClear();
  mailer.send.mockResolvedValue(true);
  mailer.isEnabled.mockReturnValue(true);
  pushService.sendToUser.mockClear();
  stripeSession();
});

describe('the first payment', () => {
  it('reaches the bell, the inbox and the phone', async () => {
    const user = await createUser({ plan: 'free', stripeCustomerId: 'cus_test' });

    const res = await confirm(user, nextSessionId());
    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(true);
    await settle();

    const bell = await bellFor(user);
    expect(bell).toHaveLength(1);
    // Not merely "a notification exists": the two things a customer needs to
    // read are that it worked and what it cost.
    expect(bell[0].title).toMatch(/Premium Plan activated/i);
    expect(bell[0].message).toContain('$9.99');
    // 'success' is what paints the bell row green; 'info' is the default and
    // would make a payment look like an announcement.
    expect(bell[0].type).toBe('success');
    // A staff announcement carries a `createdBy`; the console lists sent
    // notifications by it, and a receipt per customer per month would bury them.
    expect(bell[0].createdBy).toBeNull();

    const emails = mailsTo(user.email);
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toMatch(/Premium Plan is active/i);
    expect(emails[0].html).toContain('$9.99');
    // The sentence that stops the following month being a surprise.
    expect(emails[0].html).toMatch(/monthly subscription/i);

    expect(pushService.sendToUser).toHaveBeenCalledTimes(1);
    const [userId, payload] = pushService.sendToUser.mock.calls[0];
    expect(userId).toBe(user.id);
    expect(payload.data).toMatchObject({ type: 'billing', url: '/dashboard/settings?section=plan' });
  });

  /**
   * The purchase receipt carries its invoice.
   *
   * It did not. Only the monthly `invoice.paid` handler passed a `receiptUrl`,
   * because that event *is* an invoice — a Checkout session carries only its id,
   * and nothing looked it up. So the renewals were documented and the purchase
   * that started the subscription was not: the one payment a customer is most
   * likely to want a record of was the one with nothing to download. The
   * template did not even accept the field, so passing it would have been
   * silently dropped, which is why this asserts on the rendered email.
   */
  it('carries the invoice and the renewal date', async () => {
    const user = await createUser({ plan: 'free', stripeCustomerId: 'cus_test' });
    stripeSession({ invoice: 'in_first' });

    await confirm(user, nextSessionId());
    await settle();

    const [email] = mailsTo(user.email);
    expect(email.html).toContain('https://stripe.test/invoice/in_first');
    expect(email.html).toMatch(/download your invoice/i);

    // The subscription's own details, not just "it worked": what was bought,
    // what it cost, and when it happens again.
    expect(email.html).toContain('Premium Plan');
    expect(email.html).toContain('$9.99');
    expect(email.html).toMatch(/next payment/i);
    // The mock's period end, formatted the way billingNotice does it — in UTC,
    // so this does not move with the machine running the suite.
    expect(email.html).toMatch(/November 1, 2026/);
  });

  /**
   * A session that owed nothing still reads correctly.
   *
   * A hundred-percent coupon or a trial with no card due completes with
   * `payment_status: 'no_payment_required'` and has no invoice at all. The
   * receipt has to survive that without printing a dead link or an empty row —
   * the plan really was activated and the customer really should be told.
   */
  it('reads correctly when there is no invoice to link', async () => {
    const user = await createUser({ plan: 'free', stripeCustomerId: 'cus_test' });
    stripeSession({ invoice: null, payment_status: 'no_payment_required' });

    await confirm(user, nextSessionId());
    await settle();

    const [email] = mailsTo(user.email);
    expect(email.html).toMatch(/Premium Plan/);
    expect(email.html).not.toMatch(/download your invoice/i);
    expect(email.html).not.toMatch(/next payment/i);
    // Never a broken link or an empty href where the invoice would have gone.
    expect(email.html).not.toMatch(/href="">|href="null"|undefined/);
  });

  /**
   * Stripe being unreachable costs the link, not the receipt.
   *
   * This runs off the back of a settled payment. If a failed invoice lookup
   * could throw, it would take the webhook's response with it — Stripe would
   * retry an event whose transaction row already exists, `firstReport` would be
   * false on every retry, and the receipt would then never be sent at all.
   */
  it('still sends the receipt when the invoice cannot be fetched', async () => {
    const user = await createUser({ plan: 'free', stripeCustomerId: 'cus_test' });
    stripeSession({ invoice: 'in_broken' });
    Stripe.__mock.invoices.retrieve.mockRejectedValueOnce(new Error('stripe unavailable'));

    const res = await confirm(user, nextSessionId());
    expect(res.status).toBe(200);
    await settle();

    const [email] = mailsTo(user.email);
    expect(email.html).toContain('$9.99');
    expect(email.html).not.toMatch(/download your invoice/i);
    expect(await bellFor(user)).toHaveLength(1);
    expect(pushService.sendToUser).toHaveBeenCalledTimes(1);
  });

  /**
   * The invoice is fetched by whoever sends the receipt, and only them.
   *
   * The webhook and the customer's return race, and `firstReport` decides which
   * one speaks. Looking the invoice up before that check would spend a Stripe
   * round trip on the loser too — on every payment, for a receipt it is about to
   * decide not to send.
   */
  it('does not look the invoice up for the loser of the race', async () => {
    const user = await createUser({ plan: 'free', stripeCustomerId: 'cus_test' });
    const sessionId = nextSessionId();
    stripeSession({ invoice: 'in_race', metadata: { userId: user.id, plan: 'premium' } });
    Stripe.__mock.invoices.retrieve.mockClear();

    await confirm(user, sessionId);
    await postWebhook({
      id: 'evt_notice_invoice_race',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId,
          invoice: 'in_race',
          metadata: { userId: user.id, plan: 'premium' },
          subscription: 'sub_test',
          amount_total: 999,
          currency: 'cad',
        },
      },
    });
    await settle();

    expect(Stripe.__mock.invoices.retrieve).toHaveBeenCalledTimes(1);
    expect(mailsTo(user.email)).toHaveLength(1);
  });

  it('is reported once even though the webhook and the browser both report it', async () => {
    const user = await createUser({ plan: 'free', stripeCustomerId: 'cus_test' });
    const sessionId = nextSessionId();
    stripeSession({ metadata: { userId: user.id, plan: 'premium' } });

    // The customer gets back first, which is the common case when the webhook
    // secret is configured but Stripe is a moment behind.
    await confirm(user, sessionId);
    await postWebhook({
      id: 'evt_notice_dupe',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId,
          metadata: { userId: user.id, plan: 'premium' },
          subscription: 'sub_test',
          amount_total: 999,
          currency: 'cad',
        },
      },
    });
    await settle();

    expect(await bellFor(user)).toHaveLength(1);
    expect(mailsTo(user.email)).toHaveLength(1);
    expect(pushService.sendToUser).toHaveBeenCalledTimes(1);
    // The dedupe is the transaction row, so it has to be the single row too.
    expect(await Transaction.count({ where: { userId: user.id } })).toBe(1);
  });

  it('is reported once when the webhook wins the race instead', async () => {
    const user = await createUser({ plan: 'free', stripeCustomerId: 'cus_test' });
    const sessionId = nextSessionId();
    stripeSession({ metadata: { userId: user.id, plan: 'premium' } });

    await postWebhook({
      id: 'evt_notice_race',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId,
          metadata: { userId: user.id, plan: 'premium' },
          subscription: 'sub_test',
          amount_total: 999,
          currency: 'cad',
        },
      },
    });
    await confirm(user, sessionId);
    await settle();

    expect(await bellFor(user)).toHaveLength(1);
    expect(mailsTo(user.email)).toHaveLength(1);
  });

  it('still reaches a phone-only account, which has no inbox to send to', async () => {
    const user = await createUser({ plan: 'free', stripeCustomerId: 'cus_test', email: null, phone: '+15550000111' });

    await confirm(user, nextSessionId());
    await settle();

    expect(await bellFor(user)).toHaveLength(1);
    expect(pushService.sendToUser).toHaveBeenCalledTimes(1);
    // Nothing was sent to nobody. `send` refuses a missing recipient, but the
    // point is that the other two channels ran rather than the whole notice
    // being skipped for want of an address.
    expect(mailer.send).not.toHaveBeenCalled();
  });
});

describe('every month after that', () => {
  /**
   * A customer id per test, because the invoice handler finds the account *by*
   * it — the accounts above all share `cus_test` (the mock's own), and a renewal
   * addressed to it would be attributed to whichever of them was created first.
   */
  const uniqueCustomer = () => `cus_renewal_${counter++}`;

  const invoiceEvent = (id, customer, invoice) => ({
    id,
    type: 'invoice.paid',
    data: { object: { customer, amount_paid: 999, currency: 'cad', ...invoice } },
  });

  it('a renewal is reported, and says when the next one is due', async () => {
    const customer = uniqueCustomer();
    const user = await createUser({ plan: 'premium', stripeCustomerId: customer });

    // 2026-11-02, as Stripe sends it: Unix seconds.
    const periodEnd = Math.floor(Date.UTC(2026, 10, 2) / 1000);
    await postWebhook(invoiceEvent('evt_cycle_1', customer, {
      billing_reason: 'subscription_cycle',
      period_end: periodEnd,
      hosted_invoice_url: 'https://stripe.test/receipt/1',
    }));
    await settle();

    const bell = await bellFor(user);
    expect(bell).toHaveLength(1);
    expect(bell[0].message).toContain('$9.99');
    expect(bell[0].message).toMatch(/November 2, 2026/);

    const emails = mailsTo(user.email);
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toMatch(/receipt/i);
    // The link to Stripe's own copy, when the invoice carries one.
    expect(emails[0].html).toContain('https://stripe.test/receipt/1');

    expect(pushService.sendToUser).toHaveBeenCalledTimes(1);
  });

  it('the subscription\'s first invoice does not congratulate anybody twice', async () => {
    const customer = uniqueCustomer();
    const user = await createUser({ plan: 'premium', stripeCustomerId: customer });

    // What Stripe sends moments after checkout.session.completed, for the same
    // money — the activation notice has already gone out.
    await postWebhook(invoiceEvent('evt_create_1', customer, { billing_reason: 'subscription_create' }));
    await settle();

    expect(await bellFor(user)).toHaveLength(0);
    expect(mailsTo(user.email)).toHaveLength(0);
    expect(pushService.sendToUser).not.toHaveBeenCalled();
    // The sale is still recorded; only the notice is suppressed.
    expect(await Transaction.count({ where: { userId: user.id, type: 'invoice_paid' } })).toBe(1);
  });

  it('a redelivered invoice does not send a second receipt', async () => {
    const customer = uniqueCustomer();
    const user = await createUser({ plan: 'premium', stripeCustomerId: customer });
    const event = invoiceEvent('evt_cycle_replay', customer, { billing_reason: 'subscription_cycle' });

    await postWebhook(event);
    await postWebhook(event);
    await settle();

    expect(await bellFor(user)).toHaveLength(1);
    expect(mailsTo(user.email)).toHaveLength(1);
  });
});
