// Auto-applied manual mock (adjacent to node_modules). payments.js constructs the
// client once at load, so we return a SHARED instance whose jest.fn()s tests can
// drive via Stripe.__mock (e.g. constructEvent for webhook cases). By default
// subscriptions.retrieve REJECTS so we can assert graceful degradation (M9).
const instance = {
  customers: {
    create: jest.fn(async () => ({ id: 'cus_test' })),
  },
  subscriptions: {
    retrieve: jest.fn(async () => {
      throw new Error('stripe unavailable (mock)');
    }),
    // Resolves by default: closing an account cancels the subscription first and
    // refuses to delete anything if that fails, so a mock that threw would make
    // every deletion test a test of the failure path.
    cancel: jest.fn(async (id) => ({ id, status: 'canceled' })),
  },
  checkout: {
    sessions: {
      create: jest.fn(async () => ({ id: 'cs_test', url: 'https://stripe.test/checkout' })),
      /**
       * Resolves to a completed, paid session by default.
       *
       * The opposite choice from `subscriptions.retrieve` above, and for the
       * opposite reason: that one rejects so the graceful-degradation path is
       * what gets exercised, whereas this one is the *fulfilment* path — a
       * customer coming back from Checkout with money already taken — so the
       * default has to be the case where the plan must actually be granted. A
       * mock that failed here would make every confirmation test a test of the
       * failure branch, which is how "paid but never upgraded" survived.
       *
       * `customer: 'cus_test'` matches what `customers.create` returns, so a
       * user who went through create-checkout-session owns this session.
       */
      retrieve: jest.fn(async (id) => ({
        id,
        status: 'complete',
        payment_status: 'paid',
        customer: 'cus_test',
        subscription: 'sub_test',
        amount_total: 999,
        currency: 'cad',
        metadata: {},
      })),
    },
  },
  billingPortal: {
    sessions: {
      create: jest.fn(async () => ({ url: 'https://stripe.test/portal' })),
    },
  },
  webhooks: {
    constructEvent: jest.fn(() => ({ type: 'noop', id: 'evt_noop' })),
  },
};

const Stripe = jest.fn(() => instance);
Stripe.__mock = instance; // tests reach the shared fns through this

module.exports = Stripe;
