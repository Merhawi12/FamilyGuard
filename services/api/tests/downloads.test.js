/**
 * The download endpoints — the only unauthenticated routes in the product whose
 * job is to be clicked from a marketing page.
 *
 * `DESKTOP_DOWNLOAD_BASE_URL` is read once, at require time, into a module-level
 * constant. That is deliberate in the source (a download button that depends on
 * a per-request env lookup is a button whose behaviour can change under a
 * running process), and it is why every test here resets the module registry
 * rather than assigning to `process.env` and calling the route again — which
 * would pass against a stale value and prove nothing.
 */
const request = require('supertest');

const ORIGINAL = process.env.DESKTOP_DOWNLOAD_BASE_URL;

/** A fresh app, with the download base set to whatever this test needs. */
const appWith = (baseUrl) => {
  jest.resetModules();
  if (baseUrl === undefined) delete process.env.DESKTOP_DOWNLOAD_BASE_URL;
  else process.env.DESKTOP_DOWNLOAD_BASE_URL = baseUrl;
  return require('../src/app').app;
};

afterAll(() => {
  jest.resetModules();
  if (ORIGINAL === undefined) delete process.env.DESKTOP_DOWNLOAD_BASE_URL;
  else process.env.DESKTOP_DOWNLOAD_BASE_URL = ORIGINAL;
});

const CDN = 'https://downloads.example.test';

describe('GET /api/downloads/child-desktop', () => {
  it('is public — the marketing page has no session', async () => {
    const res = await request(appWith(CDN)).get('/api/downloads/child-desktop');
    expect(res.status).toBe(200);
    expect(res.body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('gives the page a URL it can put on a button', async () => {
    const res = await request(appWith(CDN)).get('/api/downloads/child-desktop');
    const windows = res.body.platforms.windows;
    expect(windows.available).toBe(true);
    expect(windows.url).toBe(`${CDN}/child-desktop/win/${windows.file}`);
    // Offered, not required: the combined installer is the default precisely so
    // that a parent never has to identify their child's processor.
    expect(windows.variants.map((v) => v.arch)).toEqual(['x64', 'arm64']);
  });

  /*
   * The Mac agent has never been compiled — there is no Mac in the build chain.
   * Advertising a download for it would send a parent to a file that does not
   * exist, and "the download is broken" is indistinguishable from "the product
   * is broken" from where they are standing.
   */
  it('does not offer an installer that has never been built', async () => {
    const res = await request(appWith(CDN)).get('/api/downloads/child-desktop');
    expect(res.body.platforms.mac.available).toBe(false);
    expect(res.body.platforms.mac.url).toBeNull();
    expect(res.body.platforms.mac.reason).toMatch(/not been published/i);
  });

  /*
   * The reason `familyIsolation.test.js` is allowed to skip this prefix in its
   * "a device token is not a parent credential" sweep: there is nothing here
   * that could differ per caller, so reaching it with any credential — or none
   * — reveals nothing. Asserted rather than argued.
   */
  it('answers identically to anyone, with nothing account-shaped in it', async () => {
    const app = appWith(CDN);
    const anonymous = await request(app).get('/api/downloads/child-desktop');
    const withGarbage = await request(app)
      .get('/api/downloads/child-desktop')
      .set('Authorization', 'Bearer not-a-real-token');

    expect(withGarbage.status).toBe(200);
    expect(withGarbage.body).toEqual(anonymous.body);
    expect(JSON.stringify(anonymous.body)).not.toMatch(/email|childId|parentId|deviceId|token/i);
  });

  /*
   * "Unavailable" has two causes that fail for different reasons — nothing was
   * ever built for this platform, or this deployment has nowhere to serve from —
   * and a page cannot tell them apart. Both get a sentence, so the page never
   * has to invent one.
   */
  it('reports itself unconfigured rather than inventing a host', async () => {
    const res = await request(appWith(undefined)).get('/api/downloads/child-desktop');
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.platforms.windows.available).toBe(false);
    expect(res.body.platforms.windows.url).toBeNull();
    expect(res.body.platforms.windows.reason).toMatch(/not available/i);
  });

  it('gives every unavailable platform something true to say', async () => {
    for (const base of [CDN, undefined]) {
      const res = await request(appWith(base)).get('/api/downloads/child-desktop');
      for (const entry of Object.values(res.body.platforms)) {
        if (entry.available) expect(entry.reason).toBeUndefined();
        else expect(entry.reason).toEqual(expect.stringMatching(/\S/));
      }
    }
  });
});

describe('GET /api/downloads/child-desktop/:platform', () => {
  it('redirects to the installer rather than proxying it', async () => {
    const res = await request(appWith(CDN)).get('/api/downloads/child-desktop/windows');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${CDN}/child-desktop/win/Parentix-Setup-1.0.0.exe`);
  });

  /*
   * 302 and `no-store`, not 301. The target names a version, so a permanent
   * redirect would have browsers pinning the *next* release's button to this
   * release's file — cached somewhere neither we nor the parent can clear.
   */
  it('does not let a browser cache which file is current', async () => {
    const res = await request(appWith(CDN)).get('/api/downloads/child-desktop/windows');
    expect(res.status).toBe(302);
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('serves a smaller build when one is asked for by name', async () => {
    const res = await request(appWith(CDN)).get('/api/downloads/child-desktop/windows?arch=arm64');
    expect(res.headers.location).toBe(`${CDN}/child-desktop/win/Parentix-Setup-1.0.0-arm64.exe`);
  });

  it('refuses an architecture it has no build for', async () => {
    const res = await request(appWith(CDN)).get('/api/downloads/child-desktop/windows?arch=riscv');
    expect(res.status).toBe(404);
  });

  it('404s an unknown platform', async () => {
    const res = await request(appWith(CDN)).get('/api/downloads/child-desktop/atari');
    expect(res.status).toBe(404);
  });

  /*
   * The important one. An unconfigured deployment must answer with an error the
   * page can read out, because the alternative — redirecting to a URL that 404s
   * — is a broken 190 MB download, and a parent has no way to tell that from a
   * corrupt file. They try again, and it fails the same way.
   */
  it('answers 503 rather than redirecting into nowhere', async () => {
    const res = await request(appWith(undefined)).get('/api/downloads/child-desktop/windows');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it('answers 503 for a platform that has no build yet', async () => {
    const res = await request(appWith(CDN)).get('/api/downloads/child-desktop/mac');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not been published/i);
  });
});

describe('GET /api/downloads/child-desktop/:platform/feed', () => {
  /*
   * The feed is the directory, not a file: electron-updater appends `latest.yml`
   * itself. Publishing a release is then a matter of writing files into that
   * directory, with nothing to be told about it afterwards.
   */
  it('names the directory the updater reads, with a trailing slash', async () => {
    const res = await request(appWith(CDN)).get('/api/downloads/child-desktop/windows/feed');
    expect(res.status).toBe(200);
    expect(res.body.feedUrl).toBe(`${CDN}/child-desktop/win/`);
  });

  it('is unavailable rather than wrong when downloads are not configured', async () => {
    const res = await request(appWith(undefined)).get('/api/downloads/child-desktop/windows/feed');
    expect(res.status).toBe(503);
  });
});
