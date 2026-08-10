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
