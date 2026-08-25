#!/usr/bin/env node
/**
 * Child Desktop end-to-end test.
 *
 * Boots a real Parentix API and drives the desktop agent's actual service layer
 * against it. `api.js`, `socket.js`, `rules.js`, `screenTime.js`, `appControl.js`,
 * `webFilter.js`, `webHistory.js`, `chat.js` and `agent.js` are the shipping
 * modules; only the platform contract is stubbed, and only for the four things
 * that genuinely need an operating system — which application is in front,
 * closing one, changing the resolver, and showing a lock screen.
 *
 * Two things here are deliberately not mocked, because a mock of either would
 * agree with code that a real one would not:
 *
 *   - **The DNS proxy is the real one**, listening on a high port, with a real
 *     upstream resolver run by this harness on the loopback. Blocked and allowed
 *     lookups are sent as actual DNS packets and the response codes are read off
 *     the wire.
 *   - **A parent socket connects alongside**, so every assertion about "the
 *     parent sees it" is checked on a real second client rather than inferred
 *     from the fact that we emitted something.
 *
 * What it does not cover: PowerShell, `lsappinfo`, `networksetup`, Electron. The
 * platform modules are what a machine has to verify, and those need a machine.
 *
 *   npm --prefix apps/child-desktop/windows run test:e2e
 */
import { register } from 'node:module';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const SHARED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_ROOT = path.resolve(SHARED_ROOT, '../../../services/api');

/**
 * Which platform project supplies the libraries.
 *
 * This harness sits in the shared package, which has no `node_modules` of its
 * own — every library is a peerDependency so the copy in a build is always the
 * platform project's. The project that ran `npm run test:e2e` is the cwd, and
 * that is what gets anchored: here for the harness's own requires, and through
 * `loader.mjs` for the agent modules it drives.
 *
 * Either platform can run it. Nothing below reaches the operating system, so
 * this proves the wire protocol and the agent's decisions rather than anything
 * platform-specific.
 */
const PROJECT_ROOT = path.resolve(process.env.DESKTOP_E2E_PROJECT || process.cwd());
if (!existsSync(path.join(PROJECT_ROOT, 'node_modules'))) {
  console.error(
    `No node_modules in ${PROJECT_ROOT}\n\n`
    + 'Run this from a platform project:\n'
    + '  npm --prefix apps/child-desktop/windows run test:e2e\n'
    + 'or point DESKTOP_E2E_PROJECT at one.',
  );
  process.exit(1);
}

register('./loader.mjs', import.meta.url, { data: { projectRoot: PROJECT_ROOT } });

const require = createRequire(path.join(PROJECT_ROOT, 'package.json'));
const { io } = require('socket.io-client');

const PORT = Number(process.env.DESKTOP_E2E_PORT || 5397);
/**
 * Well above the ranges Windows reserves.
 *
 * The obvious choice for a test resolver is 5353 or 5354, and on Windows both
 * are inside an excluded port range — WinNAT and LLMNR hold blocks down there,
 * and a bind gets `EACCES` even from an administrator. That failure presents as
 * a harness that produces no output and exits 0, which is a genuinely confusing
 * half hour, so: high ports, and a bind error that is reported rather than left
 * to hang a promise.
 */
const DNS_PORT = Number(process.env.DESKTOP_E2E_DNS_PORT || 15353);
const UPSTREAM_PORT = DNS_PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const step = (title) => console.log(`\n${title}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── A resolver for the proxy to forward to ───────────────────────────────────
//
// Answers NOERROR with no records to anything it is asked. That is enough: the
// question under test is whether an allowed lookup is relayed at all, and
// NOERROR against the proxy's own NXDOMAIN is an unambiguous answer.
const upstream = dgram.createSocket('udp4');
let upstreamQueries = 0;
upstream.on('message', (msg, rinfo) => {
  upstreamQueries += 1;
  const reply = Buffer.from(msg);
  reply.writeUInt16BE(0x8180, 2); // QR=1, RD, RA, RCODE=0
  upstream.send(reply, rinfo.port, rinfo.address);
});

/** Build a standard A query for `name`. */
const dnsQuestion = (name, id) => {
  const labels = name.split('.');
  const size = 12 + labels.reduce((total, label) => total + label.length + 1, 0) + 1 + 4;
  const buffer = Buffer.alloc(size);
  buffer.writeUInt16BE(id, 0);
  buffer.writeUInt16BE(0x0100, 2); // standard query, recursion desired
  buffer.writeUInt16BE(1, 4);
  let offset = 12;
  for (const label of labels) {
    buffer.writeUInt8(label.length, offset);
    buffer.write(label, offset + 1, 'ascii');
    offset += label.length + 1;
  }
  buffer.writeUInt8(0, offset);
  buffer.writeUInt16BE(1, offset + 1);  // A
  buffer.writeUInt16BE(1, offset + 3);  // IN
  return buffer;
};

/** Ask the agent's resolver, and read the response code back off the wire. */
const resolve = (name) => new Promise((resolveWith, reject) => {
  const socket = dgram.createSocket('udp4');
  const id = Math.floor(Math.random() * 0xffff);
  const timer = setTimeout(() => { socket.close(); reject(new Error(`no answer for ${name}`)); }, 4000);
  socket.on('message', (msg) => {
    clearTimeout(timer);
    socket.close();
    resolveWith({ id: msg.readUInt16BE(0), rcode: msg.readUInt16BE(2) & 0x0f });
  });
  socket.on('error', (err) => { clearTimeout(timer); socket.close(); reject(err); });
  socket.send(dnsQuestion(name, id), DNS_PORT, '127.0.0.1');
});

// ── Boot the API ─────────────────────────────────────────────────────────────
const dataDir = mkdtempSync(path.join(tmpdir(), 'parentix-desktop-e2e-'));
let serverOutput = '';

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: API_ROOT,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(PORT),
    LOG_LEVEL: 'info',
    DATABASE_URL: '',
    DB_PATH: path.join(dataDir, 'desktop-e2e.sqlite'),
    JWT_SECRET: 'desktop-e2e-secret-that-is-long-enough',
    FIELD_ENCRYPTION_KEY: 'a'.repeat(64),
    CLIENT_URL: 'http://localhost:3000',
    ADMIN_URL: 'http://localhost:3001',
    EMAIL_PROVIDER: 'none',
    STORAGE_PROVIDER: 'none',
    STRIPE_SECRET_KEY: '',
    REDIS_URL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => { serverOutput += chunk; });
server.stderr.on('data', (chunk) => { serverOutput += chunk; });

const waitFor = (predicate, label, timeout = 20000) =>
  new Promise((resolveWith, reject) => {
    const deadline = Date.now() + timeout;
    const tick = () => {
      const value = predicate();
      if (value) return resolveWith(value);
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 50);
    };
    tick();
  });

const call = async (method, urlPath, { token, body } = {}) => {
  const res = await fetch(`${BASE}/api${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
};

let parentSocket = null;
const cleanup = () => {
  try { parentSocket?.disconnect(); } catch { /* already gone */ }
  try { upstream.close(); } catch { /* already gone */ }
  server.kill('SIGTERM');
  setTimeout(() => server.kill('SIGKILL'), 3000).unref();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* the OS reclaims it */ }
};

const src = (file) => pathToFileURL(path.join(SHARED_ROOT, 'src', file)).href;

const run = async () => {
  await new Promise((resolveWith, reject) => {
    upstream.once('error', reject);
    upstream.bind(UPSTREAM_PORT, '127.0.0.1', resolveWith);
  });
  await waitFor(() => serverOutput.includes('Parentix API listening'), 'server startup', 30000);

  // Read at import time by api.js, socket.js and webFilter.js.
  process.env.PARENTIX_API_URL = `${BASE}/api`;
  process.env.PARENTIX_SOCKET_URL = BASE;
  process.env.PARENTIX_DNS_PORT = String(DNS_PORT);
  process.env.PARENTIX_DNS_UPSTREAM_PORT = String(UPSTREAM_PORT);

  const { setPlatform } = await import(src('platform/index.js'));
  const fake = await import('./fake-platform.mjs');
  setPlatform(fake.createFakePlatform({ dataDir: path.join(dataDir, 'agent') }));

  // ── Parent-side fixture ────────────────────────────────────────────────────
  step('Parent sets up a child, rules and a computer');
  const email = `desktop_e2e_${Date.now()}@parentix.test`;
  await call('POST', '/auth/register', { body: { name: 'E2E Parent', email, password: 'desktop-e2e-pass-1' } });
  const verificationCode = await waitFor(
    () => serverOutput.match(new RegExp(`"email":"${email}","code":"(\\d{6})"`))?.[1],
    'the verification code',
  );
  const verify = await call('POST', '/auth/verify-email', { body: { email, code: verificationCode } });
  const parentToken = verify.data.token;
  check('the parent account is ready', !!parentToken);

  const child = await call('POST', '/children', { token: parentToken, body: { name: 'Ada', age: 11 } });
  const childId = child.data.id;
  check('a child profile exists', child.status === 201, JSON.stringify(child.data));

  await call('PUT', `/screen-time/${childId}`, {
    token: parentToken,
    body: { dailyLimitMinutes: 120, bedtimeStart: '21:00', bedtimeEnd: '07:00' },
  });
  await call('POST', `/blocking/${childId}/apps`, {
    token: parentToken,
    // An executable name, which is what a Windows agent reports and what the
    // parent's "known apps" picker will offer once this machine has synced.
    body: { appName: 'Steam', appPackage: 'steam.exe', action: 'block' },
  });
  await call('POST', `/blocking/${childId}/websites`, {
    token: parentToken,
    body: { url: 'bad.example.com', category: 'custom', action: 'block' },
  });

  // ── Linking ────────────────────────────────────────────────────────────────
  step('The computer links itself');
  /*
   * Generated as an Android device on purpose. The parent picks a type from a
   * dashboard that is not the computer being set up, so getting it wrong is the
   * ordinary case rather than an edge one — and the agent correcting its own row
   * as it links is what keeps the icon and label in the device list honest.
   */
  const link = await call('POST', '/devices/link', {
    token: parentToken,
    body: { childId, deviceName: "Ada's Laptop", type: 'android' },
  });
  const linkCode = link.data.code;
  check('the parent can generate a code for a computer', !!linkCode, JSON.stringify(link.data));

  const agent = await import(src('services/agent.js'));
  const linkSvc = await import(src('services/link.js'));
  const store = await import(src('services/store.js'));

  const linkedDevice = await agent.linkThisDevice(linkCode.toLowerCase());
  check('the agent exchanges the code for a device token', await linkSvc.hasLink());
  check('a lowercase code is accepted', !!linkedDevice);
  check('the device corrects its own type to windows', linkedDevice.type === 'windows', String(linkedDevice.type));
  check('the device reports its OS version',
    linkedDevice.osVersion === 'Windows 11 Pro 10.0.26200', String(linkedDevice.osVersion));
  check('the credential is stored through the shipping path',
    (await store.getItem('fg_device_token')) === (await linkSvc.getDeviceToken()));

  const replay = await call('POST', '/devices/confirm', { body: { code: linkCode } });
  check('the same code cannot be redeemed twice', replay.status === 404, String(replay.status));

  const devices = await call('GET', '/devices', { token: parentToken });
  check('the parent sees one linked computer',
    devices.data.length === 1 && devices.data[0].type === 'windows' && devices.data[0].isLinked,
    JSON.stringify(devices.data.map((d) => ({ type: d.type, linked: d.isLinked }))));

  // ── Parent realtime listener ───────────────────────────────────────────────
  const parentEvents = { alerts: [], messages: [], deviceLinks: [] };
  parentSocket = io(BASE, { auth: { token: parentToken }, transports: ['websocket'], reconnection: false });
  parentSocket.on('alert:new', (alert) => parentEvents.alerts.push(alert));
  parentSocket.on('chat:message', (message) => parentEvents.messages.push(message));
  parentSocket.on('device:linked', (device) => parentEvents.deviceLinks.push(device));
  await new Promise((resolveWith, reject) => {
    parentSocket.on('connect', resolveWith);
    parentSocket.on('connect_error', reject);
    setTimeout(() => reject(new Error('parent socket timeout')), 8000);
  });
  check('the parent socket is connected', parentSocket.connected);

  // ── The agent starts ───────────────────────────────────────────────────────
  step('The agent applies the parent\'s rules');
  await agent.startAgent();
  let status = agent.getAgentStatus();

  check('the computer fetched its rules',
    status.rules.appRules.length === 1 && status.rules.websiteRules.length === 1,
    JSON.stringify({ apps: status.rules.appRules.length, sites: status.rules.websiteRules.length }));
  check('the blocked app is in the enforced set',
    status.blockedApps.includes('steam.exe'), JSON.stringify(status.blockedApps));
  check('the blocked website reached the resolver',
    status.blockedDomains.includes('bad.example.com'), JSON.stringify(status.blockedDomains));
  check('the local resolver is listening', status.webFilter.running === true, status.webFilter.lastError || '');
  check('the rules were cached for an offline start', !!(await store.readJson('fg_device_rules')));
  check('the child\'s name arrived with the rules', status.childName === 'Ada', String(status.childName));

  // ── Real DNS, on the wire ──────────────────────────────────────────────────
  step('The resolver blocks, relays and records');
  const before = upstreamQueries;
  const blockedAnswer = await resolve('www.bad.example.com');
  const allowedAnswer = await resolve('good.example.com');
  const canaryAnswer = await resolve('use-application-dns.net');
  const dohAnswer = await resolve('mozilla.cloudflare-dns.com');

  // A rule for `bad.example.com` covers the site, not one hostname.
  check('a blocked domain is refused, subdomains included', blockedAnswer.rcode === 3, `rcode ${blockedAnswer.rcode}`);
  check('an allowed domain is relayed to the real resolver',
    allowedAnswer.rcode === 0 && upstreamQueries > before, `rcode ${allowedAnswer.rcode}, upstream +${upstreamQueries - before}`);
  /*
   * The Firefox canary. Answering NXDOMAIN is how a managed network tells
   * Firefox not to switch itself to DNS-over-HTTPS. Without it a Firefox install
   * silently stops being filtered and stops appearing in web history, with
   * nothing anywhere to indicate it — the single most likely way for this
   * feature to be quietly wrong.
   */
  check('the Firefox DoH canary is refused', canaryAnswer.rcode === 3, `rcode ${canaryAnswer.rcode}`);
  check('a DNS-over-HTTPS endpoint is refused', dohAnswer.rcode === 3, `rcode ${dohAnswer.rcode}`);

  const { flushVisits } = await import(src('services/webFilter.js'));
  const { ingestVisits, uploadWebHistory } = await import(src('services/webHistory.js'));
  await ingestVisits(flushVisits());
  await uploadWebHistory();

  const history = await call('GET', `/activity/${childId}?category=browsing`, { token: parentToken });
  const rows = history.data.rows || [];
  const badRow = rows.find((row) => row.url === 'www.bad.example.com');
  const goodRow = rows.find((row) => row.url === 'good.example.com');
  check('the parent sees the site that was visited', !!goodRow, JSON.stringify(rows.map((r) => r.url)));
  check('the parent sees the site that was blocked, marked as blocked',
    !!badRow && badRow.blocked === true, JSON.stringify({ found: !!badRow, blocked: badRow?.blocked }));
  check('the canary is not reported as browsing',
    !rows.some((row) => row.url === 'use-application-dns.net'), JSON.stringify(rows.map((r) => r.url)));

  // ── Screen time ────────────────────────────────────────────────────────────
  step('Screen time is measured and reported');
  const screenTime = await import(src('services/screenTime.js'));

  /**
   * Time is fed in as timestamps rather than by waiting for it.
   *
   * `observe` is the shipping function and takes the instant as an argument for
   * exactly this reason. The step is 60s because anything above the 90s ceiling
   * is treated as a gap the child was not present for — which is the behaviour
   * the next check exercises directly.
   */
  const accumulate = (sample, minutes, start) => {
    for (let i = 0; i < minutes; i += 1) screenTime.observe(sample, start + i * 60_000);
    screenTime.observe(null, start + minutes * 60_000);
    return start + minutes * 60_000;
  };

  const t0 = Date.now();
  const chrome = { appId: 'chrome.exe', appName: 'Google Chrome' };
  accumulate(chrome, 25, t0);

  check('the computer measured its own screen time',
    screenTime.getScreenTime().todayMinutes === 25, String(screenTime.getScreenTime().todayMinutes));

  /*
   * A closed laptop. The platform watcher stops sampling when nobody is at the
   * machine, but a suspend can also simply swallow the ticks — so a gap longer
   * than the ceiling is credited to nobody. Without this, a laptop left open on
   * a browser spends a child's whole allowance while they are at dinner.
   */
  screenTime.observe(chrome, t0 + 60 * 60_000);
  screenTime.observe(chrome, t0 + 120 * 60_000);
  check('an hour-long gap is not charged to anyone',
    screenTime.getScreenTime().todayMinutes === 25, String(screenTime.getScreenTime().todayMinutes));

  await screenTime.uploadUsage();
  const activity = await call('GET', `/activity/${childId}`, { token: parentToken });
  const usage = (activity.data.rows || []).filter((row) => row.appPackage === 'chrome.exe');
  check('the parent sees the reported app usage',
    usage.length === 1 && usage[0].durationMinutes === 25,
    JSON.stringify(usage.map((row) => row.durationMinutes)));

  const known = await call('GET', `/blocking/${childId}/apps/known`, { token: parentToken });
  check('the app appears in the parent\'s app picker',
    (known.data || []).some((app) => app.appPackage === 'chrome.exe' && app.appName === 'Google Chrome'),
    JSON.stringify(known.data));

  // ── Blocking an app ────────────────────────────────────────────────────────
  step('A blocked app is closed, and the parent is told');
  fake.resetSpy();
  fake.emitForeground({ appId: 'steam.exe', appName: 'Steam' });
  await waitFor(() => fake.spy.closed.length > 0, 'the blocked app to be closed');
  check('the blocked app was closed', fake.spy.closed[0]?.appId === 'steam.exe', JSON.stringify(fake.spy.closed));
  /*
   * An application that vanishes with no explanation reads as a crash, and a
   * child who thinks the laptop is broken tells nobody.
   */
  check('the child is told why it closed',
    fake.spy.notifications.some((n) => n.title.includes('Steam')), JSON.stringify(fake.spy.notifications));

  const blockedAlert = await waitFor(
    () => parentEvents.alerts.find((alert) => alert.type === 'blocked_app_attempt'),
    'the blocked-app alert',
  );
  check('the parent is told a blocked app was opened', blockedAlert.message.includes('Steam'), blockedAlert.message);

  // Opening it again immediately is the same piece of news, not a second one.
  fake.emitForeground({ appId: 'steam.exe', appName: 'Steam' });
  await sleep(300);
  check('re-opening it straight away does not raise a second alert',
    parentEvents.alerts.filter((alert) => alert.type === 'blocked_app_attempt').length === 1,
    String(parentEvents.alerts.filter((alert) => alert.type === 'blocked_app_attempt').length));

  // An app with no rule is left alone.
  fake.resetSpy();
  fake.emitForeground({ appId: 'code.exe', appName: 'Visual Studio Code' });
  await sleep(300);
  check('an app with no rule is left alone', fake.spy.closed.length === 0, JSON.stringify(fake.spy.closed));

  // ── The daily limit ────────────────────────────────────────────────────────
  step('The daily limit locks the computer');
  fake.resetSpy();
  await call('PUT', `/screen-time/${childId}`, {
    token: parentToken,
    body: { dailyLimitMinutes: 20, bedtimeStart: '21:00', bedtimeEnd: '07:00' },
  });

  await waitFor(() => fake.spy.lock !== null, 'the lock screen');
  check('the lock screen is shown', fake.spy.lock?.reason === 'daily_limit', JSON.stringify(fake.spy.lock));
  check('a rules change reaches the computer over the socket', fake.spy.lockShows === 1, String(fake.spy.lockShows));

  const limitAlert = await waitFor(
    () => parentEvents.alerts.find((alert) => alert.type === 'screen_time_exceeded'),
    'the screen-time alert',
  );
  check('the parent is told the limit was reached', !!limitAlert);

  /*
   * A full lock closes nothing. Bedtime arriving mid-essay must not be the thing
   * that loses the essay — the lock screen takes the display and leaves the work
   * underneath it.
   */
  fake.emitForeground({ appId: 'code.exe', appName: 'Visual Studio Code' });
  await sleep(300);
  check('a lock does not close what the child had open',
    fake.spy.closed.length === 0, JSON.stringify(fake.spy.closed));

  // Lifting the limit releases it, which is the half a naive implementation
  // forgets: the lock has to be revocable by the clock and by the parent.
  await call('PUT', `/screen-time/${childId}`, {
    token: parentToken,
    body: { dailyLimitMinutes: 600, bedtimeStart: '21:00', bedtimeEnd: '07:00' },
  });
  await waitFor(() => fake.spy.lockHides > 0, 'the lock to be lifted');
  check('lifting the limit unlocks the computer', agent.getAgentStatus().locked === false);

  /*
   * ── The daily limit does not have to take the whole desktop ────────────────
   *
   * Every lock used to be the same lock: a child who spent their twenty minutes
   * lost the essay editor along with the game. The daily limit is now the one
   * reason the parent's allowlist survives, and on a desktop it survives only if
   * the child asks — the lock screen still comes up, so bedtime arriving mid-essay
   * still cannot be the thing that loses the essay.
   */
  step('Apps the parent left open survive the daily limit');
  fake.resetSpy();
  const allowRule = await call('POST', `/blocking/${childId}/apps`, {
    token: parentToken,
    body: { appName: 'Visual Studio Code', appPackage: 'code.exe', action: 'allow' },
  });
  check('the parent can mark an app as open past the limit',
    allowRule.status === 201, JSON.stringify(allowRule.data));

  await call('PUT', `/screen-time/${childId}`, {
    token: parentToken,
    body: { dailyLimitMinutes: 20, bedtimeStart: '21:00', bedtimeEnd: '07:00' },
  });
  await waitFor(() => fake.spy.lock !== null, 'the lock screen');

  check('the lock is the porous tier', fake.spy.lock?.tier === 'limit', JSON.stringify(fake.spy.lock));
  check('the lock screen names what is still open',
    (fake.spy.lock?.allowedApps || []).includes('Visual Studio Code'), JSON.stringify(fake.spy.lock));
  check('the agent knows which apps those are',
    agent.getAgentStatus().allowedApps.includes('code.exe'),
    JSON.stringify(agent.getAgentStatus().allowedApps));

  /*
   * Until the child asks, nothing changes: the screen is taken and the work
   * underneath it is untouched. This is the half that must not regress.
   */
  fake.emitForeground({ appId: 'steam.exe', appName: 'Steam' });
  await sleep(300);
  check('a lock still closes nothing before the child asks',
    fake.spy.closed.length === 0, JSON.stringify(fake.spy.closed));

  const taken = agent.useAllowedApps();
  check('the child can take the desktop back on the allowlist\'s terms', taken.ok === true);
  check('the lock screen goes when they do', fake.spy.lockHides > 0, String(fake.spy.lockHides));
  check('the computer is still locked underneath',
    agent.getAgentStatus().locked === true && agent.getAgentStatus().allowlistMode === true);

  fake.resetSpy();
  fake.emitForeground({ appId: 'code.exe', appName: 'Visual Studio Code' });
  await sleep(300);
  check('the allowed app is left alone', fake.spy.closed.length === 0, JSON.stringify(fake.spy.closed));

  /*
   * A fresh application, not Steam. Steam was closed a few steps ago and
   * `REPEAT_ACTION_MS` is fifteen seconds, so re-using it here asserts the
   * throttle rather than the allowlist — and passes or fails on how fast the
   * harness happens to run.
   *
   * It also has no rule of its own, which is the point: in allowlist mode the
   * absence of a rule is what closes an app, not the presence of one.
   */
  fake.emitForeground({ appId: 'minecraft.exe', appName: 'Minecraft' });
  await waitFor(() => fake.spy.closed.length > 0, 'the non-allowed app to be closed');
  check('an app that is not on the list closes',
    fake.spy.closed[0]?.appId === 'minecraft.exe', JSON.stringify(fake.spy.closed));
  /*
   * And says why *this* closed it. A child told "your parent has paused
   * Minecraft" when what actually happened is that the day ran out has been given
   * the wrong story about their own parent — and it is the story they will repeat
   * back at them.
   */
  check('the child is told it was the time limit, not a singling-out',
    fake.spy.notifications.some((n) => /screen time/i.test(n.body || '')),
    JSON.stringify(fake.spy.notifications));

  /*
   * The parent emptying the allowlist while the child is working inside it.
   *
   * Neither the reason nor the lock changes, so nothing in the obvious set of
   * transitions fires — and what the child is left with is a desktop that closes
   * everything they open, with the screen that would have explained it already
   * dismissed. Worse than the lock and no more permissive, so it goes back to
   * being a lock.
   */
  fake.resetSpy();
  await call('DELETE', `/blocking/${childId}/apps/${allowRule.data.id}`, { token: parentToken });
  await waitFor(() => agent.getAgentStatus().allowedApps.length === 0, 'the allow rule to be withdrawn');
  await waitFor(() => fake.spy.lock !== null, 'the lock screen to come back');
  check('emptying the allowlist puts the lock screen back',
    fake.spy.lock?.reason === 'daily_limit', JSON.stringify(fake.spy.lock));
  check('and takes the child out of allowlist mode',
    agent.getAgentStatus().allowlistMode === false);

  fake.emitForeground({ appId: 'notepad.exe', appName: 'Notepad' });
  await sleep(300);
  check('nothing is closed once the lock screen is back',
    fake.spy.closed.length === 0, JSON.stringify(fake.spy.closed));

  // Put it back for the bedtime case below.
  const allowAgain = await call('POST', `/blocking/${childId}/apps`, {
    token: parentToken,
    body: { appName: 'Visual Studio Code', appPackage: 'code.exe', action: 'allow' },
  });
  await waitFor(() => agent.getAgentStatus().allowedApps.includes('code.exe'),
    'the allow rule to come back');
  check('the child can take the desktop back again', agent.useAllowedApps().ok === true);

  /*
   * The check the whole tier split exists for. `allow` is an exception to the
   * daily limit and nothing else — and the child's dismissal must not survive the
   * lock it was granted against, or a tap at six o'clock would still be lifting
   * the lock screen at bedtime.
   */
  const nowMinute = new Date().getHours() * 60 + new Date().getMinutes();
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (minute) => {
    const wrapped = ((minute % 1440) + 1440) % 1440;
    return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
  };
  fake.resetSpy();
  await call('PUT', `/screen-time/${childId}`, {
    token: parentToken,
    body: {
      dailyLimitMinutes: 600,
      bedtimeEnabled: true,
      bedtimeStart: hhmm(nowMinute),
      bedtimeEnd: hhmm(nowMinute - 1),
    },
  });
  await waitFor(() => fake.spy.lock?.reason === 'bedtime', 'the bedtime lock');
  check('bedtime is strict', fake.spy.lock?.tier === 'strict', JSON.stringify(fake.spy.lock));
  check('the lock screen offers no way through at bedtime',
    (fake.spy.lock?.allowedApps || []).length === 0, JSON.stringify(fake.spy.lock));
  check('the child\'s earlier dismissal did not survive the change of lock',
    agent.getAgentStatus().allowlistMode === false);
  check('and cannot be taken again', agent.useAllowedApps().ok === false);

  fake.emitForeground({ appId: 'code.exe', appName: 'Visual Studio Code' });
  await sleep(300);
  check('bedtime closes nothing either', fake.spy.closed.length === 0, JSON.stringify(fake.spy.closed));

  /*
   * ── "Can I have more time?" now has an answer ──────────────────────────────
   *
   * The lock screen has offered to ask since it was written. Saying yes meant
   * editing the daily limit and remembering to put it back, which nobody does.
   */
  step('Extra time granted by the parent lifts the lock');
  fake.resetSpy();
  await call('PUT', `/screen-time/${childId}`, {
    token: parentToken,
    body: { dailyLimitMinutes: 20, bedtimeEnabled: false, bedtimeStart: '21:00', bedtimeEnd: '07:00' },
  });
  await waitFor(() => fake.spy.lock?.reason === 'daily_limit', 'the daily-limit lock');

  const granted = await call('POST', `/screen-time/${childId}/grant`, {
    token: parentToken, body: { minutes: 60 },
  });
  check('the parent can grant extra time', granted.status === 201, JSON.stringify(granted.data));

  // Over the socket, not at the next five-minute poll — the parent tapping this
  // is standing next to the child who asked.
  await waitFor(() => agent.getAgentStatus().locked === false, 'the grant to lift the lock');
  check('the granted minutes lift the lock', agent.getAgentStatus().locked === false);
  check('the granted minutes are counted', agent.getAgentStatus().bonusMinutes === 60,
    String(agent.getAgentStatus().bonusMinutes));
  check('the lock screen is taken down', fake.spy.lockHides > 0, String(fake.spy.lockHides));

  await call('DELETE', `/blocking/${childId}/apps/${allowAgain.data.id}`, { token: parentToken });
  await call('PUT', `/screen-time/${childId}`, {
    token: parentToken,
    body: { dailyLimitMinutes: 600, bedtimeEnabled: false, bedtimeStart: '21:00', bedtimeEnd: '07:00' },
  });

  // ── A new app ──────────────────────────────────────────────────────────────
  step('A new app on the computer reaches the parent, and the first pass does not');
  /*
   * The first pass that sees anything is the baseline and must say nothing —
   * everything is new to a machine that has just been linked, and a parent
   * should not be greeted by an alert per application in their first quarter
   * hour of owning the product.
   *
   * The pass inside `startAgent` above does not count: the agent had not
   * measured anything yet, so it reported an empty set, and treating *that* as
   * the baseline is what would make the next pass announce the whole laptop.
   */
  await agent.__testing.syncPass();
  check('the first pass that sees anything announces nothing',
    parentEvents.alerts.filter((alert) => alert.type === 'app_installed').length === 0,
    JSON.stringify(parentEvents.alerts.map((alert) => alert.type)));

  accumulate({ appId: 'discord.exe', appName: 'Discord' }, 3, t0 + 200 * 60_000);
  await agent.__testing.syncPass();

  const newApp = await waitFor(
    () => parentEvents.alerts.find((alert) => alert.type === 'app_installed'),
    'the new-app alert',
  );
  check('the parent is told about an app this computer has not seen before',
    newApp.message.includes('Discord'), newApp.message);

  // ── Chat ───────────────────────────────────────────────────────────────────
  step('The child and the parent can talk');
  const chat = await import(src('services/chat.js'));
  fake.resetSpy();

  await chat.sendMessage('Can I have more time on the computer, please?');
  const askedMessage = await waitFor(
    () => parentEvents.messages.find((message) => message.text.includes('more time')),
    'the message reaching the parent',
  );
  check('a message from the computer reaches the parent', askedMessage.senderRole === 'child');

  parentSocket.emit('chat:reply', { childId, text: 'Ten more minutes.' });
  await waitFor(() => fake.spy.notifications.some((n) => n.body === 'Ten more minutes.'), 'the reply notification');
  check('the parent\'s reply is shown on the computer',
    fake.spy.notifications.some((n) => n.title === 'Message from your parent'),
    JSON.stringify(fake.spy.notifications));

  const thread = await chat.fetchMessages();
  check('the thread holds both sides', thread.length >= 2, String(thread.length));

  // ── Bedtime maths, shared with the phone ───────────────────────────────────
  step('Bedtime is interpreted the same way as on the phone');
  const { lockState, bonusMinutesFrom, minutesUntilLimit, tierFor } =
    await import(src('services/schedule.js'));
  const at = (hours, minutes = 0) => new Date(2026, 0, 5, hours, minutes); // a Monday
  const bedtime = { bedtimeEnabled: true, bedtimeStart: '21:00', bedtimeEnd: '07:00' };

  check('22:00 is inside a 21:00→07:00 bedtime', lockState(bedtime, 0, at(22)).reason === 'bedtime');
  check('02:00 is inside it too — the window wraps past midnight',
    lockState(bedtime, 0, at(2)).reason === 'bedtime');
  check('08:00 is outside it', lockState(bedtime, 0, at(8)).blocked === false);
  check('an unchecked day carries no restriction',
    lockState({ schedule: { monday: { enabled: false, start: '09:00', end: '10:00' } } }, 0, at(15)).blocked === false);
  check('an hour outside an enabled day is a lock',
    lockState({ schedule: { monday: { enabled: true, start: '09:00', end: '10:00' } } }, 0, at(15)).reason === 'outside_schedule');
  check('a deactivated rule blocks nothing',
    lockState({ ...bedtime, isActive: false }, 0, at(22)).blocked === false);

  /*
   * A parent's pause on this one machine, which outranks every clock-driven
   * reason — and has to work where those cannot reach: with no screen-time rule
   * at all, and with the rule switched off. Switching the schedule off is how a
   * parent lifts a bedtime; it must not be how a child lifts a block.
   */
  const paused = { reason: 'blocked_by_parent', since: '2026-08-17T12:00:00.000Z' };
  check('a parent block locks the computer',
    lockState(bedtime, 0, at(10), paused).reason === 'blocked_by_parent');
  check('a parent block locks with no rule at all',
    lockState(null, 0, at(10), paused).blocked === true);
  check('a parent block outranks a switched-off rule',
    lockState({ ...bedtime, isActive: false }, 0, at(22), paused).blocked === true);
  check('an unrecognised block payload still locks',
    lockState(bedtime, 0, at(10), { since: null }).reason === 'blocked_by_parent');
  check('no block leaves the ordinary rules in charge',
    lockState(bedtime, 0, at(10), null).blocked === false);

  /*
   * ── Tiers and granted minutes, also shared with the phone ──────────────────
   *
   * `schedule.js` is a deliberate character-for-character copy of the phone's,
   * because the two clients must not arrive at two readings of one rule. These
   * are the phone's own cases run against this copy — a bedtime that starts at a
   * different minute on a laptop, or a granted fifteen minutes that expires on
   * one and not the other, is a support call nobody can reproduce.
   */
  const spent = { dailyLimitMinutes: 120, isActive: true };
  check('the daily limit is the porous lock', lockState(spent, 130, at(10)).tier === 'limit');
  check('bedtime is strict here too', lockState(bedtime, 0, at(22)).tier === 'strict');
  check('a parent\'s pause is strict', lockState(spent, 0, at(10), paused).tier === 'strict');
  check('an unlocked computer has no tier', lockState(spent, 0, at(10)).tier === null);
  check('tierFor agrees with what lockState returns',
    tierFor('daily_limit') === 'limit' && tierFor('bedtime') === 'strict'
    && tierFor('anything_new') === 'strict');

  const iso = (date) => date.toISOString();
  check('a grant from this morning counts at noon',
    bonusMinutesFrom([{ minutes: 15, grantedAt: iso(at(9)) }], at(12)) === 15);
  check('a grant from last night does not',
    bonusMinutesFrom([{ minutes: 15, grantedAt: iso(new Date(2026, 0, 4, 21)) }], at(12)) === 0);
  check('grants stack',
    bonusMinutesFrom([
      { minutes: 15, grantedAt: iso(at(9)) }, { minutes: 30, grantedAt: iso(at(10)) },
    ], at(12)) === 45);
  check('a grant stamped in the future is ignored',
    bonusMinutesFrom([{ minutes: 15, grantedAt: iso(at(23)) }], at(12)) === 0);
  check('a malformed grant is ignored rather than counted',
    bonusMinutesFrom([{ minutes: 'lots', grantedAt: iso(at(10)) }, { minutes: 20 }, null], at(12)) === 0);

  check('a grant lifts the daily limit', lockState(spent, 120, at(10), null, 15).blocked === false);
  check('the lock returns once the granted minutes are spent',
    lockState(spent, 135, at(10), null, 15).reason === 'daily_limit');
  check('a grant does not lift bedtime',
    lockState({ ...spent, ...bedtime }, 0, at(22), null, 60).reason === 'bedtime');
  check('a grant does not lift a parent\'s pause',
    lockState(spent, 0, at(10), paused, 60).blocked === true);

  check('the countdown includes granted minutes', minutesUntilLimit(spent, 110, 15) === 25);
  check('the countdown is null once the limit is spent', minutesUntilLimit(spent, 130, 0) === null);
  check('the countdown is null with no limit set',
    minutesUntilLimit({ ...spent, dailyLimitMinutes: 0 }, 500, 0) === null);

  // ── Recovering from a run that did not shut down cleanly ───────────────────
  /*
   * The highest-stakes path in the whole feature, and the one with no symptom
   * anyone can act on: a machine whose resolver points at 127.0.0.1 with nothing
   * listening has no internet at all, and a child cannot be expected to know
   * that `netsh` exists. The marker on disk is what a next start reads to know
   * the last one ended badly.
   */
  step('A resolver left redirected by a crash is repaired at the next start');
  fake.resetSpy();
  const webFilter = await import(src('services/webFilter.js'));
  await store.writeJson('fg_dns_backup', { upstreams: ['1.1.1.1'], at: new Date().toISOString() });

  const repaired = await webFilter.repairSystemDns();
  check('the leftover redirect is undone', repaired === true && fake.spy.dnsRestored === 1,
    JSON.stringify({ repaired, restored: fake.spy.dnsRestored }));
  check('the marker is cleared, so a healthy start does nothing',
    (await store.readJson('fg_dns_backup')) === null);
  check('a start with no marker restores nothing', (await webFilter.repairSystemDns()) === false);

  // ── Unlinking ──────────────────────────────────────────────────────────────
  step('The parent removes the computer');
  fake.resetSpy();
  const deviceId = devices.data[0].id;
  const removed = await call('DELETE', `/devices/${deviceId}`, { token: parentToken });
  check('the parent can remove it', removed.status === 200, String(removed.status));

  // The agent stopping is the last thing to happen, so waiting on it is what
  // makes the assertions below about a settled state rather than a racing one.
  await waitFor(() => agent.getAgentStatus().running === false, 'the agent to stop');
  check('the computer forgets its credential', (await linkSvc.hasLink()) === false);
  check('the cached rules go with it', (await store.readJson('fg_device_rules')) === null);
  check('the web-history backlog goes with it', (await store.readJson('fg_web_history_queue')) === null);

  /*
   * And the resolver stops answering. An unlinked machine still pointed at a
   * proxy that has gone is the same laptop-with-no-internet as above, arrived at
   * from the other direction — so the proxy is only allowed to close *after* the
   * machine has been pointed back at its own resolvers.
   */
  check('the local resolver has stopped', webFilter.getWebFilterStatus().running === false);
  let stillAnswering = true;
  try { await resolve('good.example.com'); } catch { stillAnswering = false; }
  check('nothing is listening on the resolver port any more', stillAnswering === false);

  status = agent.getAgentStatus();
  check('nothing is left blocked', status.blockedApps.length === 0 && status.blockedDomains.length === 0,
    JSON.stringify({ apps: status.blockedApps, domains: status.blockedDomains }));
};

run()
  .then(() => {
    console.log(`\n${passed} checks passed${failures.length ? `, ${failures.length} failed` : ''}`);
    if (failures.length) {
      console.error(`\nFailures:\n  ${failures.join('\n  ')}`);
      cleanup();
      process.exit(1);
    }
    cleanup();
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nHarness error:', error);
    console.error(serverOutput.split('\n').slice(-25).join('\n'));
    cleanup();
    process.exit(1);
  });
