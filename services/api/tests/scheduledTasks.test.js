/**
 * The Cloud Scheduler task endpoint.
 *
 * This route runs a fleet-wide pass over every parent, and unlike every other
 * route it is not reached with a JWT — the caller is a service account. Cloud
 * Run cannot gate it either: the service is invokable by allUsers because
 * Stripe's webhook and the child app both have to reach it without a Google
 * identity, so the checks in routes/tasks.js are the only thing between an
 * anonymous POST and the job running.
 *
 * What is pinned here is therefore the gate rather than the job: a Google-signed
 * token proves only that *some* Google identity called, which is close to no
 * proof at all, so the audience and the account's own address both have to be
 * checked and both have to be able to fail.
 */
const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: mockVerifyIdToken })),
}));

const mockRunOnce = jest.fn();
jest.mock('../src/jobs/safetyAnalysis', () => ({
  ...jest.requireActual('../src/jobs/safetyAnalysis'),
  runOnce: (...args) => mockRunOnce(...args),
}));

const request = require('supertest');
const { app } = require('../src/app');
const { env } = require('../src/config/env');

const SCHEDULER = 'parentix-test-scheduler@parentix-test.iam.gserviceaccount.com';
const AUDIENCE = 'https://parentix-test-tasks';

const post = (token) => {
  const req = request(app).post('/api/tasks/safety-analysis').send({ source: 'cloud-scheduler' });
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

/** A verified OIDC payload shaped as one Cloud Scheduler's account produces. */
const tokenFrom = (overrides = {}) => {
  mockVerifyIdToken.mockResolvedValue({
    getPayload: () => ({
      email: SCHEDULER,
      email_verified: true,
      aud: AUDIENCE,
      iss: 'https://accounts.google.com',
      ...overrides,
    }),
  });
};

let originalAccount;
let originalAudience;

beforeAll(() => {
  originalAccount = env.jobs.schedulerServiceAccount;
  originalAudience = env.jobs.tasksAudience;
});

beforeEach(() => {
  mockVerifyIdToken.mockReset();
  mockRunOnce.mockReset().mockResolvedValue(undefined);
  env.jobs.schedulerServiceAccount = SCHEDULER;
  env.jobs.tasksAudience = AUDIENCE;
});

afterAll(() => {
  env.jobs.schedulerServiceAccount = originalAccount;
  env.jobs.tasksAudience = originalAudience;
});

describe('who is allowed to run a scheduled job', () => {
  it('runs the pass for the configured scheduler account', async () => {
    tokenFrom();

    const res = await post('a.scheduler.idtoken');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(mockRunOnce).toHaveBeenCalledTimes(1);
  });

  it('checks the token against the configured audience', async () => {
    tokenFrom();

    await post('a.scheduler.idtoken');

    expect(mockVerifyIdToken).toHaveBeenCalledWith(
      expect.objectContaining({ idToken: 'a.scheduler.idtoken', audience: AUDIENCE })
    );
  });

  it('refuses an unauthenticated call', async () => {
    const res = await post();

    expect(res.status).toBe(401);
    expect(mockRunOnce).not.toHaveBeenCalled();
  });

  it('refuses a token that does not verify', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('Wrong recipient, payload audience != requiredAudience'));

    const res = await post('a.token.for.something.else');

    expect(res.status).toBe(401);
    expect(mockRunOnce).not.toHaveBeenCalled();
  });

  /**
   * The case the email check exists for. Any Google account can mint a valid
   * OIDC token; only this project's scheduler may run the job.
   */
  it('refuses a valid Google token from a different service account', async () => {
    tokenFrom({ email: 'someone-else@another-project.iam.gserviceaccount.com' });

    const res = await post('a.valid.but.foreign.idtoken');

    expect(res.status).toBe(403);
    expect(mockRunOnce).not.toHaveBeenCalled();
  });

  it('refuses a token whose address Google does not vouch for', async () => {
    tokenFrom({ email_verified: false });

    const res = await post('a.selfasserted.idtoken');

    expect(res.status).toBe(403);
    expect(mockRunOnce).not.toHaveBeenCalled();
  });

  /**
   * An unconfigured deployment cannot be satisfied by any caller, so it says so
   * rather than answering 401 and inviting a retry with other credentials — and,
   * more importantly, rather than defaulting to running the job for anyone.
   */
  it('answers 503 when no scheduler account is configured', async () => {
    env.jobs.schedulerServiceAccount = '';
    tokenFrom();

    const res = await post('a.scheduler.idtoken');

    expect(res.status).toBe(503);
    expect(mockRunOnce).not.toHaveBeenCalled();
  });
});

describe('reporting the outcome', () => {
  /**
   * Scheduler decides whether to retry from the status code, and its job history
   * is the only record that the hourly pass happened at all. A failure reported
   * as a success would be invisible twice over.
   */
  it('answers 500 when the pass throws, so Scheduler retries', async () => {
    tokenFrom();
    mockRunOnce.mockRejectedValue(new Error('database is down'));

    const res = await post('a.scheduler.idtoken');

    expect(res.status).toBe(500);
  });

  it('waits for the pass to finish before answering', async () => {
    tokenFrom();
    let finished = false;
    mockRunOnce.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => { finished = true; resolve(); }, 20))
    );

    const res = await post('a.scheduler.idtoken');

    expect(res.status).toBe(200);
    expect(finished).toBe(true);
  });
});
