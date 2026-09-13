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
import { existsSync, mkdtempSync, promises as fsp, rmSync } from 'node:fs';
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
// Answers every query with one A record carrying a deliberately long TTL, so a
// relayed answer read off the wire can prove the proxy capped it — the fix for a
// just-visited site staying cached after it is blocked. An answer section also
// keeps the "allowed lookup is relayed" assertions honest: NOERROR against the
// proxy's own NXDOMAIN, with a real record behind it.
const UPSTREAM_TTL = 86_400; // a day — far above the proxy's 30s cap
const upstream = dgram.createSocket('udp4');
let upstreamQueries = 0;
upstream.on('message', (msg, rinfo) => {
  upstreamQueries += 1;
  // Echo the header + question, flip to a response, and append one A record.
  // The question ends at the first zero label byte after the 12-byte header,
  // plus QTYPE and QCLASS.
  let qEnd = 12;
  while (qEnd < msg.length && msg[qEnd] !== 0) qEnd += 1 + msg[qEnd];
  qEnd += 5; // the zero byte, QTYPE (2), QCLASS (2)

  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0); // name: pointer to the question
  answer.writeUInt16BE(1, 2);      // TYPE A
  answer.writeUInt16BE(1, 4);      // CLASS IN
  answer.writeUInt32BE(UPSTREAM_TTL, 6);
  answer.writeUInt16BE(4, 10);     // RDLENGTH
  answer.writeUInt32BE(0x5db8d822, 12); // 93.184.216.34

  const reply = Buffer.concat([msg.subarray(0, qEnd), answer]);
  reply.writeUInt16BE(0x8180, 2); // QR=1, RD, RA, RCODE=0
  reply.writeUInt16BE(1, 6);      // ancount = 1
  upstream.send(reply, rinfo.port, rinfo.address);
});

/**
 * The TTL of the first A record in a relayed answer, read straight off the wire.
 * Mirrors the upstream layout above: a compression-pointer name, then TYPE at
 * the question end + 2.
 */
const answerTtl = (msg) => {
  let qEnd = 12;
  while (qEnd < msg.length && msg[qEnd] !== 0) qEnd += 1 + msg[qEnd];
  qEnd += 5;
  return msg.readUInt32BE(qEnd + 6); // name pointer (2) + TYPE (2) + CLASS (2)
};

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
    resolveWith({
      id: msg.readUInt16BE(0),
      rcode: msg.readUInt16BE(2) & 0x0f,
      ancount: msg.readUInt16BE(6),
      ttl: msg.readUInt16BE(6) ? answerTtl(msg) : null,
    });
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

  // ── First run ──────────────────────────────────────────────────────────────
  /*
   * Setting the computer up, before anything else has happened to it — which is
   * where it happens in the product, and the only point at which "first run"
   * means anything.
   *
   * The assertions worth having here are not that the steps run. They are the
   * four that decide whether a family ends up with a computer that believes it
   * is monitored and is not: that a failure leaves `setupCompleted` false, that
   * a second launch does not repeat the work, that an interrupted run comes back
   * and finishes, and that nothing a support call would read out loud contains a
   * credential.
   */
  step('The computer sets itself up, once');
  const setupSvc = await import(src('services/setup.js'));
  const setupState = () => setupSvc.getSetupState();

  const neverRun = await setupState();
  check('a computer that has never run reports a first run',
    neverRun.needed === true && neverRun.reason === 'first-run', JSON.stringify(neverRun.record));

  /*
   * No administrator permission, and none asked for. This is the case the
   * specification is most explicit about: it must not fail silently, and it must
   * not record the installation as complete.
   */
  fake.machine.elevated = false;
  const refused = await setupSvc.runSetup({ exePath: 'C:\\Parentix.exe', packaged: true, elevate: false });
  check('setup without administrator permission does not finish', refused.ok === false);
  check('it stops on the security step, and says which', refused.failed === 'security', String(refused.failed));
  check('it is reported as a permission request, not a fault', refused.needsPermission === true);
  check('the installation is NOT marked complete',
    (await setupSvc.readSetupRecord()).setupCompleted === false);
  check('the steps that needed no permission were still done',
    ['components', 'device', 'connect'].every((key) => refused.record.steps[key]?.ok === true),
    JSON.stringify(refused.record.steps));
  check('nothing was registered to start this computer',
    fake.machine.startupRegistered === false);

  /* A prompt that is dismissed is the same answer, and must read the same way. */
  fake.machine.elevationAnswer = 'refuse';
  const cancelled = await setupSvc.runSetup({ exePath: 'C:\\Parentix.exe', packaged: true, elevate: true });
  check('a refused permission prompt does not finish setup either', cancelled.ok === false);
  check('and still leaves the installation incomplete',
    (await setupSvc.readSetupRecord()).setupCompleted === false);

  /* Granted. Everything from the top — recovery is a re-run, not a resume. */
  fake.machine.elevationAnswer = 'grant';
  const progress = [];
  const done = await setupSvc.runSetup({
    exePath: 'C:\\Parentix.exe',
    packaged: true,
    elevate: true,
    appVersion: '1.0.0',
    onProgress: (event) => progress.push(`${event.key}:${event.state}`),
  });
  check('with permission, setup finishes', done.ok === true, done.error || '');
  check('every step is reported to the screen, in order',
    setupSvc.SETUP_STEPS.every(({ key }) => progress.includes(`${key}:running`) && progress.includes(`${key}:done`)),
    progress.join(' '));
  check('the computer is registered to start on its own', fake.machine.startupRegistered === true);
  check('the folder holding the credential is locked down', fake.machine.stateDirSecured === true);

  const completed = await setupSvc.readSetupRecord();
  check('the installation is marked complete, with a time', completed.setupCompleted === true && !!completed.completedAt);
  check('it has an installation identifier, and keeps it',
    /^[0-9a-f-]{36}$/i.test(completed.installId || ''), String(completed.installId));
  check('the identifier survived the failed attempts before it',
    completed.installId === refused.record.installId);
  check('a configuration file was written', existsSync(setupSvc.__testing.configPath()));

  const secondLaunch = await setupState();
  check('the next launch skips setup', secondLaunch.needed === false && secondLaunch.reason === null);

  /*
   * Interrupted: a restart in the middle of a run. The record is the only thing
   * a next launch has to go on, and this is the shape it is left in — a version
   * written, steps recorded, and `setupCompleted` false because it is cleared
   * before the first step rather than after the last.
   */
  const interrupted = { ...completed, setupCompleted: false, completedAt: null, attempts: 9 };
  await fsp.writeFile(setupSvc.__testing.recordPath(), JSON.stringify(interrupted), 'utf8');
  const resumedState = await setupState();
  check('an interrupted run is detected as unfinished, not as a first run',
    resumedState.needed === true && resumedState.reason === 'incomplete', resumedState.reason);
  const resumed = await setupSvc.runSetup({ exePath: 'C:\\Parentix.exe', packaged: true, elevate: false });
  check('and finishes on the next launch with no prompt, because permission is now held',
    resumed.ok === true, resumed.error || '');
  check('the identifier is still the same computer', resumed.record.installId === completed.installId);

  /*
   * An update that raises SETUP_VERSION, and one that does not.
   *
   * The second is the case that matters: an ordinary release must not put a
   * setup screen in front of a child for work that was done months ago.
   */
  await fsp.writeFile(
    setupSvc.__testing.recordPath(),
    JSON.stringify({ ...resumed.record, version: setupSvc.SETUP_VERSION + 1 }),
    'utf8',
  );
  check('a version this build does not recognise re-runs setup',
    (await setupState()).reason === 'update');
  await fsp.writeFile(
    setupSvc.__testing.recordPath(),
    JSON.stringify({ ...resumed.record, appVersion: '9.9.9' }),
    'utf8',
  );
  check('an ordinary update does not', (await setupState()).needed === false);

  /*
   * Running as somebody other than the person signed in.
   *
   * A parent typing their own administrator password at a prompt on the child's
   * desktop. Everything would appear to work and would be written into the
   * parent's profile — so it is refused, by name, in a sentence that says what
   * to do instead.
   */
  await setupSvc.resetSetupState();
  fake.machine.currentUser = 'HOUSE\\parent';
  const wrongAccount = await setupSvc.runSetup({ exePath: 'C:\\Parentix.exe', packaged: true, elevate: true });
  check('setting up as the wrong account is refused', wrongAccount.ok === false && wrongAccount.failed === 'security');
  check('and the refusal names both accounts',
    wrongAccount.error.includes('HOUSE\\parent') && wrongAccount.error.includes('HOUSE\\ada'), wrongAccount.error);
  fake.machine.currentUser = fake.machine.consoleUser;

  /*
   * The laptop that is not on the network yet is *not* checked here, and it is
   * worth saying why rather than leaving a gap: `api.js` reads
   * `PARENTIX_API_URL` once, at import, so there is no way to take the backend
   * away from a module graph that has already loaded without a test-only seam in
   * shipping code. It is covered by launching the real application against an
   * unreachable address instead — see §10 of docs/CHILD-DESKTOP.md.
   */

  /* Back to a finished installation, so the rest of the harness starts clean. */
  await setupSvc.runSetup({ exePath: 'C:\\Parentix.exe', packaged: true, elevate: true });

  /*
   * The log is read out over the phone and pasted into tickets. A credential in
   * it would be a credential in a support inbox, so the redaction is asserted
   * against the shapes that actually turn up: a bearer header and a JWT.
   */
  const setupLog = await fsp.readFile(setupSvc.__testing.logPath(), 'utf8');
  check('the setup log records the attempts', setupLog.includes('setup completed'));
  check('and carries nothing that looks like a credential',
    !/Bearer\s+\S+|eyJ[\w-]+\.[\w-]+\.[\w-]+/.test(setupLog));
  const sample = setupSvc.redact('failed: Bearer abc.def-ghi at https://x/y?token=zzzz and eyJhbG.ciOi.JIUz');
  check('redaction covers a header, a query string and a JWT',
    !sample.includes('abc.def-ghi') && !sample.includes('zzzz') && !sample.includes('eyJhbG.ciOi.JIUz'), sample);

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

  /*
   * The code arriving from the browser rather than from the keyboard.
   *
   * `parentix://link/<CODE>` is what the family app's "Connect this computer"
   * button fires, and the parsing is checked against a real code from a real
   * `POST /devices/link` — not a made-up string — because the thing that would
   * actually break this is the API changing the shape of a code. The delivery
   * mechanism above it (`app.on('open-url')`, the Windows re-launch argv) is
   * Electron's and cannot be driven from here; what is worth pinning is that the
   * code that comes out is the one that went in, and that nothing else does.
   */
  const setupLink = await import(src('host/setupLink.js'));
  check('a setup URL yields the code the parent was shown',
    setupLink.parseSetupUrl(`parentix://link/${linkCode}`) === linkCode,
    String(setupLink.parseSetupUrl(`parentix://link/${linkCode}`)));
  check('the same code arrives as a Windows launch argument',
    setupLink.parseSetupArgs(['C:\\Parentix.exe', `parentix://link/${linkCode}`]) === linkCode);
  check('a lowercase code from a URL is corrected',
    setupLink.parseSetupUrl(`parentix://link/${linkCode.toLowerCase()}`) === linkCode);
  /*
   * Any page the child visits can fire a `parentix://` URL, so what comes out of
   * here is a string a stranger chose. It is validated to the code format before
   * it is used, and everything else is refused — passing `parentix://link/hello`
   * on would put a server error on a screen for a link nobody clicked.
   */
  check('a URL carrying something that is not a code is refused',
    setupLink.parseSetupUrl('parentix://link/hello') === null);
  check('another application\'s scheme is refused',
    setupLink.parseSetupUrl(`myapp://link/${linkCode}`) === null);
  check('an ordinary argument list yields nothing',
    setupLink.parseSetupArgs(['C:\\Parentix.exe', '--parentix-autostart']) === null);

  /*
   * A tamper report raised before there is a socket to send it on.
   *
   * This is the real sequence, not a contrived one: `reportStartupState` runs
   * from `startAgent` *before* `connectSocket`, so the single most important
   * alert in the feature — "the agent was killed and has restarted" — is by
   * definition raised while nothing is connected. `emitSocket` drops what it
   * cannot send and says so by returning false, so a fire-and-forget emit would
   * have thrown that alert away every single time. It is queued instead; the
   * delivery is asserted further down, once the agent is running.
   */
  const tamperSvc = await import(src('services/tamper.js'));
  tamperSvc.resetTamperState();
  await tamperSvc.reportStartupState(true);
  check('a restart report raised before the socket exists is held, not lost',
    Object.keys(tamperSvc.__testing.pending()).includes('unexpected_stop'),
    JSON.stringify(tamperSvc.__testing.pending()));

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

  /*
   * The relayed answer's lifetime is capped.
   *
   * The upstream hands back a day-long TTL; the proxy must lower it so a site
   * the child had open a minute before it was blocked cannot keep resolving from
   * the OS cache. This is the desktop half of the Android caching bug, checked
   * on the wire rather than trusted.
   */
  check('a relayed answer carries a record',
    allowedAnswer.ancount === 1, `ancount ${allowedAnswer.ancount}`);
  check('and its TTL is capped so a new block bites quickly',
    allowedAnswer.ttl !== null && allowedAnswer.ttl <= 30, `ttl ${allowedAnswer.ttl}`);

  /*
   * Adding a block while the filter runs flushes the OS resolver cache, so the
   * refusal is immediate rather than at the (now 30s) TTL. Lifting one does not
   * — nothing cached needs clearing to let a name resolve again — and re-sending
   * the same list must not flush on a timer.
   */
  const webFilterSvc = await import(src('services/webFilter.js'));
  const flushesBefore = fake.spy.dnsFlushed;
  // The flush only fires once the machine is actually redirected; the harness
  // runs the proxy on a high port and never touches system DNS, so the flag that
  // gates it is set directly — the same seam the tamper check's filter test uses.
  webFilterSvc.__testing.setSystemDnsApplied(true);
  webFilterSvc.setBlockedDomains(['bad.example.com', 'newly-blocked.example.com']);
  check('blocking a new site flushes the resolver cache', fake.spy.dnsFlushed === flushesBefore + 1,
    `flushes ${fake.spy.dnsFlushed - flushesBefore}`);
  webFilterSvc.setBlockedDomains(['bad.example.com', 'newly-blocked.example.com']);
  check('re-sending the same block list does not flush again', fake.spy.dnsFlushed === flushesBefore + 1);
  webFilterSvc.setBlockedDomains(['bad.example.com']);
  check('lifting a block does not flush', fake.spy.dnsFlushed === flushesBefore + 1);
  // Put the flag back: the tamper checks below assert on an install that never
  // redirected DNS, and a stray `systemDnsApplied` left true here would have
  // them accuse a healthy unelevated machine of losing a redirect it never made.
  webFilterSvc.__testing.setSystemDnsApplied(false);

  /*
   * `capTtls` against real answers, on the awkward shapes a single-A upstream
   * never produces: a CNAME chain with compression pointers, an OPT record whose
   * "TTL" is really flags, and a truncated packet. These were captured from
   * 8.8.8.8 and are the same fixtures the Android app's DnsPacketTest uses — the
   * two implementations of this cap must agree, because the bug they fix is one.
   */
  const { capTtls } = await import(src('dns/wire.js'));
  const fixture = (s) => Buffer.from(s, 'hex');
  const recordTtls = (buf) => {
    const skip = (b, o) => { let i = o; for (;;) { const l = b[i]; if (l === 0) return i + 1; if (l >= 0xc0) return i + 2; i += l + 1; } };
    let i = 12;
    for (let k = 0; k < buf.readUInt16BE(4); k += 1) i = skip(buf, i) + 4;
    const out = [];
    const n = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
    for (let k = 0; k < n; k += 1) { i = skip(buf, i); out.push([buf.readUInt16BE(i), buf.readUInt32BE(i + 4)]); i += 10 + buf.readUInt16BE(i + 8); }
    return out;
  };
  // www.bbc.co.uk: two CNAMEs (21468s, 300s), four A (50s), then OPT.
  const bbc = fixture('abcd81800001000600000001037777770362626302636f02756b0000010001c00c00050001000053dc0014037777770362626302636f02756b03707269c010c02b000500010000012c001403626263036d617006666173746c79036e657400c04b0001000100000032000497650051c04b000100010000003200049765c051c04b0001000100000032000497654051c04b00010001000000320004976580510000290200000000000000');
  check('every lifetime over the cap comes down, CNAMEs and A alike',
    JSON.stringify(recordTtls(capTtls(bbc, 30))) === JSON.stringify([[5, 30], [5, 30], [1, 30], [1, 30], [1, 30], [1, 30], [41, 0]]));
  check('a lifetime already under the cap is left alone',
    JSON.stringify(recordTtls(capTtls(bbc, 120))) === JSON.stringify([[5, 120], [5, 120], [1, 50], [1, 50], [1, 50], [1, 50], [41, 0]]));
  // The OPT "TTL" is the extended RCODE and the DNSSEC-OK flag; capping it corrupts both.
  const optFlagged = Buffer.from(bbc); optFlagged.writeUInt32BE(0x00008000, optFlagged.length - 6);
  check('an OPT record\'s flags survive the cap',
    capTtls(optFlagged, 30).readUInt32BE(optFlagged.length - 6) === 0x00008000);
  check('a packet too short to parse is returned untouched',
    Buffer.compare(capTtls(bbc.subarray(0, 40), 30), bbc.subarray(0, 40)) === 0);
  check('capping returns a copy, leaving the original buffer intact', (() => {
    const original = Buffer.from(bbc); capTtls(original, 30); return recordTtls(original)[0][1] === 21468;
  })());

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

  // ── Tamper ─────────────────────────────────────────────────────────────────
  /*
   * The controls stopping being in force, and the parent being told.
   *
   * Driven through `__testing.check()` rather than by waiting out the two-minute
   * timer, and that is the only thing shortened here: the decision, the repair
   * and the alert are the shipping ones, and the alert is read off the parent's
   * real socket at the far end.
   */
  step('Switching the controls off tells the parent');
  const tamper = tamperSvc;
  const filterState = await import(src('services/webFilter.js'));

  /*
   * First, the report queued back before this computer had a socket. The agent
   * has been connected for several steps by now, so a flush is all it takes —
   * which is the point: the alert survived the interval in which it could not be
   * sent, rather than being lost in it.
   */
  await tamper.__testing.flush();
  const restartAlert = await waitFor(
    () => parentEvents.alerts.find((a) => a.type === 'tamper_detected' && /without shutting down/i.test(a.message)),
    'the queued restart alert',
  );
  check('the held restart report reaches the parent once there is a socket', !!restartAlert);
  /*
   * The wording, asserted deliberately. A flat battery, a power cut and a forced
   * restart all arrive here by the same route as a deliberate kill, and an alert
   * that told a parent their child had done it would be an accusation the
   * product cannot support.
   */
  check('without accusing the child of anything',
    !/child|kill|tamper/i.test(restartAlert.message), restartAlert.message);

  tamper.resetTamperState();
  const tamperAlerts = () => parentEvents.alerts.filter((a) => a.type === 'tamper_detected');
  const alertsBefore = tamperAlerts().length;
  const appliedBefore = fake.spy.dnsApplied;

  // Nothing wrong: the check must be silent on a healthy machine. This is the
  // assertion that would have caught the autostart false positive — a watcher
  // that alerts on a working computer is worse than no watcher.
  await tamper.__testing.check();
  await sleep(200);
  check('a healthy computer raises nothing',
    tamperAlerts().length === alertsBefore,
    JSON.stringify(tamperAlerts().map((a) => a.message)));

  /*
   * An install that never redirected the resolver must stay silent too, and
   * this is the state the harness is genuinely in: the proxy runs on a high
   * port, so `systemDnsApplied` is false, exactly as it is on an unelevated
   * Windows install. "The redirect you never made is missing" is not tampering.
   */
  check('an install that never redirected DNS is not accused of losing it',
    filterState.getWebFilterStatus().systemDnsApplied === false);
  fake.machine.dnsStillOurs = false;
  await tamper.__testing.check();
  await sleep(200);
  check('an unelevated install raises nothing when DNS is not ours',
    tamperAlerts().length === alertsBefore,
    JSON.stringify(tamperAlerts().map((a) => a.message)));

  /*
   * Now the elevated case: the agent did redirect the machine, and the child has
   * put DNS back to automatic — fifteen seconds in Settings, and the most
   * effective thing they can do short of ending the process. The flag is set
   * directly because a high-port proxy can never set it itself; see
   * `webFilter.__testing`.
   */
  filterState.__testing.setSystemDnsApplied(true);
  await tamper.__testing.check();

  const bypassAlert = await waitFor(() => tamperAlerts()[alertsBefore], 'the tamper alert');
  check('the parent is told the filter was bypassed',
    bypassAlert.message.toLowerCase().includes('network settings'), bypassAlert.message);
  check('the resolver was put back before the parent was told',
    fake.spy.dnsApplied > appliedBefore, `${appliedBefore} → ${fake.spy.dnsApplied}`);

  /*
   * A laptop that fights the agent — a VPN client rewriting DNS on every
   * connect — would otherwise produce an alert every two minutes, and a parent
   * who receives forty of those learns to ignore the forty-first.
   */
  fake.machine.dnsStillOurs = false;
  await tamper.__testing.check();
  await sleep(300);
  check('the same problem is not reported twice',
    tamperAlerts().length === alertsBefore + 1,
    String(tamperAlerts().length - alertsBefore));

  fake.machine.dnsStillOurs = true;

  /*
   * Start-at-sign-in being deleted is the other half, and the one with a trap in
   * it: on Windows the installer uses an elevated scheduled task, so the login
   * item Electron reports is *false* on a healthy machine. The watcher asks
   * `systemIntact`, which is the question the platform answers correctly.
   */
  tamper.resetTamperState();
  fake.machine.startupIntact = null; // "could not tell" — a policy-locked machine
  await tamper.__testing.check();
  await sleep(200);
  check('not being able to tell is not reported as tampering',
    tamperAlerts().length === alertsBefore + 1,
    String(tamperAlerts().length - alertsBefore));

  fake.machine.startupIntact = false;
  await tamper.__testing.check();
  const startupAlert = await waitFor(() => tamperAlerts()[alertsBefore + 1], 'the autostart alert');
  check('the parent is told Parentix was stopped from starting',
    startupAlert.message.toLowerCase().includes('start'), startupAlert.message);
  check('and it was switched back on', fake.machine.startupIntact === true);

  /*
   * The child's Windows account being a local administrator — the one condition
   * the agent can only surface, because an administrator can undo everything
   * above and no code running as them can stop it. It is not "put back": there is
   * nothing to repair, only a parent to tell.
   */
  tamper.resetTamperState();
  const adminBefore = tamperAlerts().length;
  fake.machine.childIsAdmin = false;
  await tamper.__testing.check();
  await sleep(200);
  check('a standard-account child raises no administrator alert',
    tamperAlerts().length === adminBefore,
    JSON.stringify(tamperAlerts().map((a) => a.message)));

  fake.machine.childIsAdmin = null; // a domain account, say — cannot be told
  await tamper.__testing.check();
  await sleep(200);
  check('an account whose group cannot be read is not reported either',
    tamperAlerts().length === adminBefore);

  fake.machine.childIsAdmin = true;
  await tamper.__testing.check();
  const adminAlert = await waitFor(
    () => tamperAlerts().find((a) => /administrator/i.test(a.message)),
    'the administrator-account alert',
  );
  check('an administrator-account child is reported to the parent',
    /standard .*account|administrator/i.test(adminAlert.message), adminAlert.message);
  const adminMeta = typeof adminAlert.metadata === 'string'
    ? JSON.parse(adminAlert.metadata) : (adminAlert.metadata || {});
  check('and it carries its own kind, not "unknown"',
    adminMeta.kind === 'admin_user', JSON.stringify(adminAlert.metadata));

  // Once a day, not every two minutes: a standing condition must not become noise.
  await tamper.__testing.check();
  await sleep(200);
  check('the administrator alert is not repeated on the next check',
    tamperAlerts().filter((a) => /administrator/i.test(a.message)).length === 1,
    String(tamperAlerts().filter((a) => /administrator/i.test(a.message)).length));

  // Leave the machine as it was found, so the sections after this one are not
  // running against a laptop this one broke.
  tamper.resetTamperState();
  filterState.__testing.setSystemDnsApplied(false);
  fake.resetMachine();

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
