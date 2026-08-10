/**
 * The API and the web apps are separate origins in every deployed environment —
 * Firebase Hosting serves the apps, Cloud Run serves this — so CORS is the only
 * thing standing between a parent's session and a page on someone else's domain.
 *
 * These assertions pin the two halves of that: a configured origin is echoed
 * back with credentials allowed, and anything else gets no allow header at all.
 * The second case used to have an escape hatch — an origin matching the request's
 * own Host was treated as allowed, so that the load balancer's same-origin
 * deployment worked without naming each hostname. Nothing is same-origin now,
 * and an unlisted host must fail at the browser rather than quietly work.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { env } = require('../src/config/env');

const ALLOWED = 'http://localhost:3000';

describe('CORS', () => {
  it('is configured with the origins under test', () => {
    expect(env.corsOrigins).toContain(ALLOWED);
  });

  it('echoes a configured origin and allows credentials', async () => {
    const res = await request(app).get('/api/health').set('Origin', ALLOWED);

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('tolerates a trailing slash on the origin', async () => {
    const res = await request(app).get('/api/health').set('Origin', `${ALLOWED}/`);

    expect(res.headers['access-control-allow-origin']).toBe(`${ALLOWED}/`);
  });

  it('refuses an origin that is not on the allowlist', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example');

    // The request itself still succeeds — CORS is enforced by the browser, which
    // discards the response without this header.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not allow an origin just because it matches the request Host', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Host', 'evil.example')
      .set('Origin', 'https://evil.example');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight for a configured origin', async () => {
    const res = await request(app)
      .options('/api/auth/login')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');

    expect(res.status).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('leaves a caller that sends no Origin alone', async () => {
    // The child app and Stripe's webhook are not browsers and send none.
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
  });
});
