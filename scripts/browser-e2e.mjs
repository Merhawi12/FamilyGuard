#!/usr/bin/env node
/**
 * Runtime verification of the two web apps.
 *
 * `npm run build` proves the bundles compile; it says nothing about whether a
 * page renders, whether a flow completes, or whether the client and server
 * agree. This boots the real API, serves both `dist/` folders behind a proxy
 * that reproduces the production load-balancer behaviour, and drives Chromium
 * through the actual user journeys while recording every console error, page
 * exception and failed request.
 *
 * Everything else in the repo tests the API. This is the only check that runs
 * the front ends at all, so a page that throws on mount fails here and nowhere
 * else.
 *
 *   npm run build && npm run test:browser
 *
 * Set BROWSER_E2E_DATABASE_URL to a throwaway Postgres to run the same journeys
 * against the engine Cloud SQL uses; it defaults to a temporary SQLite file.
 *
 * Set BROWSER_E2E_SHOTS to a directory to also write a full-page screenshot of
 * every phone screen into it. The assertions below catch overflow and unhittable
 * controls; they cannot tell you whether the result looks right, and a layout
 * review is a great deal faster over thirteen PNGs than thirteen page loads.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = 5311;
const FAMILY_PORT = 5312;
const ADMIN_PORT = 5313;
const API_BASE = `http://127.0.0.1:${API_PORT}`;

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  \u2713 ${name}`); }
  else { failures.push(`${name}${detail ? ` \u2014 ${detail}` : ''}`); console.log(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`); }
};
const step = (t) => console.log(`\n${t}`);

// ── API ──────────────────────────────────────────────────────────────────────
const dataDir = mkdtempSync(path.join(tmpdir(), 'parentix-browser-'));
let serverOutput = '';

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: path.join(REPO, 'services/api'),
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(API_PORT),
    LOG_LEVEL: 'warn',
    DATABASE_URL: process.env.BROWSER_E2E_DATABASE_URL || '',
    DB_PATH: path.join(dataDir, 'browser.sqlite'),
    JWT_SECRET: 'browser-e2e-secret-that-is-long-enough',
    FIELD_ENCRYPTION_KEY: 'b'.repeat(64),
    CLIENT_URL: `http://127.0.0.1:${FAMILY_PORT}`,
    ADMIN_URL: `http://127.0.0.1:${ADMIN_PORT}`,
    EMAIL_PROVIDER: 'none',
    STORAGE_PROVIDER: 'none',
    STRIPE_SECRET_KEY: '',
    REDIS_URL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (c) => { serverOutput += c; });
server.stderr.on('data', (c) => { serverOutput += c; });

const waitForPort = async (port, label) => {
  for (let i = 0; i < 200; i += 1) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${label} never came up on ${port}\n${serverOutput}`);
};

// ── Static hosting that mirrors the production load balancer ─────────────────
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain', '.woff2': 'font/woff2',
};

/**
 * A connection the browser walked away from is not a test failure.
 *
 * Chromium aborts in-flight requests whenever it navigates, and an aborted
 * socket raises `ECONNRESET` on whichever stream noticed first. Nothing here
 * listened for that, so Node's default kicked in and threw an unhandled `error`
 * event — killing the entire harness mid-run, several hundred assertions in,
 * with a stack trace pointing at `TCP.onStreamRead` and nothing about the app.
 *
 * It survived a long time because it is a race and in-memory SQLite is fast
 * enough to usually win it. Pointing the same run at Postgres — which is what
 * production uses — made the window wide enough to lose, and the suite that
 * exists to catch regressions became the thing that could not finish.
 */
const ignoreAbort = (stream) => stream.on('error', () => {});

const proxyToApi = (req, res) => {
  ignoreAbort(req);
  ignoreAbort(res);

  const proxied = http.request(
    { host: '127.0.0.1', port: API_PORT, path: req.url, method: req.method, headers: req.headers },
    (upstream) => {
      ignoreAbort(upstream);
      // Headers may already be out if the client vanished and something else
      // ended the response first; writing them again throws.
      if (!res.headersSent) res.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(res);
    },
  );
  proxied.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('bad gateway');
  });
  req.pipe(proxied);
};

/**
 * Serves a built app the way Firebase Hosting does: a static file if one exists
 * at the request path, otherwise the first matching rewrite. Keeping the order
 * (static before rewrite) is the point — it is what decides whether `/` is the
 * marketing page or the SPA shell, and getting it wrong here would hide the
 * mistake that firebase.json exists to avoid.
 *
 * @param {string} dist  the built app to serve
 * @param {number} port
 * @param {boolean} landingAtRoot  the family app answers `/` with the static
 *                                 marketing page and `/contact` with its own
 *                                 page, and its SPA shell is app.html; the
 *                                 console is a plain SPA rooted at index.html
 */
const serveApp = (dist, port, landingAtRoot) => {
  const shell = landingAtRoot ? '/app.html' : '/index.html';

  /**
   * Refuse a `dist` that is not the shape this harness serves.
   *
   * These folders are built by whatever ran last, and `npm run apk:family`
   * legitimately rebuilds the family app in its Capacitor shape — SPA shell
   * kept as `index.html`, no `app.html` — because the WebView has no rewrite
   * layer. Serving that here produced a 404 for every route and then a
   * 30-second Playwright timeout on a missing input, which reads as "the login
   * page is broken" rather than "you are testing the wrong bundle". Same
   * assertion `scripts/deploy-web.sh` makes before publishing, for the same
   * reason: the failure is silent and the symptom points somewhere else.
   */
  if (!existsSync(path.join(dist, shell.slice(1)))) {
    const hint = landingAtRoot && existsSync(path.join(dist, 'index.html'))
      ? ' — this looks like a Capacitor build (npm run apk:family).'
      : '';
    throw new Error(
      `${dist} has no ${shell.slice(1)}${hint}\nRebuild the web bundles first: npm run build`
    );
  }

  /**
   * Refuse a `dist` built for production, for the same reason and with the same
   * symptom as the shape check above.
   *
   * `VITE_API_URL` is inlined at build time. A deploy build bakes in
   * `https://api.parentix.ca`, so a bundle served here sends every call to the
   * real production API from `http://127.0.0.1` — which CORS correctly refuses.
   * What that looks like from the outside is four unrelated assertions failing
   * (no Phone tab, login never reaches the dashboard, "the sign-in page is not
   * clean") followed by a 30-second timeout, none of which mention the build.
   *
   * The harness needs the same-origin bundle, because the proxy in front of it
   * is what serves `/api`. One grep of the entry chunk turns a confusing cascade
   * into a sentence naming the cause.
   */
  const entry = readdirSync(path.join(dist, 'assets')).find((f) => /^index-.*\.js$/.test(f));
  if (entry) {
    const code = readFileSync(path.join(dist, 'assets', entry), 'utf8');
    const origin = code.match(/https:\/\/api\.[a-z0-9.-]+/i);
    if (origin) {
      throw new Error(
        `${dist} was built against ${origin[0]} — this harness serves /api itself, so a bundle `
        + 'pinned to a remote origin fails every call on CORS.\n'
        + 'Rebuild without VITE_API_URL: npm run build'
      );
    }
  }
  const rewrites = landingAtRoot
    ? [['/', '/landing.html'], ['/contact', '/contact.html'], ['**', shell]]
    : [['**', shell]];

  const srv = http.createServer((req, res) => {
    // Same reason as the proxy above: a navigation can abort a static asset
    // mid-write, and an unhandled reset here took the whole run down with it.
    ignoreAbort(req);
    ignoreAbort(res);

    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;

    if (pathname.startsWith('/api') || pathname.startsWith('/socket.io')) return proxyToApi(req, res);

    const asFile = (p) => {
      const f = path.join(dist, p);
      return existsSync(f) && statSync(f).isFile() ? f : null;
    };

    let file = asFile(pathname);
    if (!file) {
      const match = rewrites.find(([source]) => source === '**' || source === pathname);
      if (match) file = asFile(match[1]);
    }
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }

    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });

  // Socket.IO's websocket upgrade has to be forwarded at the raw socket level.
  srv.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(API_PORT, '127.0.0.1', () => {
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n` +
        Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
        '\r\n\r\n',
      );
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
  });

  return new Promise((resolve) => guardServer(srv).listen(port, '127.0.0.1', () => resolve(srv)));
};

const api = async (method, p, { token, body } = {}) => {
  const res = await fetch(`${API_BASE}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
};

/**
 * Console noise that is about this machine rather than about the page.
 *
 * A Google Maps *browser* key is public by design — it ships in the bundle — so
 * the only thing protecting it is an HTTP-referrer allowlist naming the
 * production hostnames. A correctly restricted key therefore refuses
 * `http://127.0.0.1:5312` with `RefererNotAllowedMapError`, which made the
 * Location page fail here for three checks on every developer who had a real
 * key in `apps/family-app/.env` and pass for everyone who did not. That is the
 * harness grading the key's restrictions, not the product, and it graded the
 * *safer* configuration as broken.
 *
 * Only these two are forgiven, and only these two: the page's own behaviour
 * without a usable key — the `mapsKeyMissing` notice in Location.jsx — is still
 * rendered and still asserted.
 */
const ENVIRONMENTAL_CONSOLE_NOISE = [
  'RefererNotAllowedMapError',
  'InvalidKeyMapError',
];

/**
 * How a page says *it* fell over, as opposed to something on it.
 *
 * This used to test for "Something went wrong", which is the first line of the
 * shared ErrorBoundary — and also, word for word, the first line of the overlay
 * Google paints inside the map container when it refuses a key. So the Location
 * page failed here with nothing wrong: the sidebar, the current-position card,
 * the safe-zone panel and the empty-state notice all rendered, and one third of
 * one card said "Oops! Something went wrong." because a browser key restricted
 * to production hostnames will not serve a map to 127.0.0.1.
 *
 * The second sentence of the boundary is ours alone, so matching that asks the
 * question the check meant to ask: did the app replace this page with the
 * failure panel?
 */
const CRASHED = 'An unexpected error occurred';

/** Everything a page did wrong, collected so a silent failure cannot pass. */
const watch = (page, label) => {
  const problems = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (ENVIRONMENTAL_CONSOLE_NOISE.some((n) => text.includes(n))) return;
    problems.push(`console: ${text}`);
  });
  page.on('pageerror', (e) => problems.push(`exception: ${e.message}`));
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText || '';
    if (!why.includes('ERR_ABORTED')) problems.push(`request failed: ${r.url()} (${why})`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('favicon')) problems.push(`HTTP ${r.status()} ${r.url()}`);
  });
  return { label, problems };
};

/**
 * A malformed or half-closed connection reaches the server as `clientError`
 * rather than as an error on a request, and that path has the same default:
 * throw, and take the run with it.
 */
const guardServer = (srv) => {
  srv.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    else socket.destroy();
  });
  return srv;
};

let browser; let familySrv; let adminSrv;
const shutdown = () => {
  try { browser?.close(); } catch { /* already gone */ }
  try { familySrv?.close(); adminSrv?.close(); } catch { /* already gone */ }
  server.kill('SIGTERM');
  setTimeout(() => server.kill('SIGKILL'), 2000).unref();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows lock */ }
};

try {
  await waitForPort(API_PORT, 'API');
  familySrv = await serveApp(path.join(REPO, 'apps/family-app/dist'), FAMILY_PORT, true);
  adminSrv = await serveApp(path.join(REPO, 'apps/admin-dashboard/dist'), ADMIN_PORT, false);

  const FAMILY = `http://127.0.0.1:${FAMILY_PORT}`;
  const ADMIN = `http://127.0.0.1:${ADMIN_PORT}`;

  browser = await chromium.launch();

  // ── Fixtures via the API, so the browser starts from a real account ───────
  const stamp = Date.now();
  // Unique per run so the assertion cannot match a row left by an earlier run
  // when this points at a database that is not wiped in between.
  const SEEDED_ALERT = `Emergency button pressed before this session (${stamp})`;
  const PARENT_EMAIL = `Parent.Case${stamp}@Example.COM`; // deliberately mixed case
  const PARENT_PASSWORD = 'password123';

  const reg = await api('POST', '/auth/register', {
    body: { name: 'Browser Parent', email: PARENT_EMAIL, password: PARENT_PASSWORD },
  });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg)}`);

  // Verification codes are emailed; with EMAIL_PROVIDER=none, read it from the DB.
  // Resolved from the API's own node_modules — the harness reads fixtures
  // (verification codes, seeded alerts) directly, and the root workspace does
  // not depend on Sequelize.
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(REPO, 'services/api/package.json'));
  const { Sequelize } = require('sequelize');
  // Fixtures are read straight from the database the API is actually using, so
  // this harness runs unchanged against SQLite and against Cloud SQL's engine.
  const PG_URL = process.env.BROWSER_E2E_DATABASE_URL;
  const db = PG_URL
    ? new Sequelize(PG_URL, { logging: false, dialectOptions: { ssl: false } })
    : new Sequelize({ dialect: 'sqlite', storage: path.join(dataDir, 'browser.sqlite'), logging: false });
  const NOW = PG_URL ? 'now()' : "datetime('now')";
  const FALSE = PG_URL ? 'false' : '0';
  const [[row]] = await db.query('SELECT email, email_verification_code AS code FROM users ORDER BY created_at DESC LIMIT 1');

  step('Account setup');
  check('the registered address is stored lower-cased', row.email === PARENT_EMAIL.trim().toLowerCase(), row.email);

  const verified = await api('POST', '/auth/verify-email', { body: { email: PARENT_EMAIL, code: row.code } });
  check('email verification succeeds', verified.status === 200, JSON.stringify(verified.data));
  const parentToken = verified.data.token;

  const child = await api('POST', '/children', { token: parentToken, body: { name: 'Sam', age: 11 } });
  check('a child profile is created', child.status === 201, JSON.stringify(child.data));

  // An unread alert that predates the browser session — the bell must show it.
  // The id is generated per run: a fixed one collides on the second run against
  // a database that is not thrown away between runs.
  const alertId = randomUUID();
  await db.query(
    `INSERT INTO alerts (id, parent_id, child_id, type, message, severity, is_read, created_at, updated_at)
     VALUES (?, (SELECT id FROM users WHERE email = ?), ?, 'emergency_button',
             ?, 'high', ${FALSE}, ${NOW}, ${NOW})`,
    { replacements: [alertId, row.email, child.data.id, SEEDED_ALERT] },
  );

  const staffEmail = `Ops.Person${stamp}@Parentix.CA`;
  await db.query(
    `UPDATE users SET role = 'super_admin' WHERE email = ?`, { replacements: [row.email] },
  );

  // ── Family app ────────────────────────────────────────────────────────────
  step('Family app — marketing site');
  {
    const page = await browser.newPage();
    const w = watch(page, 'landing');
    await page.goto(FAMILY, { waitUntil: 'networkidle' });
    const title = await page.title();
    check('the landing page renders', (await page.locator('body').innerText()).length > 200, title);
    check('the landing page is clean', w.problems.length === 0, w.problems.join(' | '));
    await page.close();
  }

  step('Family app — sign in with the address as typed');
  let familyPage;
  {
    familyPage = await browser.newPage();
    const w = watch(familyPage, 'login');
    await familyPage.goto(`${FAMILY}/login`, { waitUntil: 'networkidle' });

    /*
     * The tab follows `GET /auth/providers` the way the Google button does.
     *
     * What that reports is whether the flow can be *finished*, not whether an
     * SMS can be sent — and the difference is why this once asserted the
     * opposite. Gating it on deliverability alone meant the tab was withheld
     * here, in development, and in every environment that existed: there were no
     * SMS credentials in `.env.example`, none in Terraform, and no TWILIO_* on
     * Cloud Run at all. Phone sign-in was unreachable everywhere while the whole
     * suite passed, and this check certified it.
     *
     * This run has no SMS credentials either. It gets the tab because the API
     * returns the code in the response outside production, which the journey
     * below then uses.
     */
    check('the Phone tab is offered where the code can be obtained',
      (await familyPage.getByRole('tab', { name: 'Phone' }).count()) === 1);

    await familyPage.fill('input[type="email"]', PARENT_EMAIL);
    await familyPage.fill('input[type="password"]', PARENT_PASSWORD);
    await familyPage.click('button[type="submit"]');
    await familyPage.waitForURL('**/dashboard**', { timeout: 15000 }).catch(() => {});

    check('login with mixed-case email reaches the dashboard',
      familyPage.url().includes('/dashboard'), familyPage.url());
    check('the sign-in page is clean', w.problems.length === 0, w.problems.join(' | '));
  }

  /*
   * Registering and signing in with nothing but a number, driven through the
   * browser rather than against the endpoints.
   *
   * The API tests already cover the controller. What they cannot see is the
   * half that was actually broken: a tab the page declined to draw, and a code
   * screen with no way to learn the code. Both live in the front end, and this
   * is the only check that runs it.
   *
   * The number is unique per run because it becomes a uniquely-indexed account.
   */
  step('Family app — register and sign in with a phone number');
  {
    const national = `415555${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const page = await browser.newPage();
    const w = watch(page, 'phone sign-in');
    await page.goto(`${FAMILY}/login`, { waitUntil: 'networkidle' });

    /** Reads the six digits off the code screen and submits them. */
    const enterCodeFromScreen = async (label) => {
      const shown = await page.locator('.notice-warning strong').first().textContent({ timeout: 15000 });
      const digits = (shown || '').replace(/\D/g, '');
      check(`${label}: the code is available to enter`, digits.length === 6, shown || '(none)');
      for (let i = 0; i < 6; i += 1) await page.fill(`#code-${i}`, digits[i]);
      await page.click('button[type="submit"]');
      await page.waitForURL('**/dashboard**', { timeout: 15000 }).catch(() => {});
    };

    // ── Register ──
    await page.getByRole('button', { name: 'Sign Up' }).click();
    await page.getByRole('tab', { name: 'Phone' }).click();
    await page.fill('input[autocomplete="name"]', 'Nadia Okafor');
    await page.fill('input[type="tel"]', national);
    await page.check('input[type="checkbox"]');
    await page.click('button[type="submit"]');

    // `waitFor`, not `isVisible`: the latter samples the DOM as it is now and
    // ignores a timeout, so it answered "no" before the request had returned.
    const reached = await page.locator('#code-0')
      .waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
    check('requesting a code reaches the verification screen', reached,
      reached ? '' : (await page.locator('form').innerText().catch(() => '(no form)')).replace(/\s+/g, ' ').slice(0, 200));

    await enterCodeFromScreen('register');
    check('a phone registration reaches the dashboard', page.url().includes('/dashboard'), page.url());

    // ── Log out, then back in on the same number ──
    await page.goto(`${FAMILY}/settings`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.evaluate(() => window.localStorage.clear());
    await page.goto(`${FAMILY}/login`, { waitUntil: 'networkidle' });

    check('clearing the session returns the visitor to sign in',
      page.url().includes('/login'), page.url());

    await page.getByRole('tab', { name: 'Phone' }).click();
    await page.fill('input[type="tel"]', national);
    await page.click('button[type="submit"]');
    await enterCodeFromScreen('sign in');

    check('signing in again with the same number reaches the dashboard',
      page.url().includes('/dashboard'), page.url());
    check('the phone sign-in screens are clean', w.problems.length === 0, w.problems.join(' | '));
    await page.close();
  }

  step('Family app — the alert bell reflects history, not just this session');
  {
    const badge = familyPage.locator('button[aria-label*="Alerts"]');
    await badge.waitFor({ timeout: 10000 });
    // The history loads over the network, so wait for the badge rather than
    // sampling it the instant the dashboard route paints.
    await familyPage.locator('button[aria-label*="unread"]').waitFor({ timeout: 10000 }).catch(() => {});
    const label = await badge.getAttribute('aria-label');
    check('the bell reports the pre-existing unread alert', /unread/.test(label || ''), label || '(none)');

    await badge.click();
    const panel = familyPage.locator(`text=${SEEDED_ALERT}`);
    check('the alert is listed in the bell', await panel.count() > 0);

    // Marking read must survive a reload — it used to be local state only.
    await panel.first().click();
    await familyPage.waitForTimeout(600);
    await familyPage.reload({ waitUntil: 'networkidle' });
    const after = await familyPage.locator('button[aria-label*="Alerts"]').getAttribute('aria-label');
    check('marking read is persisted across a reload', !/unread/.test(after || ''), after || '(none)');
  }

  step('Family app — every dashboard route renders');
  {
    const routes = [
      ['', 'Dashboard'], ['children', 'Children'], ['screen-time', 'Screen Time'],
      ['blocking', 'Blocking'], ['activity', 'Activity'], ['web-history', 'Web History'],
      ['reports', 'Reports'],
      ['alerts', 'Alerts'], ['location', 'Location'], ['messages', 'Messages'],
      ['contacts', 'Contacts'], ['settings', 'Settings'],
    ];
    for (const [route, label] of routes) {
      const page = await browser.newPage();
      await page.goto(`${FAMILY}/login`);
      await page.evaluate((t) => localStorage.setItem('fg_token', t), parentToken);
      const w = watch(page, label);
      await page.goto(`${FAMILY}/dashboard/${route}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      if (process.env.BROWSER_E2E_SHOTS) {
        mkdirSync(path.join(process.env.BROWSER_E2E_SHOTS, 'desktop'), { recursive: true });
        await page.screenshot({
          path: path.join(process.env.BROWSER_E2E_SHOTS, 'desktop', `${route || 'dashboard'}.png`),
        });
      }
      const text = await page.locator('body').innerText();
      const rendered = text.length > 40 && !text.includes(CRASHED);
      check(`${label} renders`, rendered, text.slice(0, 90).replace(/\n/g, ' '));
      check(`${label} has no runtime errors`, w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
      await page.close();
    }
  }

  /*
   * The introduction that runs before sign-in on a fresh install.
   *
   * Two things make it worth checking rather than eyeballing: it is the first
   * thing an installed app shows, so a throw here is a blank launch with no way
   * past it; and its whole contract is that it appears *once*. A splash that
   * forgets it has been seen is worse than no splash.
   */
  step('Family app — the introduction shows once and lets you out of it');
  {
    // Its own phone-sized page rather than the shared `phone` context, which is
    // not built until much later in this file — and a splash is a phone screen,
    // so checking it at 1280px wide would measure the wrong thing.
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    });
    await page.goto(`${FAMILY}/welcome`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    const w = watch(page, 'Welcome');
    const first = (await page.locator('h1').innerText()).trim();
    check('it opens on the brand card', first === 'Parentix', first);

    if (process.env.BROWSER_E2E_SHOTS) {
      mkdirSync(process.env.BROWSER_E2E_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.BROWSER_E2E_SHOTS, 'welcome.png'), fullPage: true });
    }

    // Every dot has to be reachable by a finger, which is the reason the 8px
    // indicator sits inside a 44px button rather than being one.
    const dots = page.locator('[role="tab"]');
    check('there is one dot per card', await dots.count() === 3, String(await dots.count()));
    const tooSmall = [];
    for (let i = 0; i < await dots.count(); i += 1) {
      const box = await dots.nth(i).boundingBox();
      if (!box || box.width < 44 || box.height < 44) tooSmall.push(`${Math.round(box?.width || 0)}x${Math.round(box?.height || 0)}`);
    }
    check('every dot is a 44px target', tooSmall.length === 0, tooSmall.join(', '));

    await dots.nth(2).click();
    await page.waitForTimeout(250);
    const third = (await page.locator('h1').innerText()).trim();
    check('the dots page the carousel', third !== 'Parentix' && third.length > 0, third);

    // The point of the screen: it must not be a toll gate.
    check('Get Started is offered from every card, not only the last',
      await page.locator('button:has-text("Get Started")').isVisible());
    await page.locator('button:has-text("Get Started")').click();
    await page.waitForURL(/\/login/, { timeout: 5000 }).catch(() => {});
    check('Get Started reaches sign-in', /\/login/.test(page.url()), page.url());

    // And having been through it once, a relaunch must not show it again.
    const seen = await page.evaluate(() => localStorage.getItem('px_welcome_seen'));
    check('finishing it is remembered, so it does not greet the parent twice', seen === '1', String(seen));

    check('the introduction has no runtime errors', w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await page.close();
  }

  /*
   * The third way the map can fail, which the page used to have no state for.
   *
   * A missing key is caught before loading, and a script that never arrives
   * shows up as `loadError`. But a key that is present, well-formed and live and
   * is then refused during authentication — the ordinary result of a browser key
   * whose referrer allowlist names the production hostnames, exactly as it
   * should — leaves `loadError` null and `isLoaded` true. The page believed the
   * map was fine while Google painted "Oops! Something went wrong." inside it,
   * and went on offering "Safe zone", which drops the parent into a mode whose
   * only instruction is to tap a map that is not there.
   *
   * Driven through `gm_authFailure` because that is exactly how Google reports
   * it, so no key is needed to exercise the behaviour and the check runs the
   * same whether or not this machine has one.
   */
  step('Family app — the Location page owns the failure when Google refuses the key');
  {
    const page = await browser.newPage();
    await page.goto(`${FAMILY}/login`);
    await page.evaluate((t) => localStorage.setItem('fg_token', t), parentToken);
    await page.goto(`${FAMILY}/dashboard/location`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);

    const hookInstalled = await page.evaluate(() => typeof window.gm_authFailure === 'function');
    check('the page registers Google’s auth-failure hook', hookInstalled);

    await page.evaluate(() => window.gm_authFailure());
    await page.waitForTimeout(300);

    const body = await page.locator('body').innerText();
    check(
      'it names the refusal itself rather than leaving Google’s overlay to explain it',
      /Google rejected the map key/i.test(body),
      body.slice(0, 120).replace(/\s+/g, ' '),
    );

    const zoneButton = page.locator('button:has-text("Safe zone")');
    const closedOff = (await zoneButton.count()) === 0 || await zoneButton.first().isDisabled();
    check('it stops offering to place a zone on a map that is not there', closedOff);

    await page.close();
  }

  // ── The two dashboards built on the new pipelines ─────────────────────────
  // Both check the same thing in the end: that what the parent sees in a real
  // browser matches what the device would actually be told over the API.
  step('Family app — Web History shows what the device reported');
  {
    const child = await api('POST', '/children', {
      token: parentToken, body: { name: 'Browser Kid', age: 12 },
    });
    const link = await api('POST', '/devices/link', {
      token: parentToken, body: { childId: child.data.id, deviceName: 'Browser Phone' },
    });
    const confirmed = await api('POST', '/devices/confirm', { body: { code: link.data.code } });
    const deviceToken = confirmed.data.deviceToken;
    check('a device links for the browser run', !!deviceToken);

    const now = Date.now();
    const reported = await api('POST', '/devices/me/web-history', {
      token: deviceToken,
      body: {
        visits: [
          { domain: 'khanacademy.org', firstSeen: now - 60_000, lastSeen: now, count: 3 },
          { domain: 'wikipedia.org', firstSeen: now - 30_000, lastSeen: now, count: 1 },
        ],
      },
    });
    check('the device reports two sites', reported.data?.created === 2, JSON.stringify(reported.data));

    const page = await browser.newPage();
    await page.goto(`${FAMILY}/login`);
    await page.evaluate((t) => localStorage.setItem('fg_token', t), parentToken);
    const w = watch(page, 'web-history');
    await page.goto(`${FAMILY}/dashboard/web-history`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);

    // The new child is not the default selection, so pick it the way a parent would.
    await page.locator('button:has-text("Browser Kid")').first().click().catch(() => {});
    await page.waitForTimeout(900);

    let text = await page.locator('body').innerText();
    check('the dashboard lists a site the device reported', text.includes('khanacademy.org'),
      text.slice(0, 140).replace(/\n/g, ' '));
    check('the repeat count is shown', text.includes('×3'), text.slice(0, 140).replace(/\n/g, ' '));

    // Search narrows to one site and back.
    await page.fill('input[type="search"]', 'khanacademy');
    await page.waitForTimeout(1200); // debounce + request
    text = await page.locator('body').innerText();
    check('search narrows the list', text.includes('khanacademy.org') && !text.includes('wikipedia.org'),
      text.slice(0, 140).replace(/\n/g, ' '));

    await page.fill('input[type="search"]', 'nothing-was-visited-here');
    await page.waitForTimeout(1200);
    text = await page.locator('body').innerText();
    check('a search with no matches shows an empty state, not an error',
      text.includes('Nothing matches those filters'), text.slice(0, 140).replace(/\n/g, ' '));

    check('the Web History page is clean', w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await page.close();

    // ── Contacts: the UI-vs-backend reality check ──────────────────────────
    step('Family app — an approval in the UI is real on the device');
    const contactPage = await browser.newPage();
    await contactPage.goto(`${FAMILY}/login`);
    await contactPage.evaluate((t) => localStorage.setItem('fg_token', t), parentToken);
    const cw = watch(contactPage, 'contacts');
    await contactPage.goto(`${FAMILY}/dashboard/contacts`, { waitUntil: 'networkidle' });
    await contactPage.waitForTimeout(700);

    await contactPage.locator('button:has-text("Browser Kid")').first().click().catch(() => {});
    await contactPage.waitForTimeout(500);

    await contactPage.click('button:has-text("Add contact")');
    // Scoped to the sheet's form: the labels are what a parent actually reads.
    const form = contactPage.locator('form');
    await form.locator('label:has-text("Name") input').fill('Browser Grandma');
    await form.locator('label:has-text("Phone number") input').fill('5551234567');
    await form.locator('button[type="submit"]').click();
    await contactPage.waitForTimeout(1000);

    let body = await contactPage.locator('body').innerText();
    check('the contact appears in the dashboard', body.includes('Browser Grandma'),
      body.slice(0, 140).replace(/\n/g, ' '));
    check('the dashboard shows it as approved', body.includes('Approved'));

    // The claim the UI is making, checked against what the device is actually told.
    let onDevice = await api('GET', '/devices/me/contacts', { token: deviceToken });
    check('the device is actually given the approved contact',
      onDevice.data.contacts.some((c) => c.name === 'Browser Grandma'),
      JSON.stringify(onDevice.data.contacts));

    // Now un-approve it in the UI and check the device stops being told about it.
    await contactPage.click('button:has-text("Approved")');
    await contactPage.waitForTimeout(1000);
    body = await contactPage.locator('body').innerText();
    check('the dashboard shows it as blocked', body.includes('Blocked'),
      body.slice(0, 140).replace(/\n/g, ' '));

    onDevice = await api('GET', '/devices/me/contacts', { token: deviceToken });
    check('the device stops being given the un-approved contact',
      !onDevice.data.contacts.some((c) => c.name === 'Browser Grandma'),
      JSON.stringify(onDevice.data.contacts));

    check('the Contacts page is clean', cw.problems.length === 0, cw.problems.slice(0, 2).join(' | '));
    await contactPage.close();
  }

  /**
   * The controls a parent buys the product for, driven through the browser and
   * then checked against what the child's phone is actually told.
   *
   * Everything above proves a page renders. None of it proved that setting a
   * rule on one of those pages reaches the device — which is where an entire
   * class of defect lived: the app-rule form accepted a rule with no package
   * name and offered two actions ("Allow only", "Limit time") that nothing
   * implemented, so a parent could set a control, see it listed as active, and
   * have nothing whatsoever happen on the phone.
   */
  step('Family app — a screen-time rule set in the UI reaches the device');
  let controlChildId;
  let controlDeviceToken;
  {
    const c = await api('POST', '/children', { token: parentToken, body: { name: 'Control Kid', age: 13 } });
    controlChildId = c.data.id;
    const link = await api('POST', '/devices/link', {
      token: parentToken, body: { childId: controlChildId, deviceName: 'Control Phone' },
    });
    const confirmed = await api('POST', '/devices/confirm', { body: { code: link.data.code } });
    controlDeviceToken = confirmed.data.deviceToken;
    check('a device links for the control run', !!controlDeviceToken);

    const page = await browser.newPage();
    await page.goto(`${FAMILY}/login`);
    await page.evaluate((t) => localStorage.setItem('fg_token', t), parentToken);
    const w = watch(page, 'screen-time');
    await page.goto(`${FAMILY}/dashboard/screen-time`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    await page.locator('button:has-text("Control Kid")').first().click().catch(() => {});
    await page.waitForTimeout(700);

    // The slider is the daily limit. Setting it through the DOM the way a drag
    // would: React listens for `input`.
    await page.locator('input[type="range"]').first().evaluate((el) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '180');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await page.locator('label:has-text("Bedtime lock") input[type="checkbox"], button:has-text("Bedtime lock")')
      .first().click().catch(() => {});
    await page.waitForTimeout(300);

    const shown = await page.locator('body').innerText();
    check('the daily limit reads back in hours and minutes', shown.includes('3h'),
      shown.slice(0, 160).replace(/\n/g, ' '));

    await page.click('button:has-text("Save changes")');
    await page.waitForTimeout(1000);
    const saved = await page.locator('body').innerText();
    check('the save is confirmed on screen', /saved/i.test(saved), saved.slice(0, 160).replace(/\n/g, ' '));

    // What the phone is told, which is the only thing that matters.
    const onDevice = await api('GET', '/devices/me/rules', { token: controlDeviceToken });
    check('the device is given the new daily limit',
      onDevice.data.screenTimeRule?.dailyLimitMinutes === 180,
      JSON.stringify(onDevice.data.screenTimeRule));

    check('the Screen Time page is clean', w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await page.close();
  }

  step('Family app — an app rule set in the UI reaches the device');
  {
    const page = await browser.newPage();
    await page.goto(`${FAMILY}/login`);
    await page.evaluate((t) => localStorage.setItem('fg_token', t), parentToken);
    const w = watch(page, 'blocking');
    await page.goto(`${FAMILY}/dashboard/blocking`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    await page.locator('button:has-text("Control Kid")').first().click().catch(() => {});
    await page.waitForTimeout(700);

    // Quick block: one tap, a known package.
    await page.click('button:has-text("TikTok")');
    await page.waitForTimeout(900);

    let body = await page.locator('body').innerText();
    check('the quick-blocked app is listed as an active rule', body.includes('com.zhiliaoapp.musically'),
      body.slice(0, 200).replace(/\n/g, ' '));

    let onDevice = await api('GET', '/devices/me/rules', { token: controlDeviceToken });
    check('the device is told to block it',
      onDevice.data.appRules.some((r) => r.appPackage === 'com.zhiliaoapp.musically' && r.action === 'block'),
      JSON.stringify(onDevice.data.appRules));

    /*
     * The custom form. The package field used to say "Optional" and the phone
     * matches on nothing else, so a rule saved without one was decoration — it
     * is now required, and the button stays disabled until it is filled in.
     */
    await page.fill('label:has-text("App name") input', 'Roblox');
    const blockedWithoutPackage = await page.locator('button:has-text("Add app rule")').isDisabled();
    check('a rule with no package name cannot be submitted', blockedWithoutPackage);

    await page.fill('label:has-text("Package name") input', 'com.roblox.client');
    await page.selectOption('label:has-text("Rule") select', 'limit');
    await page.waitForTimeout(300);

    const limitField = page.locator('label:has-text("Minutes per day") input');
    check('choosing a time limit asks for the number it needs', await limitField.count() === 1);
    await limitField.fill('45');

    await page.click('button:has-text("Add app rule")');
    await page.waitForTimeout(900);

    body = await page.locator('body').innerText();
    check('the limit rule is listed with its limit', body.includes('45m/day'),
      body.slice(0, 240).replace(/\n/g, ' '));

    onDevice = await api('GET', '/devices/me/rules', { token: controlDeviceToken });
    const limitRule = onDevice.data.appRules.find((r) => r.appPackage === 'com.roblox.client');
    check('the device is given the limit rule', limitRule?.action === 'limit',
      JSON.stringify(onDevice.data.appRules));
    check('the device is given the number to measure against', limitRule?.dailyLimitMinutes === 45,
      JSON.stringify(limitRule));

    /*
     * The action that never existed is no longer offered — for apps. Scoped to
     * the app card on purpose: the Websites column has its own "Rule" select and
     * "Allow only (whitelist)" is real there, because `utils/contentPolicy`
     * folds an allow into the domain lists the device is handed. An unscoped
     * selector matched both and read the working feature as the broken one.
     */
    const appCard = page.locator('.card').filter({ hasText: 'Custom app rule' });
    const actions = await appCard.locator('label:has-text("Rule") select option').allInnerTexts();
    check('the unimplemented "allow only" action is gone from the app form',
      actions.length > 0 && !actions.some((a) => /allow/i.test(a)), actions.join(', '));

    const siteCard = page.locator('.card').filter({ hasText: 'Block a specific site' });
    const siteActions = await siteCard.locator('label:has-text("Rule") select option').allInnerTexts();
    check('website whitelisting, which is implemented, is still offered',
      siteActions.some((a) => /allow/i.test(a)), siteActions.join(', '));

    check('the Blocking page is clean', w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await page.close();
  }

  step('Family app — a child\'s details can be corrected after the fact');
  {
    const page = await browser.newPage();
    await page.goto(`${FAMILY}/login`);
    await page.evaluate((t) => localStorage.setItem('fg_token', t), parentToken);
    const w = watch(page, 'children');
    await page.goto(`${FAMILY}/dashboard/children`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    // Renaming was impossible: the only lever was deleting the child, which
    // unlinks their devices and takes their history with it.
    await page.click('button[aria-label="Edit Control Kid"]');
    await page.waitForTimeout(400);
    const form = page.locator('form').filter({ has: page.locator('button:has-text("Save changes")') });
    await form.locator('label:has-text("Name") input').fill('Renamed Kid');
    await form.locator('label:has-text("Age") input').fill('15');
    await form.locator('button:has-text("Save changes")').click();
    await page.waitForTimeout(1000);

    const body = await page.locator('body').innerText();
    check('the new name is shown', body.includes('Renamed Kid'), body.slice(0, 200).replace(/\n/g, ' '));
    check('the new age is shown', body.includes('Age 15'), body.slice(0, 200).replace(/\n/g, ' '));

    const list = await api('GET', '/children', { token: parentToken });
    const updated = list.data.find((c) => c.id === controlChildId);
    check('the change is persisted, not just rendered', updated?.name === 'Renamed Kid' && updated?.age === 15,
      JSON.stringify({ name: updated?.name, age: updated?.age }));

    // The device it is linked to survives the edit — the reason a rename had to
    // stop being a delete-and-recreate.
    const stillLinked = await api('GET', '/devices/me/rules', { token: controlDeviceToken });
    check('the linked device is untouched by the rename', stillLinked.status === 200);

    // Only the platform that has a client can be linked — and because that is
    // exactly one, the sheet states it rather than offering a dropdown whose
    // only option is the one already selected.
    await page.click('button:has-text("Link device")');
    await page.waitForTimeout(400);
    const typeSelects = await page.locator('label:has-text("Device type") select').count();
    const linkForm = (await page.locator('form:has(button:has-text("Generate code"))').innerText()).replace(/\s+/g, ' ');
    check('the one supported platform is stated, not offered as a single-option dropdown',
      typeSelects === 0 && /android phone or tablet/i.test(linkForm), `selects=${typeSelects} · ${linkForm.slice(0, 90)}`);

    /*
     * Typed rather than filled, which is the entire point of these four lines.
     *
     * `fill()` sets the value in one assignment and would have gone on passing
     * throughout: the bug only appears between keystrokes. Modal's focus effect
     * listed `onClose` in its dependency array, and every caller passes a fresh
     * function identity on each render — so each character re-ran it and pulled
     * focus to the first focusable element, the ✕ in the header. The first
     * character landed, the rest went nowhere, and the space in a name like
     * "Sarah's Phone" activated that button and closed the sheet with the work
     * inside it.
     */
    const deviceNameField = page.locator('label:has-text("Device name") input');
    await deviceNameField.click();
    await page.keyboard.type("Sarah's Phone", { delay: 15 });
    const typedValue = await deviceNameField.inputValue();
    check('every character of a typed device name reaches the field', typedValue === "Sarah's Phone", typedValue);
    check('a name containing a space does not close the sheet',
      await page.locator('[role="dialog"]').count() > 0);

    /*
     * The sheet has to notice the phone.
     *
     * It handed out a code and then knew nothing more: the parent — who is
     * normally holding the child's phone while they type — watched a code that
     * had already been redeemed, and only learned it worked by closing the sheet,
     * which is what triggered the reload. The confirm below stands in for the
     * child app; nothing else on this page is touched, so a sheet that changes
     * can only have changed because the socket told it to.
     */
    await page.locator('label:has-text("Device name") input').fill('Watched Phone');
    await page.click('button:has-text("Generate code")');
    await page.waitForTimeout(900);

    const codeShown = (await page.locator('p.font-mono').first().innerText()).trim();
    check('the sheet shows a code', /^[0-9A-F]{8}$/.test(codeShown), codeShown);

    const confirmed = await api('POST', '/devices/confirm', {
      body: { code: codeShown, osVersion: 'Android 14' },
    });
    check('the stand-in phone can redeem it', confirmed.status === 200, JSON.stringify(confirmed.data));

    await page.waitForTimeout(1200);
    const afterLink = await page.locator('body').innerText();
    check('the open sheet says the device connected, with no reload',
      /Watched Phone is connected/.test(afterLink), afterLink.slice(0, 300).replace(/\n/g, ' '));
    check('the code is no longer the thing on screen', !afterLink.includes(codeShown),
      afterLink.slice(0, 200).replace(/\n/g, ' '));

    await page.click('button:has-text("Done")');
    await page.waitForTimeout(800);
    const listBody = await page.locator('body').innerText();
    check('the new device is in the list behind it', listBody.includes('Watched Phone'),
      listBody.slice(0, 300).replace(/\n/g, ' '));
    check('it is not shown as still waiting to be connected',
      !/Watched Phone[\s\S]{0,80}Waiting to be connected/.test(listBody),
      listBody.slice(0, 300).replace(/\n/g, ' '));

    check('the Children page is clean', w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await page.close();
  }

  step('Family app — the weekly report averages over the days it actually has');
  {
    /*
     * The average was the week's total divided by seven, always. A family whose
     * phone had reported for one day saw that day's usage shown as a "daily
     * average" one seventh its real size — understating screen time by up to 7×
     * exactly when an account is newest.
     */
    /*
     * Two hours ago, not "today at 09:00Z".
     *
     * The weekly report selects `startTime BETWEEN <six days ago> AND <now>`, and
     * a UTC calendar date is not today everywhere: run this after local midnight
     * in a western timezone and `new Date().toISOString()` already names
     * tomorrow, so 09:00Z on it is in the *future* and the report — correctly —
     * finds nothing. A relative offset is inside the window whenever it runs.
     */
    const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const logged = await api('POST', '/devices/me/activity', {
      token: controlDeviceToken,
      body: {
        appName: 'Report App', appPackage: 'com.example.report', category: 'app_usage',
        durationMinutes: 140,
        startTime: startedAt.toISOString(),
        endTime: new Date(startedAt.getTime() + 140 * 60 * 1000).toISOString(),
      },
    });
    check('one day of usage is recorded', logged.status < 300, JSON.stringify(logged.data));

    const page = await browser.newPage();
    await page.goto(`${FAMILY}/login`);
    await page.evaluate((t) => localStorage.setItem('fg_token', t), parentToken);
    const w = watch(page, 'reports');
    await page.goto(`${FAMILY}/dashboard/reports`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await page.locator('button:has-text("Renamed Kid")').first().click().catch(() => {});
    await page.waitForTimeout(900);

    const body = await page.locator('body').innerText();
    // 140 minutes on one day: the week total and the average are the same
    // number, and the label says why rather than quietly dividing by seven.
    check('the average is not divided by days that were never recorded',
      body.includes('On the one day recorded'), body.slice(0, 300).replace(/\n/g, ' '));
    check('the average equals the only day there is',
      (body.match(/2\.3h/g) || []).length >= 2, body.slice(0, 300).replace(/\n/g, ' '));

    check('the Reports page is clean', w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await page.close();
  }

  step('Family app — signed-in devices can be seen and signed out');
  {
    // A second session for this account, so there is something to evict.
    const other = await api('POST', '/auth/login', {
      body: { email: PARENT_EMAIL, password: PARENT_PASSWORD },
    });
    check('a second session exists to sign out', !!other.data.token);

    const page = await browser.newPage();
    await page.goto(`${FAMILY}/login`);
    await page.evaluate((t) => localStorage.setItem('fg_token', t), parentToken);
    const w = watch(page, 'sessions');
    await page.goto(`${FAMILY}/dashboard/settings`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    let body = await page.locator('body').innerText();
    check('the security section lists signed-in devices', body.includes('Signed-in devices'),
      body.slice(0, 200).replace(/\n/g, ' '));

    await page.click('button:has-text("Sign out others")');
    await page.waitForTimeout(1200);

    body = await page.locator('body').innerText();
    check('the parent is told how many were signed out', /Signed out \d+ other device/.test(body),
      body.slice(0, 300).replace(/\n/g, ' '));

    // The claim is checked against the token it says it killed.
    const dead = await api('GET', '/auth/me', { token: other.data.token });
    check('the other session really stopped working', dead.status === 401, String(dead.status));

    check('the Settings security section is clean', w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await page.close();
  }

  step('Family app — an account can be closed from inside the app');
  {
    /*
     * There was no way out of the product at all: no endpoint, no button. For a
     * service holding a child's location history that is a legal problem before
     * it is a missing feature, and Google Play requires an in-app route to it.
     *
     * A throwaway account, because this one really does delete everything.
     */
    const email = `Leaving.Parent${stamp}@Example.COM`;
    await api('POST', '/auth/register', { body: { name: 'Leaving Parent', email, password: PARENT_PASSWORD } });
    const [[leaving]] = await db.query(
      'SELECT email, email_verification_code AS code FROM users WHERE email = ?',
      { replacements: [email.trim().toLowerCase()] },
    );
    const verified2 = await api('POST', '/auth/verify-email', { body: { email, code: leaving.code } });
    const leavingToken = verified2.data.token;
    const leavingChild = await api('POST', '/children', {
      token: leavingToken, body: { name: 'Leaving Kid', age: 9 },
    });
    check('the departing account has a child to erase', leavingChild.status === 201);

    const page = await browser.newPage();
    await page.goto(`${FAMILY}/login`);
    await page.evaluate((t) => localStorage.setItem('fg_token', t), leavingToken);
    const w = watch(page, 'delete-account');
    await page.goto(`${FAMILY}/dashboard/settings`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    await page.click('button:has-text("Delete account")');
    await page.waitForTimeout(400);

    const body = await page.locator('body').innerText();
    check('the dialog says what will be destroyed', /child profile/i.test(body) && /cannot be undone/i.test(body),
      body.slice(0, 300).replace(/\n/g, ' '));

    const confirmButton = page.locator('button:has-text("Delete my account for good")');
    check('the confirm button is inert until the password is given', await confirmButton.isDisabled());

    await page.locator('label:has-text("Confirm your password") input').fill(PARENT_PASSWORD);
    await confirmButton.click();
    await page.waitForTimeout(2000);

    check('the browser is returned to the sign-in page', page.url().includes('/login'), page.url());

    const gone = await api('GET', '/auth/me', { token: leavingToken });
    check('the session is dead', gone.status === 401, String(gone.status));

    const [rows] = await db.query('SELECT COUNT(*) AS n FROM users WHERE email = ?', {
      replacements: [email.trim().toLowerCase()],
    });
    check('the account row is gone', Number(rows[0].n) === 0, JSON.stringify(rows[0]));

    const [kids] = await db.query('SELECT COUNT(*) AS n FROM children WHERE id = ?', {
      replacements: [leavingChild.data.id],
    });
    check('the child went with it', Number(kids[0].n) === 0, JSON.stringify(kids[0]));

    // A 401 on /auth/me is expected here — it is the assertion above.
    const noise = w.problems.filter((p) => !p.includes('401'));
    check('the account-closing flow is otherwise clean', noise.length === 0, noise.slice(0, 2).join(' | '));
    await page.close();
  }

  step('Family app — dashboard is gated');
  {
    const page = await browser.newPage();
    await page.goto(`${FAMILY}/dashboard/children`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    check('an anonymous visitor is sent to /login', page.url().includes('/login'), page.url());
    await page.close();
  }

  // ── The phone ─────────────────────────────────────────────────────────────
  // Everything above this runs at a desktop viewport, where a layout can be
  // unusable on a phone and still pass every check — a route that renders is
  // not a route that fits. This drives the same app at 390×844 with touch and
  // fails on the four things only a phone-sized run can see: a page wider than
  // the screen, a control too small to hit, form text small enough to trigger
  // Safari's zoom-on-focus, and navigation that cannot be reached at all
  // without the sidebar a phone does not have.
  const PHONE_ROUTES = [
    ['', 'Dashboard'], ['children', 'Children'], ['location', 'Location'],
    ['screen-time', 'Screen Time'], ['blocking', 'App Blocking'], ['contacts', 'Contacts'],
    ['activity', 'Activity Log'], ['web-history', 'Web History'], ['reports', 'Reports'],
    ['messages', 'Messages'], ['alerts', 'Alerts'],
    ['profile', 'Profile'], ['settings', 'Settings'],
  ];

  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });

  // The width neither layout is drawn for: too narrow for the console's rail,
  // too wide for the phone stack. It is also the width support actually reads
  // the console on, so the fallbacks either side of the `lg` breakpoint get
  // checked rather than assumed.
  const tablet = await browser.newContext({
    viewport: { width: 820, height: 1180 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

  /** Opens a signed-in page in the phone context and starts watching it. */
  const openPhone = async (path, label) => {
    const page = await phone.newPage();
    await page.goto(`${FAMILY}/login`);
    await page.evaluate((t) => localStorage.setItem('fg_token', t), parentToken);
    const w = watch(page, label);
    await page.goto(`${FAMILY}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    return { page, w };
  };

  /** Anything reaching past the viewport is a sideways scroll on a phone. */
  const measureOverflow = (page) => page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    offenders: [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className || '').slice(0, 40)}`),
  }));

  /** Visible buttons shorter than 36px are targets a thumb misses. */
  // Google Maps injects its own chrome — "Keyboard shortcuts", the zoom pair,
  // the Terms link — into the map container, and none of it is ours to restyle.
  // It only shows up once a Maps key is configured, so auditing it would make
  // this check pass or fail on whether the environment has one.
  const measureTargets = (page) => page.evaluate(() => [...document.querySelectorAll('button')]
    .filter((el) => !el.closest('.gm-style, [aria-label="Map"], gmp-map'))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.height < 36;
    })
    .slice(0, 4)
    .map((el) => `"${(el.textContent || '').trim().slice(0, 18) || el.getAttribute('aria-label') || '?'}" `
      + `${Math.round(el.getBoundingClientRect().height)}px`));

  step('Family app on a phone — the signed-out screens');
  {
    const page = await phone.newPage();
    const w = watch(page, 'phone login');
    await page.goto(`${FAMILY}/login`, { waitUntil: 'networkidle' });
    if (process.env.BROWSER_E2E_SHOTS) {
      mkdirSync(process.env.BROWSER_E2E_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.BROWSER_E2E_SHOTS, 'login.png'), fullPage: true });
    }

    const o = await measureOverflow(page);
    check('the sign-in screen fits the screen', o.width <= o.viewport + 1, JSON.stringify(o));

    // Below 16px, Safari zooms the page in when the field takes focus and never
    // zooms back out, leaving the rest of the form off-screen.
    const fontSize = await page.locator('input[type="email"]')
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    check('form text is large enough not to trigger zoom-on-focus', fontSize >= 16, `${fontSize}px`);

    // The reveal control is the difference between a typo and a lockout when
    // the password is being typed blind on a phone keyboard.
    await page.fill('input[type="password"]', 'not-my-password');
    await page.click('button[aria-label="Show password"]');
    check('a password can be revealed', await page.locator('input[type="text"][aria-label="Password"]').count() > 0);

    check('the sign-in screen is clean', w.problems.length === 0, w.problems.join(' | '));
    await page.close();
  }

  const SHOT_DIR = process.env.BROWSER_E2E_SHOTS;
  if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });

  step('Family app on a phone — every screen fits and is usable');
  for (const [route, label] of PHONE_ROUTES) {
    const { page, w } = await openPhone(`/dashboard/${route}`, label);

    if (SHOT_DIR) {
      await page.screenshot({
        path: path.join(SHOT_DIR, `${route || 'dashboard'}.png`),
        fullPage: true,
      });
    }

    const o = await measureOverflow(page);
    check(`${label} fits the screen`, o.width <= o.viewport + 1, JSON.stringify(o));

    const title = await page.locator('header h1').innerText().catch(() => '');
    check(`${label} is titled in the header`, title.trim() === label, title);

    check(`${label} keeps the tab bar reachable`,
      await page.locator('nav[aria-label="Primary"]').isVisible());

    const small = await measureTargets(page);
    check(`${label} has no controls too small to tap`, small.length === 0, small.join(', '));

    check(`${label} is clean on a phone`, w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await page.close();
  }

  step('Family app on a phone — navigation');
  {
    const { page, w } = await openPhone('/dashboard', 'phone nav');

    // The tab bar.
    await page.locator('nav[aria-label="Primary"] a:has-text("Children")').click();
    await page.waitForTimeout(700);
    check('a tab bar destination navigates', page.url().endsWith('/dashboard/children'), page.url());

    // The drawer, for everything the four tabs do not cover.
    await page.locator('nav[aria-label="Primary"] button:has-text("More")').click();
    await page.waitForTimeout(400);
    check('"More" opens the menu', await page.locator('aside[role="dialog"]').count() > 0);

    await page.locator('aside[role="dialog"] a:has-text("Web History")').click();
    await page.waitForTimeout(700);
    check('a menu link navigates', page.url().includes('/dashboard/web-history'), page.url());
    // It used to stay open behind the new page, covering it.
    check('the menu closes behind it', await page.locator('aside[role="dialog"]').count() === 0);

    // The account menu — signing out used to be reachable only by opening the
    // drawer and scrolling past every link in it.
    await page.click('button[aria-label="Account menu"]');
    await page.waitForTimeout(300);
    await page.locator('a:has-text("Your profile")').click();
    await page.waitForTimeout(700);
    check('the account menu reaches the profile', page.url().includes('/dashboard/profile'), page.url());
    check('the profile shows the signed-in parent',
      (await page.locator('body').innerText()).includes('Browser Parent'));

    // Settings sections are addressable, which is how Profile links into them
    // and how Stripe returns a parent to the right place.
    await page.goto(`${FAMILY}/dashboard/settings?section=plan`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    const settingsText = await page.locator('body').innerText();
    check('a settings section can be linked to directly',
      settingsText.includes('Current plan'), settingsText.slice(0, 120).replace(/\n/g, ' '));

    // Two plans are sold. Family Plus was retired and Premium absorbed it, so
    // the retired tier must not survive anywhere a customer can see — the price
    // on this page is the price Stripe charges.
    check('the pricing page offers Free and Premium',
      settingsText.includes('Free Plan') && settingsText.includes('Premium Plan'));
    check('Premium is priced at $9.99', settingsText.includes('$9.99'));
    check('the retired Family Plus tier is gone',
      !settingsText.includes('Family Plus') && !settingsText.includes('$14.99'));
    check('Premium advertises the features it absorbed',
      settingsText.includes('Unlimited child devices') && settingsText.includes('Cyberbullying detection'));

    check('the phone navigation is clean', w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await page.close();
  }

  step('Family app on a phone — the alert bell');
  {
    const { page } = await openPhone('/dashboard', 'phone bell');
    await page.click('button[aria-label*="Alerts"]');
    await page.waitForTimeout(400);

    const panel = await page.evaluate(() => {
      const dialog = [...document.querySelectorAll('div')]
        .find((el) => el.className.includes?.('max-h-[70dvh]'));
      if (!dialog) return null;
      const r = dialog.getBoundingClientRect();
      return { left: r.left, right: r.right, viewport: window.innerWidth };
    });
    check('the alert panel stays on screen',
      !!panel && panel.left >= 0 && panel.right <= panel.viewport + 1, JSON.stringify(panel));

    await page.close();
  }

  // `phone` stays open — the admin console is driven through it further down.
  await familyPage.close();

  // ── Admin dashboard ───────────────────────────────────────────────────────
  step('Admin dashboard — staff sign-in');
  let adminPage;
  {
    adminPage = await browser.newPage();
    const w = watch(adminPage, 'admin login');
    await adminPage.goto(`${ADMIN}/login`, { waitUntil: 'networkidle' });
    if (SHOT_DIR) {
      mkdirSync(path.join(SHOT_DIR, 'desktop-admin'), { recursive: true });
      await adminPage.screenshot({ path: path.join(SHOT_DIR, 'desktop-admin', 'login.png') });
    }
    await adminPage.fill('input[type="email"]', PARENT_EMAIL);
    await adminPage.fill('input[type="password"]', PARENT_PASSWORD);
    await adminPage.click('button[type="submit"]');
    await adminPage.waitForTimeout(2500);
    check('a Super Admin reaches the console', !adminPage.url().includes('/login'), adminPage.url());
    check('the console sign-in is clean', w.problems.length === 0, w.problems.join(' | '));
  }

  step('Admin dashboard — a staff account created here can sign in');
  {
    const token = await adminPage.evaluate(() => localStorage.getItem('px_admin_token'));
    const created = await api('POST', '/admin/staff', {
      token,
      body: { name: 'Ops Person', email: staffEmail, role: 'operations' },
    });
    check('the console creates a staff account', created.status === 201, JSON.stringify(created.data).slice(0, 120));

    if (created.status === 201) {
      const page = await browser.newPage();
      await page.goto(`${ADMIN}/login`, { waitUntil: 'networkidle' });
      await page.fill('input[type="email"]', staffEmail); // exactly as it was typed
      await page.fill('input[type="password"]', created.data.generatedPassword);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(2500);
      check('that account signs in with the address as typed', !page.url().includes('/login'), page.url());
      await page.close();
    }
  }

  step('Family app — two-factor authentication can be switched on');
  {
    // The API supported TOTP long before any screen called /mfa/setup, so this
    // walks the whole flow in the browser: QR, first code, backup codes, and
    // then a real sign-in that is actually challenged for a second factor.
    const { generate: generateTotp } = require('otplib');

    const page = await browser.newPage();
    const w = watch(page, 'two-factor');
    await page.goto(`${FAMILY}/login`);
    await page.evaluate((t) => localStorage.setItem('fg_token', t), parentToken);
    await page.goto(`${FAMILY}/dashboard/settings`, { waitUntil: 'networkidle' });

    await page.click('text=Turn on two-factor');
    await page.locator('img[alt="Two-factor setup QR code"]').waitFor({ timeout: 10000 });
    check('the setup QR is rendered', true);

    // Read the secret the way a person who cannot scan would.
    await page.click('text=Can\'t scan it?');
    const secret = (await page.locator('details code').innerText()).trim();
    check('the secret is offered for manual entry', /^[A-Z2-7]{16,}$/.test(secret), secret);

    await page.fill('input[placeholder="123456"]', await generateTotp({ secret }));
    await page.click('text=Verify and turn on');

    await page.locator('text=Save these backup codes now').waitFor({ timeout: 10000 });
    const codes = await page.locator('ul.font-mono li').allInnerTexts();
    check('eight backup codes are shown once', codes.length === 8, String(codes.length));
    check('the account now reports two-factor as on',
      (await page.locator('text=Two-Factor Authentication').locator('..').innerText()).includes('On'));
    await page.close();

    // Signing in now has to demand the second factor.
    const fresh = await browser.newPage();
    await fresh.goto(`${FAMILY}/login`, { waitUntil: 'networkidle' });
    await fresh.fill('input[type="email"]', PARENT_EMAIL);
    await fresh.fill('input[type="password"]', PARENT_PASSWORD);
    await fresh.click('button[type="submit"]');
    await fresh.waitForTimeout(1500);
    check('the password alone no longer signs you in', !fresh.url().includes('/dashboard'), fresh.url());

    const challenged = await fresh.locator('input[inputmode="numeric"], input[autocomplete="one-time-code"]').count();
    check('a code is asked for at sign-in', challenged > 0, String(challenged));

    // A backup code has to be accepted in place of the authenticator.
    await fresh.locator('input[inputmode="numeric"], input[autocomplete="one-time-code"]').first().fill(codes[0]);
    await fresh.click('button[type="submit"]');
    await fresh.waitForURL('**/dashboard**', { timeout: 15000 }).catch(() => {});
    check('a backup code completes the sign-in', fresh.url().includes('/dashboard'), fresh.url());
    check('the two-factor flow is clean', w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await fresh.close();
  }

  step('Admin dashboard — every console route renders');
  {
    const token = await adminPage.evaluate(() => localStorage.getItem('px_admin_token'));
    const routes = [['', 'Overview'], ['users', 'User Management'], ['devices', 'Device Control'],
      ['content-filtering', 'Content Filtering'],
      ['sessions', 'Sessions'], ['billing', 'Billing & Subscriptions'],
      ['notifications', 'Notifications'], ['settings', 'Settings'], ['audit-logs', 'System Logs'],
      ['staff', 'Staff'], ['profile', 'Profile']];
    for (const [route, label] of routes) {
      const page = await browser.newPage();
      await page.goto(`${ADMIN}/login`);
      await page.evaluate(([k, t]) => localStorage.setItem(k, t), ['px_admin_token', token]);
      await page.evaluate((t) => localStorage.setItem('fg_token', t), token);
      const w = watch(page, label);
      await page.goto(`${ADMIN}/${route}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      if (process.env.BROWSER_E2E_SHOTS) {
        mkdirSync(path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin'), { recursive: true });
        await page.screenshot({
          path: path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin', `${route || 'overview'}.png`),
        });
      }
      const text = await page.locator('body').innerText();
      check(`${label} renders`, text.length > 30 && !text.includes(CRASHED), text.slice(0, 80).replace(/\n/g, ' '));
      check(`${label} has no runtime errors`, w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
      await page.close();
    }
  }

  step('Admin dashboard — user search is case-insensitive');
  {
    const token = await adminPage.evaluate(() => localStorage.getItem('px_admin_token'));
    const res = await api('GET', '/admin/users?search=browser', { token });
    check('a lowercase fragment finds "Browser Parent"',
      res.status === 200 && res.data.rows.some((u) => u.name === 'Browser Parent'),
      JSON.stringify(res.data).slice(0, 120));
  }

  // The directory's tiles and its per-account counts are derived from three
  // tables, so "the page rendered" says nothing about whether they are right.
  step('Admin console — User Management counts each family and filters the directory');
  {
    const token = await adminPage.evaluate(() => localStorage.getItem('px_admin_token'));

    const res = await api('GET', '/admin/users?search=Browser%20Parent', { token });
    const row = res.data.rows?.find((u) => u.name === 'Browser Parent');
    check('a row carries the family behind the account',
      row?.childCount >= 1 && row?.deviceCount >= 1,
      JSON.stringify({ children: row?.childCount, devices: row?.deviceCount }));

    const summary = res.data.summary;
    check('the directory answers with a summary the filters cannot move',
      typeof summary?.customers === 'number'
      && summary.customers === summary.active + summary.blocked
      && summary.signups.byDay.length === 30,
      JSON.stringify(summary?.signups?.byDay?.length));

    const page = await browser.newPage();
    await page.goto(`${ADMIN}/login`);
    await page.evaluate(([k, t]) => { localStorage.setItem(k, t); localStorage.setItem('fg_token', t); },
      ['px_admin_token', token]);
    const w = watch(page, 'user management');
    await page.goto(`${ADMIN}/users`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    // Six columns and up to six row actions on the same 1280px screen.
    const scroller = await page.evaluate(() => {
      const el = document.querySelector('.overflow-x-auto');
      return el ? { scroll: el.scrollWidth, client: el.clientWidth } : null;
    });
    check('the directory table needs no sideways scrolling',
      !!scroller && scroller.scroll <= scroller.client + 1, JSON.stringify(scroller));

    const tiles = await page.locator('body').innerText();
    check('the three directory tiles are drawn',
      /total active users/i.test(tiles) && /new signups/i.test(tiles) && /premium share/i.test(tiles));

    // Every seeded account is on the free plan, so this narrows to nothing.
    await page.selectOption('select[aria-label="Filter by plan"]', 'premium');
    await page.waitForTimeout(900);
    check('the plan filter narrows the directory',
      await page.locator('td:has-text("Browser Parent")').count() === 0);

    await page.selectOption('select[aria-label="Filter by plan"]', '');
    await page.waitForTimeout(900);
    check('clearing the plan filter brings the directory back',
      await page.locator('td:has-text("Browser Parent")').count() > 0);

    check('User Management is clean', w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await page.close();
  }

  // Every console table paginates, and until now no test had more rows than one
  // page holds — so nothing had ever pressed a page number. Seeded in SQL rather
  // than through the API: this needs sixty rows, not sixty password hashes.
  step('Admin console — the directory pages through a directory that does not fit');
  {
    const token = await adminPage.evaluate(() => localStorage.getItem('px_admin_token'));
    const [[sample]] = await db.query('SELECT password_hash FROM users LIMIT 1');

    for (let i = 0; i < 60; i += 1) {
      await db.query(
        // `1` for a boolean is a SQLite habit — Postgres has a real boolean type
        // and refuses the integer outright, which took the whole Postgres run
        // down at this fixture. `TRUE` is what both engines accept.
        `INSERT INTO users (id, name, email, password_hash, role, plan, is_active, email_verified, created_at, updated_at)
         VALUES (:id, :name, :email, :hash, 'parent', :plan, TRUE, TRUE, :now, :now)`,
        {
          replacements: {
            id: randomUUID(),
            name: `Paged Parent ${String(i).padStart(2, '0')}`,
            email: `paged${i}.${stamp}@example.com`,
            hash: sample.password_hash,
            plan: i % 5 === 0 ? 'premium' : 'free',
            // A Date, not an ISO string: the driver writes it in the format the
            // dialect reads back, which an ISO string is not on SQLite.
            now: new Date(),
          },
        },
      );
    }

    const page = await browser.newPage();
    await page.goto(`${ADMIN}/login`);
    await page.evaluate(([k, t]) => { localStorage.setItem(k, t); localStorage.setItem('fg_token', t); },
      ['px_admin_token', token]);
    const w = watch(page, 'directory pagination');
    await page.goto(`${ADMIN}/users`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    const firstPage = await page.locator('body').innerText();
    check('the first page reports its range', /Showing\s+1–50\s+of\s+6[0-9]/.test(firstPage.replace(/\s+/g, ' ')),
      firstPage.match(/Showing[^\n]*/)?.[0]);

    // Five or six actions per row, and a table that has to keep them on one line
    // — wrapped icons turn a 50-row directory into a scroll of double-height rows.
    const wrapped = await page.evaluate(() => [...document.querySelectorAll('tbody td:last-child > div')]
      .filter((el) => el.getBoundingClientRect().height > 44).length);
    check('a row keeps its actions on one line', wrapped === 0, `${wrapped} rows wrap`);

    const tileBefore = await page.locator('text=Total active users').locator('..').innerText();

    await page.locator('button[aria-label="Page 2"]').click();
    await page.waitForTimeout(900);

    const secondPage = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    check('a page number navigates', /Showing\s+51–6[0-9]/.test(secondPage),
      secondPage.match(/Showing[^S]*/)?.[0]);
    check('the current page is marked for assistive tech',
      await page.locator('button[aria-current="page"]').innerText() === '2');

    // The only shot in the run where the directory has enough rows to page and
    // enough accounts for the tiles to say anything. Wound back to the top first:
    // pressing a page number leaves the viewport at the foot of the table.
    if (process.env.BROWSER_E2E_SHOTS) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);
      mkdirSync(path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin'), { recursive: true });
      await page.screenshot({
        path: path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin', 'users-paged.png'),
      });
    }

    // The tiles describe the directory, not the page you happen to be reading.
    check('paging does not move the summary tiles',
      await page.locator('text=Total active users').locator('..').innerText() === tileBefore);

    check('directory pagination is clean', w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await page.close();
  }

  // The fleet screen is the one console page whose numbers are derived rather
  // than stored, so "it rendered" is not enough — the tiles, the filters and the
  // detail panel each have to agree with what the API says about the same fleet.
  step('Admin console — Device Control lists the fleet and inspects a device');
  {
    const token = await adminPage.evaluate(() => localStorage.getItem('px_admin_token'));

    const fleet = await api('GET', '/admin/devices', { token });
    check('the fleet endpoint answers the console',
      fleet.status === 200 && fleet.data.summary.total >= 1 && fleet.data.summary.online >= 1,
      JSON.stringify(fleet.data?.summary));

    const page = await browser.newPage();
    await page.goto(`${ADMIN}/login`);
    await page.evaluate(([k, t]) => { localStorage.setItem(k, t); localStorage.setItem('fg_token', t); },
      ['px_admin_token', token]);
    const w = watch(page, 'device control');
    await page.goto(`${ADMIN}/devices`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    check('the linked device is listed', await page.locator('text=Browser Phone').count() > 0);

    // The fleet table shares a 1280px screen with the detail panel, and a table
    // whose columns do not fit parks its actions inside a scroller nobody sees.
    const scroller = await page.evaluate(() => {
      const el = document.querySelector('.overflow-x-auto');
      return el ? { scroll: el.scrollWidth, client: el.clientWidth } : null;
    });
    check('the fleet table needs no sideways scrolling',
      !!scroller && scroller.scroll <= scroller.client + 1, JSON.stringify(scroller));

    // The topology card is this page of the table drawn as a star, so it has to
    // carry exactly one node per row — a picture that quietly drops devices is
    // worse than no picture — and a node has to reach the same detail panel.
    const nodes = await page.locator('[data-device]').count();
    const rowCount = await page.locator('table tbody tr').count();
    check('the topology draws one node per device on the page',
      nodes > 0 && nodes === rowCount, `${nodes} nodes / ${rowCount} rows`);

    await page.locator('[data-device]').first().click();
    await page.waitForTimeout(400);
    check('a topology node opens its device',
      await page.locator('button:has-text("Copy full device ID")').count() === 1);

    // Selecting a row is what fills the panel beside it.
    await page.locator('table button:has-text("Details")').first().click();
    await page.waitForTimeout(400);
    const panel = page.locator('div:has(> div > button:has-text("Copy full device ID"))').first();
    check('selecting a device fills the detail panel',
      await page.locator('button:has-text("Copy full device ID")').count() === 1);
    check('the panel reports the policy in force',
      (await panel.innerText()).includes('Daily screen-time limit'),
      (await panel.innerText()).slice(0, 120).replace(/\n/g, ' '));

    // The selected state is the half of this screen a route screenshot misses.
    if (process.env.BROWSER_E2E_SHOTS) {
      mkdirSync(path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin'), { recursive: true });
      await page.screenshot({
        path: path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin', 'devices-selected.png'),
        fullPage: true,
      });
    }

    // A filter has to actually filter: the linked phone is not awaiting a link.
    await page.selectOption('select[aria-label="Filter by status"]', 'pending');
    await page.waitForTimeout(900);
    check('a status filter narrows the fleet', await page.locator('text=Browser Phone').count() === 0);

    await page.selectOption('select[aria-label="Filter by status"]', 'online');
    await page.waitForTimeout(900);
    check('the active filter still finds the reporting device',
      await page.locator('text=Browser Phone').count() > 0);

    // Search reaches a device through its owner, not just its own name.
    await page.fill('input[aria-label="Search the fleet"]', 'Browser Parent');
    await page.press('input[aria-label="Search the fleet"]', 'Enter');
    await page.waitForTimeout(900);
    check('the fleet is searchable by account', await page.locator('text=Browser Phone').count() > 0);

    check('Device Control is clean', w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await page.close();
  }

  // System Logs is the screen where a filter applied in the wrong place is
  // invisible: narrowing the rows in the browser would still look like it
  // worked, while the count and the paginator beside them went on describing
  // the unfiltered stream. So each filter is checked against what the API says
  // about the same query, not just against the rows that survived on screen.
  // The Overview opens on the alert panel, and every figure in it is counted
  // from the audit stream by the same rules the log screen filters with. So the
  // step checks the two agree, rather than only that the panel rendered.
  step('Admin console — the Overview summarises what the platform recorded');
  {
    const token = await adminPage.evaluate(() => localStorage.getItem('px_admin_token'));

    // A refused sign-in for an address nobody registered: one guaranteed error
    // entry, and no real account collects a failed attempt from it.
    await api('POST', '/auth/login', { body: { email: 'nobody@overview.test', password: 'wrong-password' } });
    await adminPage.waitForTimeout(400);

    const summary = await api('GET', '/admin/platform-health?window=24h', { token });
    check('the health endpoint answers with a level for each severity',
      summary.status === 200 && summary.data.levels.length === 4
      && summary.data.levels.every((l) => typeof l.count === 'number'),
      JSON.stringify(summary.data.levels));

    const errorsInPanel = summary.data.levels.find((l) => l.level === 'error').count;
    const errorsInLogs = (await api('GET', '/audit?level=error', { token })).data.count;
    check('a tile and the log screen behind it count the same entries',
      errorsInPanel > 0 && errorsInPanel <= errorsInLogs,
      `${errorsInPanel} in the panel, ${errorsInLogs} in the log (all time)`);

    const page = await browser.newPage();
    await page.goto(`${ADMIN}/login`);
    await page.evaluate(([k, t]) => { localStorage.setItem(k, t); localStorage.setItem('fg_token', t); },
      ['px_admin_token', token]);
    const w = watch(page, 'overview');
    await page.goto(ADMIN, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    const body = await page.locator('body').innerText();
    check('the severity summary is drawn', /Activity summary/i.test(body) && /Warnings/i.test(body));
    check('the alert types are listed with what raises them',
      /Emergency alert/i.test(body) && /emergency message/i.test(body));
    check('the delivery channels report what is really configured',
      /Delivery channels/i.test(body) && /Browser push/i.test(body) && /Not integrated/i.test(body));
    check('it invents no channel the platform does not have', !/slack/i.test(body));
    check('the growth analytics are still on the screen',
      /Total users/i.test(body) && /Signups \(last 30 days\)/i.test(body));

    // A tile is a link into the same query it counted.
    await page.locator('a[href*="level=error"]').first().click();
    await page.waitForTimeout(1200);
    check('a severity tile opens the log filtered to it',
      page.url().includes('/audit-logs') && page.url().includes('level=error'), page.url());
    const levelValue = await page.locator('#log-level').inputValue();
    check('the log screen arrives with that filter applied', levelValue === 'error', levelValue);

    // The critical banner. Nothing in a healthy run deletes an account, so the
    // entry is seeded directly — what is being checked is the banner and the
    // acknowledgement, not the deletion.
    await db.query(
      `INSERT INTO audit_logs (id, action, entity, ip_address, created_at)
       VALUES (:id, 'admin.user_deleted', 'User', '127.0.0.1', :at)`,
      { replacements: { id: randomUUID(), at: new Date() } },
    );

    await page.goto(ADMIN, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    check('a critical entry raises the banner',
      /Critical system entry/i.test(await page.locator('body').innerText()));

    if (process.env.BROWSER_E2E_SHOTS) {
      mkdirSync(path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin'), { recursive: true });
      await page.screenshot({
        path: path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin', 'overview-alerts.png'),
      });
    }

    await page.locator('button:has-text("Acknowledge")').click();
    await page.waitForTimeout(1000);
    const acknowledged = await page.locator('body').innerText();
    check('acknowledging records who saw it and stands the banner down',
      /Critical entry acknowledged/i.test(acknowledged) && /seen by/i.test(acknowledged),
      acknowledged.slice(0, 160).replace(/\n/g, ' '));

    // Muting is the one control on the panel that changes behaviour.
    await page.goto(ADMIN, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    // Scoped to the table: the phone cards are in the DOM too, hidden above lg.
    await page.locator('table button[role="switch"][aria-label*="Blocked app attempt"]').click();
    await page.waitForTimeout(800);

    const muted = await api('GET', '/admin/platform-health', { token });
    check('muting an alert type is saved, not just switched in the browser',
      (muted.data.alertTypes.find((t) => t.key === 'blocked_app_attempt') || {}).muted === true,
      JSON.stringify(muted.data.alertTypes.filter((t) => t.muted).map((t) => t.key)));

    if (process.env.BROWSER_E2E_SHOTS) {
      mkdirSync(path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin'), { recursive: true });
      await page.screenshot({
        path: path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin', 'overview-full.png'), fullPage: true,
      });
    }

    // Put delivery back: a later step that raises an alert must not run against
    // a platform this one silenced.
    await api('PUT', '/admin/platform-health/alert-delivery', { token, body: { muted: [] } });

    check('the Overview is clean', w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await page.close();
  }

  step('Admin console — System Logs classifies and filters the stream');
  {
    const token = await adminPage.evaluate(() => localStorage.getItem('px_admin_token'));

    // One guaranteed error entry to filter down to. A refused sign-in is the
    // cheapest way to write one, and it is exactly what the screen exists for.
    // An address nobody registered, so no real account collects a failed attempt
    // and gets itself locked out of a later step. The write is fire-and-forget,
    // hence the pause before asking for it back.
    await api('POST', '/auth/login', { body: { email: 'nobody@nowhere.test', password: 'wrong-password' } });
    await adminPage.waitForTimeout(400);

    const stream = await api('GET', '/audit?limit=5', { token });
    check('the log endpoint labels every entry with a level and a service',
      stream.status === 200 && stream.data.rows.length > 0
      && stream.data.rows.every((r) => r.level && r.service),
      JSON.stringify(stream.data.rows?.[0] && {
        action: stream.data.rows[0].action, level: stream.data.rows[0].level, service: stream.data.rows[0].service,
      }));

    const errors = await api('GET', '/audit?level=error', { token });
    check('the level filter narrows the query, count included',
      errors.status === 200 && errors.data.count > 0 && errors.data.count < stream.data.count
      && errors.data.rows.every((r) => r.level === 'error'),
      `${errors.data.count} errors of ${stream.data.count}`);

    const page = await browser.newPage();
    await page.goto(`${ADMIN}/login`);
    await page.evaluate(([k, t]) => { localStorage.setItem(k, t); localStorage.setItem('fg_token', t); },
      ['px_admin_token', token]);
    const w = watch(page, 'system logs');
    await page.goto(`${ADMIN}/audit-logs`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    const rowsOnScreen = await page.locator('table tbody tr').count();
    check('the stream renders', rowsOnScreen > 0, `${rowsOnScreen} rows`);
    check('an entry carries its severity', await page.locator('table >> text=Error').count() > 0);

    // Five columns of timestamps, badges and metadata is exactly the shape that
    // ends up in an invisible sideways scroller.
    const scroller = await page.evaluate(() => {
      const el = document.querySelector('.overflow-x-auto');
      return el ? { scroll: el.scrollWidth, client: el.clientWidth } : null;
    });
    check('the log table needs no sideways scrolling',
      !!scroller && scroller.scroll <= scroller.client + 1, JSON.stringify(scroller));

    await page.selectOption('#log-level', 'error');
    await page.waitForTimeout(900);
    const shown = await page.locator('table tbody tr').count();
    check('the level filter reaches the server and the summary agrees',
      shown === Math.min(errors.data.count, 50)
      && (await page.locator('text=/\\d+ recorded/').innerText()).startsWith(String(errors.data.count)),
      `${shown} rows on screen for ${errors.data.count} errors`);

    if (process.env.BROWSER_E2E_SHOTS) {
      mkdirSync(path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin'), { recursive: true });
      await page.screenshot({
        path: path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin', 'system-logs-filtered.png'),
        fullPage: true,
      });
    }

    // A service chip and the level filter have to compose, not replace.
    await page.locator('button:has-text("auth")').first().click();
    await page.waitForTimeout(900);
    const combined = await api('GET', '/audit?level=error&service=auth', { token });
    check('a service chip narrows what the level filter already found',
      await page.locator('table tbody tr').count() === Math.min(combined.data.count, 50),
      `${combined.data.count} auth errors`);

    await page.locator('button:has-text("Clear filters")').click();
    await page.waitForTimeout(900);
    check('clearing the filters restores the whole stream',
      await page.locator('table tbody tr').count() > shown);

    // Live tail is a real switch, so it has to report its state to a reader.
    const tail = page.locator('button[role="switch"]');
    check('live tail is off until it is asked for', await tail.getAttribute('aria-checked') === 'false');
    await tail.click();
    await page.waitForTimeout(600);
    check('live tail turns on and says so', await tail.getAttribute('aria-checked') === 'true'
      && await page.locator('text=Tailing').count() === 1);

    check('System Logs is clean', w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await page.close();
  }

  // Billing is the other screen whose numbers are derived rather than stored:
  // a run rate, a churn rate and a year of revenue buckets, none of which exist
  // in any column. Seeded in SQL because this needs a payment history, not a
  // Stripe account — the webhook is what would otherwise write these rows.
  step('Admin console — Billing & Subscriptions reports the business');
  {
    const token = await adminPage.evaluate(() => localStorage.getItem('px_admin_token'));
    // One of the seeded premium parents, so the payments belong to an account
    // that really is on the tier they were taken for.
    const [[payer]] = await db.query(
      `SELECT id FROM users WHERE email = ?`, { replacements: [`paged0.${stamp}@example.com`] },
    );

    // Two payments this month, one a year old, and one failure. The old one is
    // what proves the twelve-month range reaches back past the other three.
    const seeded = [
      { type: 'checkout_completed', amount: 999, status: 'succeeded', days: 3 },
      { type: 'invoice_paid', amount: 999, status: 'succeeded', days: 1 },
      { type: 'invoice_paid', amount: 999, status: 'succeeded', days: 300 },
      { type: 'invoice_failed', amount: 999, status: 'failed', days: 2 },
    ];
    for (const t of seeded) {
      await db.query(
        `INSERT INTO transactions (id, user_id, stripe_event_id, type, amount, currency, plan, status, created_at)
         VALUES (:id, :userId, :event, :type, :amount, 'usd', 'premium', :status, :at)`,
        {
          replacements: {
            id: randomUUID(),
            userId: payer.id,
            event: `evt_${stamp}_${t.type}_${t.days}`,
            type: t.type,
            amount: t.amount,
            status: t.status,
            // A Date, not an ISO string: SQLite reads back what the driver wrote.
            at: new Date(Date.now() - t.days * 24 * 60 * 60 * 1000),
          },
        },
      );
    }

    const billing = await api('GET', '/admin/transactions', { token });
    const s = billing.data?.summary;
    check('the billing endpoint answers with rows, a count and a summary',
      billing.status === 200 && Array.isArray(billing.data.rows) && typeof billing.data.count === 'number' && !!s,
      JSON.stringify(billing.data).slice(0, 120));
    check('the run rate is the paid base at its list price',
      s.mrr === s.plans.find((p) => p.key === 'premium').subscribers * 999,
      JSON.stringify({ mrr: s?.mrr, plans: s?.plans }));
    check('the revenue trend has a continuous axis on all three ranges',
      s.revenue.day.length === 30 && s.revenue.week.length === 12 && s.revenue.month.length === 12,
      JSON.stringify(Object.fromEntries(Object.entries(s.revenue).map(([k, v]) => [k, v.length]))));
    check('a payment older than the short ranges still counts in the yearly one',
      s.revenue.month.reduce((sum, b) => sum + b.amount, 0)
        > s.revenue.day.reduce((sum, b) => sum + b.amount, 0),
      JSON.stringify({ year: s.revenue.month.at(-1), month: s.revenue.day.at(-1) }));
    check('the failed charge is counted and not billed',
      s.failedPayments >= 1 && s.billed.month === 1998,
      JSON.stringify({ failed: s.failedPayments, billed: s.billed }));

    // The tiles describe the business, so a filter on the table cannot move them.
    const narrowed = await api('GET', '/admin/transactions?status=failed', { token });
    check('a filter narrows the log without moving the summary',
      narrowed.data.rows.length === 1
        && narrowed.data.summary.mrr === s.mrr
        && narrowed.data.summary.subscribers === s.subscribers,
      JSON.stringify({ rows: narrowed.data.rows.length, mrr: narrowed.data.summary?.mrr }));

    const page = await browser.newPage();
    await page.goto(`${ADMIN}/login`);
    await page.evaluate(([k, t]) => { localStorage.setItem(k, t); localStorage.setItem('fg_token', t); },
      ['px_admin_token', token]);
    const w = watch(page, 'billing');
    await page.goto(`${ADMIN}/billing`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);

    const body = await page.locator('body').innerText();
    check('the four billing tiles are drawn',
      /recurring revenue/i.test(body) && /active subscribers/i.test(body)
        && /churn rate/i.test(body) && /avg rev per user/i.test(body));
    check('the plan ring reports the catalogue',
      /plan distribution/i.test(body) && /premium plan/i.test(body) && /free plan/i.test(body));
    check('a failed charge is called out rather than left to be found',
      /payment.{0,3} failed in the last/i.test(body));
    check('the revenue chart draws its bars',
      await page.locator('.recharts-bar-rectangle').count() > 0);

    // Six columns and an action on a 1280px screen — the same trap the directory
    // and the fleet fell into, where a column that will not shrink parks the row
    // actions inside a horizontal scroller nobody notices.
    const scroller = await page.evaluate(() => {
      const el = document.querySelector('.overflow-x-auto');
      return el ? { scroll: el.scrollWidth, client: el.clientWidth } : null;
    });
    check('the payment table needs no sideways scrolling',
      !!scroller && scroller.scroll <= scroller.client + 1, JSON.stringify(scroller));

    // The whole screen as it arrives, before anything is clicked — the route
    // shot above the fold misses the chart, the plan ring and the log.
    if (process.env.BROWSER_E2E_SHOTS) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);
      mkdirSync(path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin'), { recursive: true });
      await page.screenshot({
        path: path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin', 'billing-full.png'), fullPage: true,
      });
    }

    // The range control is the only part of the chart that is interactive, and
    // the pressed state is what tells a keyboard which range it is looking at.
    await page.locator('div[role="group"][aria-label="Revenue range"] button:has-text("1M")').click();
    await page.waitForTimeout(400);
    check('the revenue range switches and says which is pressed',
      await page.locator('div[role="group"][aria-label="Revenue range"] button[aria-pressed="true"]').innerText() === '1M');

    // A payment opens the record the console holds — the row action the
    // reference design spends on a receipt the platform does not have.
    await page.locator('table button[aria-label^="Payment details"]').first().click();
    await page.waitForTimeout(400);
    check('a payment opens its record', await page.locator('div[role="dialog"]').count() === 1);
    check('the record names what it is and is honest about the receipt',
      /Transaction ID/i.test(await page.locator('div[role="dialog"]').innerText())
        && /held by Stripe/i.test(await page.locator('div[role="dialog"]').innerText()));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    await page.fill('input[aria-label="Search payments"]', 'nobody-by-this-name');
    await page.press('input[aria-label="Search payments"]', 'Enter');
    await page.waitForTimeout(900);
    check('the payment log is searchable', /No payments match/i.test(await page.locator('body').innerText()));

    check('Billing is clean', w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await page.close();
  }

  // Content Filtering is the console screen with the longest reach: a switch on
  // it changes what every linked phone blocks. So the step drives the screen and
  // then checks the device endpoint — the one a phone actually calls — rather
  // than trusting that the policy was saved.
  step('Admin console — Content Filtering sets a policy the devices really enforce');
  {
    const token = await adminPage.evaluate(() => localStorage.getItem('px_admin_token'));

    const page = await browser.newPage();
    await page.goto(`${ADMIN}/login`);
    await page.evaluate(([k, t]) => { localStorage.setItem(k, t); localStorage.setItem('fg_token', t); },
      ['px_admin_token', token]);
    const w = watch(page, 'content filtering');
    await page.goto(`${ADMIN}/content-filtering`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);

    const body = await page.locator('body').innerText();
    check('the category catalogue is drawn from the server',
      /Adult Content/.test(body) && /Gambling/.test(body) && /File Sharing/.test(body), body.slice(0, 120));
    check('a platform with no policy says so rather than implying one',
      /Active policy: No policy/i.test(body), body.slice(0, 200).replace(/\n/g, ' '));
    check('it does not offer an alert threshold nothing could honour',
      !/SMS notification/i.test(body) && !/Attempts per hour/i.test(body));

    // Switching a category on is a draft until Save — the same model as Settings,
    // and for a stronger reason: this one reaches every device.
    await page.locator('button[role="switch"][aria-label^="Block Gambling"]').click();
    await page.waitForTimeout(300);
    check('a category switch is a draft, and says devices pick it up on sync',
      /Unsaved changes/i.test(await page.locator('body').innerText()));

    const beforeSave = await api('GET', '/admin/content-filtering', { token });
    check('the draft has written nothing to the platform',
      (beforeSave.data.policy.categories || []).length === 0,
      JSON.stringify(beforeSave.data.policy));

    await page.locator('button:has-text("Save policy")').click();
    await page.waitForTimeout(900);

    const afterSave = await api('GET', '/admin/content-filtering', { token });
    check('Save puts the category into the platform policy',
      (afterSave.data.policy.categories || []).includes('gambling'), JSON.stringify(afterSave.data.policy));
    check('the screen reports how many domains that put in force',
      afterSave.data.enforcedDomains > 5, String(afterSave.data.enforcedDomains));

    // A domain rule is its own action, applied as it is made.
    await page.fill('input[placeholder="example.com"]', 'https://www.Example-Block.com/watch');
    await page.locator('button:has-text("Add rule")').click();
    await page.waitForTimeout(900);
    check('a pasted URL is stored as the hostname a device can match',
      /example-block\.com/.test(await page.locator('body').innerText()),
      (await page.locator('body').innerText()).slice(0, 200).replace(/\n/g, ' '));
    check('the rule says who added it',
      /Browser Parent|Admin/i.test(await page.locator('body').innerText()));

    // The whole point: what a phone is told to block. A device of its own, linked
    // the way a real one is, so this reads the endpoint the child app calls.
    const filterChild = await api('POST', '/children', {
      token: parentToken, body: { name: 'Filter Kid', age: 11 },
    });
    const filterLink = await api('POST', '/devices/link', {
      token: parentToken, body: { childId: filterChild.data.id, deviceName: 'Filter Phone' },
    });
    const filterDeviceToken = (await api('POST', '/devices/confirm', { body: { code: filterLink.data.code } }))
      .data.deviceToken;

    const rules = await api('GET', '/devices/me/rules', { token: filterDeviceToken });
    const blockedForDevice = (rules.data.websiteRules || [])
      .filter((r) => r.action === 'block').map((r) => r.url);
    check('a device is handed the domains behind the category, not the category',
      blockedForDevice.includes('bet365.com') && blockedForDevice.includes('example-block.com'),
      JSON.stringify(blockedForDevice.slice(0, 6)));

    // A parent's allowance still beats the platform's category — the reason an
    // allow rule exists at all.
    await api('POST', `/blocking/${filterChild.data.id}/websites`, {
      token: parentToken, body: { url: 'bet365.com', action: 'allow' },
    });
    const afterAllow = await api('GET', '/devices/me/rules', { token: filterDeviceToken });
    check('a parent can still allow one site the platform blocks',
      !(afterAllow.data.websiteRules || [])
        .some((r) => r.action === 'block' && r.url === 'bet365.com'));

    // The blocked lookups the device reports are what the activity figures count.
    const then = Date.now();
    await api('POST', '/devices/me/web-history', {
      token: filterDeviceToken,
      body: {
        visits: [
          { domain: 'stake.com', firstSeen: then - 60_000, lastSeen: then, count: 4, blocked: true },
          { domain: 'khanacademy.org', firstSeen: then - 30_000, lastSeen: then, count: 1, blocked: false },
        ],
      },
    });

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    const withActivity = await page.locator('body').innerText();
    check('the blocked lookups a device reported are counted on the screen',
      /attempts blocked/i.test(withActivity) && /stake\.com/.test(withActivity),
      withActivity.slice(0, 200).replace(/\n/g, ' '));

    // Shot while the policy is still in place — the screen with nothing switched
    // on says very little about how it reads in use.
    if (process.env.BROWSER_E2E_SHOTS) {
      mkdirSync(path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin'), { recursive: true });
      await page.screenshot({
        path: path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin', 'content-filtering.png'), fullPage: true,
      });
    }

    // Put the platform back: later steps run against a fleet this one would
    // otherwise leave filtered.
    await api('PUT', '/admin/content-filtering', { token, body: { categories: [], domainRules: [] } });

    check('Content Filtering is clean', w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await page.close();
  }

  // Settings is the one console screen that writes platform-wide state, and it
  // now holds that state as a draft: nothing reaches the API until Save, and
  // Discard has to put the loaded values back. "The page rendered" says nothing
  // about either, so the groups, the draft and the round trip are all driven.
  step('Admin console — Settings groups, drafts and saves the platform configuration');
  {
    const token = await adminPage.evaluate(() => localStorage.getItem('px_admin_token'));
    const before = await api('GET', '/admin/settings', { token });
    const freeFeatures = before.data?.planFeatures?.free || [];
    check('the settings endpoint answers with the plan matrix and its labels',
      before.status === 200 && !!before.data.featureLabels && Array.isArray(freeFeatures),
      JSON.stringify(before.data).slice(0, 120));

    const page = await browser.newPage();
    await page.goto(`${ADMIN}/login`);
    await page.evaluate(([k, t]) => { localStorage.setItem(k, t); localStorage.setItem('fg_token', t); },
      ['px_admin_token', token]);
    const w = watch(page, 'settings');
    await page.goto(`${ADMIN}/settings`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    const tablist = page.locator('div[role="tablist"][aria-label="Settings sections"]');
    check('the groups are a tablist, not three unlabelled buttons',
      await tablist.locator('button[role="tab"]').count() === 3);
    check('General is the group you land on',
      await tablist.locator('button[aria-selected="true"]').innerText() === 'General');

    // Arrow keys walk the groups — the tablist pattern, and the reason these
    // are buttons rather than links.
    await tablist.locator('button[aria-selected="true"]').focus();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(400);
    check('an arrow key walks to the next group and takes the panel with it',
      (await tablist.locator('button[aria-selected="true"]').innerText()) === 'Plans & features'
        && page.url().includes('section=plans'), page.url());

    const planBody = await page.locator('body').innerText();
    check('the plans group reports the catalogue behind the matrix',
      /Free Plan/.test(planBody) && /Premium Plan/.test(planBody)
        && /\$9\.99/.test(planBody) && /Unlimited devices/.test(planBody));

    if (process.env.BROWSER_E2E_SHOTS) {
      mkdirSync(path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin'), { recursive: true });
      await page.screenshot({
        path: path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin', 'settings-plans.png'), fullPage: true,
      });
    }

    // Nothing is written by ticking a box: the footer says so, and Discard has
    // to be able to take it back.
    const box = page.locator('input[aria-label="Geofencing / Safe Zones on the Free Plan"]');
    const boxLabel = page.locator('label:has(> input[aria-label="Geofencing / Safe Zones on the Free Plan"])');
    const wasChecked = await box.isChecked();
    await boxLabel.click();
    await page.waitForTimeout(300);
    check('an edit is a draft, and the footer says it is unsaved',
      /Unsaved changes/i.test(await page.locator('body').innerText())
        && (await box.isChecked()) !== wasChecked);

    const stillSaved = await api('GET', '/admin/settings', { token });
    check('a draft has written nothing to the platform',
      (stillSaved.data.planFeatures.free || []).includes('geofencing') === freeFeatures.includes('geofencing'));

    await page.locator('button:has-text("Discard changes")').click();
    await page.waitForTimeout(300);
    check('Discard puts the loaded values back',
      (await box.isChecked()) === wasChecked
        && /All changes saved/i.test(await page.locator('body').innerText()));

    // And the round trip: tick, save, and the API has it.
    await boxLabel.click();
    await page.waitForTimeout(200);
    await page.locator('button:has-text("Save configuration")').click();
    await page.waitForTimeout(900);

    const after = await api('GET', '/admin/settings', { token });
    check('Save writes the matrix the console is showing',
      (after.data.planFeatures.free || []).includes('geofencing') === !wasChecked,
      JSON.stringify(after.data.planFeatures));
    check('the footer settles back to saved',
      /All changes saved|Settings saved/i.test(await page.locator('body').innerText()));

    // Put the catalogue back, so no later step runs against a tier this one
    // rewrote.
    await api('PUT', '/admin/settings', { token, body: { planFeatures: before.data.planFeatures } });

    // A group is addressable, which is what lets anything link at the part of
    // the screen it means.
    await page.goto(`${ADMIN}/settings?section=security`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    const securityBody = await page.locator('body').innerText();
    check('a settings group can be linked to directly',
      (await tablist.locator('button[aria-selected="true"]').innerText()) === 'Access & security');
    check('the security group points at the screens that really hold access control',
      /Staff accounts/i.test(securityBody) && /Active sessions/i.test(securityBody)
        && /enforced by the API/i.test(securityBody));
    check('it does not offer settings the platform has none of',
      !/API key/i.test(securityBody) && !/retention period/i.test(securityBody));

    if (process.env.BROWSER_E2E_SHOTS) {
      await page.screenshot({
        path: path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin', 'settings-security.png'), fullPage: true,
      });
    }

    check('Settings is clean', w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await page.close();
  }

  step('Admin dashboard — a parent token cannot mount the console');
  {
    const plain = await api('POST', '/auth/register', {
      body: { name: 'Plain Parent', email: `plain${stamp}@example.com`, password: PARENT_PASSWORD },
    });
    check('a second account registers', plain.status === 201);

    const [[r2]] = await db.query('SELECT email, email_verification_code AS code FROM users ORDER BY created_at DESC LIMIT 1');
    const v2 = await api('POST', '/auth/verify-email', { body: { email: r2.email, code: r2.code } });

    const page = await browser.newPage();
    await page.goto(`${ADMIN}/login`);
    await page.evaluate((t) => localStorage.setItem('px_admin_token', t), v2.data.token);
    await page.goto(`${ADMIN}/users`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    check('a parent lands back on the console login', page.url().includes('/login'), page.url());
    await page.close();
  }

  // ── The console on a phone ────────────────────────────────────────────────
  // Support answers a customer from wherever they are, so the console gets the
  // same treatment as the parent app. Its screens are tables, which is exactly
  // the thing that renders fine at 1280px and is unusable at 390px — a row's
  // actions sit off the right edge of a horizontal scroller nobody notices.
  step('Admin console on a phone — every screen fits and is usable');
  {
    const adminToken = await adminPage.evaluate(() => localStorage.getItem('px_admin_token'));
    const consoleRoutes = [
      ['', 'Overview'], ['users', 'User Management'], ['devices', 'Device Control'],
      ['content-filtering', 'Content Filtering'],
      ['sessions', 'Sessions'], ['billing', 'Billing & Subscriptions'],
      ['notifications', 'Notifications'], ['settings', 'Settings'], ['audit-logs', 'System Logs'],
      ['staff', 'Staff Accounts'], ['profile', 'My Profile'],
    ];

    for (const [route, label] of consoleRoutes) {
      const page = await phone.newPage();
      await page.goto(`${ADMIN}/login`);
      await page.evaluate(([k, t]) => { localStorage.setItem(k, t); localStorage.setItem('fg_token', t); },
        ['px_admin_token', adminToken]);
      const w = watch(page, label);
      await page.goto(`${ADMIN}/${route}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);

      if (SHOT_DIR) {
        mkdirSync(path.join(SHOT_DIR, 'admin'), { recursive: true });
        await page.screenshot({ path: path.join(SHOT_DIR, 'admin', `${route || 'overview'}.png`), fullPage: true });
      }

      const o = await measureOverflow(page);
      check(`console ${label} fits the screen`, o.width <= o.viewport + 1, JSON.stringify(o));

      const title = await page.locator('header h1').innerText().catch(() => '');
      check(`console ${label} is titled in the header`, title.trim() === label, title);

      const small = await measureTargets(page);
      check(`console ${label} has no controls too small to tap`, small.length === 0, small.join(', '));

      check(`console ${label} is clean on a phone`, w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
      await page.close();
    }
  }

  step('Admin console on a phone — the menu');
  {
    const adminToken = await adminPage.evaluate(() => localStorage.getItem('px_admin_token'));
    const page = await phone.newPage();
    await page.goto(`${ADMIN}/login`);
    await page.evaluate(([k, t]) => { localStorage.setItem(k, t); localStorage.setItem('fg_token', t); },
      ['px_admin_token', adminToken]);
    const w = watch(page, 'console menu');
    await page.goto(ADMIN, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);

    // With no sidebar and no tab bar, this button is the only way to reach any
    // other screen on a phone.
    await page.click('button[aria-label="Open menu"]');
    await page.waitForTimeout(400);
    check('the menu button opens the console menu', await page.locator('aside[role="dialog"]').count() > 0);

    if (SHOT_DIR) {
      mkdirSync(path.join(SHOT_DIR, 'admin'), { recursive: true });
      await page.screenshot({ path: path.join(SHOT_DIR, 'admin', 'menu-open.png') });
    }

    await page.locator('aside[role="dialog"] a:has-text("System Logs")').click();
    await page.waitForTimeout(700);
    check('a console menu link navigates', page.url().includes('/audit-logs'), page.url());
    check('the console menu closes behind it', await page.locator('aside[role="dialog"]').count() === 0);

    check('the console menu is clean', w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await page.close();
  }

  step('Admin console on a tablet — the layouts hold at 820px');
  {
    const token = await adminPage.evaluate(() => localStorage.getItem('px_admin_token'));
    for (const [route, label] of [['', 'Overview'], ['users', 'User Management'], ['settings', 'Settings']]) {
      const page = await tablet.newPage();
      await page.goto(`${ADMIN}/login`);
      await page.evaluate(([k, t]) => { localStorage.setItem(k, t); localStorage.setItem('fg_token', t); },
        ['px_admin_token', token]);
      const w = watch(page, `tablet ${label}`);
      await page.goto(`${ADMIN}/${route}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);

      if (SHOT_DIR) {
        mkdirSync(path.join(SHOT_DIR, 'tablet-admin'), { recursive: true });
        await page.screenshot({
          path: path.join(SHOT_DIR, 'tablet-admin', `${route || 'overview'}.png`), fullPage: true,
        });
      }

      const o = await measureOverflow(page);
      check(`console ${label} fits a tablet`, o.width <= o.viewport + 1, JSON.stringify(o));

      const small = await measureTargets(page);
      check(`console ${label} has no controls too small to tap on a tablet`, small.length === 0, small.join(', '));

      check(`console ${label} is clean on a tablet`, w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
      await page.close();
    }
  }

  // The rail is the console's only navigation on a desktop, and both of the
  // ways it can be made smaller — collapsing it to icons, folding a section —
  // hide the links rather than remove them. Either one is a way to strand
  // somebody on the screen they are already on, so both are driven here.
  step('Admin console — the rail collapses, folds and is remembered');
  {
    const token = await adminPage.evaluate(() => localStorage.getItem('px_admin_token'));
    const page = await browser.newPage();
    await page.goto(`${ADMIN}/login`);
    await page.evaluate(([k, t]) => { localStorage.setItem(k, t); localStorage.setItem('fg_token', t); },
      ['px_admin_token', token]);
    const w = watch(page, 'console rail');
    await page.goto(ADMIN, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    const railWidth = () => page.locator('aside').evaluate((el) => el.getBoundingClientRect().width);
    check('the rail is at full width to begin with', await railWidth() > 200, `${await railWidth()}px`);

    await page.click('button[title="Collapse sidebar"]');
    await page.waitForTimeout(500);
    const collapsed = await railWidth();
    check('the rail collapses to icon width', collapsed < 100, `${collapsed}px`);

    if (process.env.BROWSER_E2E_SHOTS) {
      mkdirSync(path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin'), { recursive: true });
      await page.screenshot({
        path: path.join(process.env.BROWSER_E2E_SHOTS, 'desktop-admin', 'rail-collapsed.png'),
      });
    }

    // A preference nobody has to set twice.
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    check('the collapsed rail is remembered across a reload', await railWidth() < 100, `${await railWidth()}px`);

    // Icons only, but every screen is still one click away.
    await page.locator('aside a[title="System Logs"]').click();
    await page.waitForTimeout(700);
    check('a collapsed rail still navigates', page.url().includes('/audit-logs'), page.url());

    await page.click('button[title="Expand sidebar"]');
    await page.waitForTimeout(500);
    check('the rail expands again', await railWidth() > 200, `${await railWidth()}px`);

    const section = page.locator('button[aria-controls="rail-section-operations"]');
    await section.click();
    await page.waitForTimeout(400);
    check('a rail section folds', await section.getAttribute('aria-expanded') === 'false');
    check('a folded section takes its links out of the tab order',
      await page.locator('#rail-section-operations a[tabindex="-1"]').count() > 0);

    // The section holding the current screen is opened again on arrival, so a
    // fold can never hide where you are.
    await page.goto(`${ADMIN}/billing`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    check('the section holding the current screen reopens',
      await page.locator('button[aria-controls="rail-section-operations"]').getAttribute('aria-expanded') === 'true');

    check('the rail is clean', w.problems.length === 0, w.problems.slice(0, 2).join(' | '));
    await page.close();
  }

  await phone.close();
  await tablet.close();
  await adminPage.close();
  await db.close();
} catch (err) {
  failures.push(`harness error: ${err.message}`);
  console.error(err);
} finally {
  shutdown();
}

console.log(`\n${'\u2500'.repeat(60)}`);
if (failures.length) {
  console.log(`FAILED \u2014 ${passed} passed, ${failures.length} failed\n`);
  failures.forEach((f) => console.log(`  \u2717 ${f}`));
  process.exitCode = 1;
} else {
  console.log(`PASSED \u2014 ${passed} checks`);
}
