#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Boots a real API process (HTTP + Socket.IO + SQLite) and walks the workflows
 * that actually matter in production: signup and verification, login, adding a
 * child, linking a device, the device reporting activity and location, realtime
 * alert delivery from device to parent, family chat, reports, the staff
 * console, and sign-out.
 *
 * Unlike the Jest suite — which drives the Express app in-process — this exercises
 * the network path, so it catches wiring the unit tests cannot see.
 *
 *   node scripts/e2e.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 5199);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];
let serverOutput = '';

const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const step = (title) => console.log(`\n${title}`);

const call = async (method, urlPath, { token, body } = {}) => {
  const res = await fetch(`${BASE}/api${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
};

const waitFor = (predicate, { timeout = 8000, interval = 50, label = 'condition' } = {}) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const tick = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, interval);
    };
    tick();
  });

const connectSocket = (token) =>
  new Promise((resolve, reject) => {
    const socket = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
    setTimeout(() => reject(new Error('socket connect timed out')), 8000);
  });

// ── Boot ─────────────────────────────────────────────────────────────────────
const dataDir = mkdtempSync(path.join(tmpdir(), 'parentix-e2e-'));

/**
 * SQLite by default, so this runs anywhere with no setup. Set E2E_DATABASE_URL
 * to a throwaway Postgres to walk the same workflows over the engine Cloud SQL
 * actually runs — the two disagree on enough (json comparison, type coercion,
 * identifier folding) that passing on one is not evidence about the other.
 *
 *   E2E_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/parentix_e2e \
 *     npm run test:e2e
 */
const DATABASE_URL = process.env.E2E_DATABASE_URL || '';
const dbEnv = {
  DATABASE_URL,
  DB_PATH: path.join(dataDir, 'e2e.sqlite'),
  ...(DATABASE_URL ? { DB_SSL: 'false' } : {}),
};

if (DATABASE_URL) {
  console.log(`Running against Postgres at ${DATABASE_URL.replace(/\/\/[^@]*@/, '//***@')}\n`);
}

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: API_ROOT,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(PORT),
    LOG_LEVEL: 'info',
    ...dbEnv,
    JWT_SECRET: 'e2e-secret-that-is-long-enough-for-tests',
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

server.stdout.on('data', (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  serverOutput += chunk.toString();
});

const shutdown = () => {
  server.kill('SIGTERM');
  setTimeout(() => server.kill('SIGKILL'), 3000).unref();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* the OS will reclaim the temp dir */
  }
};

const run = async () => {
  await waitFor(() => serverOutput.includes('Parentix API listening'), { label: 'server startup', timeout: 30000 });

  // ── 1. Health ──────────────────────────────────────────────────────────────
  step('Health');
  const health = await call('GET', '/health');
  check('GET /health is 200', health.status === 200, `got ${health.status}`);
  const ready = await call('GET', '/ready');
  check('GET /ready reports the database is reachable', ready.data?.status === 'ready');

  // ── 2. Registration and verification ───────────────────────────────────────
  step('Signup and email verification');
  const email = `e2e_${Date.now()}@parentix.test`;
  const password = 'e2e-strong-pass1';

  const weak = await call('POST', '/auth/register', { body: { name: 'E2E', email: `weak_${email}`, password: 'weak' } });
  check('registration rejects a password that fails the policy', weak.status === 400, `got ${weak.status}`);

  const register = await call('POST', '/auth/register', { body: { name: 'E2E Parent', email, password } });
  check('registration accepts a valid password', register.status === 201, JSON.stringify(register.data));

  const code = await waitFor(
    () => serverOutput.match(new RegExp(`"email":"${email}","code":"(\\d{6})"`))?.[1],
    { label: 'the verification code in the server log' }
  );
  check('a verification code was issued', /^\d{6}$/.test(code));

  const verify = await call('POST', '/auth/verify-email', { body: { email, code } });
  check('verification returns a token and the user', verify.status === 200 && !!verify.data?.token && !!verify.data?.user);
  check('the user payload carries no secrets', !verify.data?.user?.passwordHash && !verify.data?.user?.mfaSecret);

  // ── 3. Login ───────────────────────────────────────────────────────────────
  step('Login');
  const badLogin = await call('POST', '/auth/login', { body: { email, password: 'wrong-password1' } });
  check('a wrong password is rejected', badLogin.status === 401, `got ${badLogin.status}`);

  const login = await call('POST', '/auth/login', { body: { email, password } });
  check('login returns a session token', login.status === 200 && !!login.data?.token);
  const parentToken = login.data.token;

  const me = await call('GET', '/auth/me', { token: parentToken });
  check('GET /auth/me resolves the session', me.status === 200 && me.data.email === email);

  const noToken = await call('GET', '/children');
  check('an unauthenticated request is refused', noToken.status === 401);

  // ── 4. Child, rules ────────────────────────────────────────────────────────
  step('Child profile and rules');
  const child = await call('POST', '/children', { token: parentToken, body: { name: 'Ada', age: 11 } });
  check('a child profile is created', child.status === 201, JSON.stringify(child.data));
  const childId = child.data.id;

  const screenTime = await call('PUT', `/screen-time/${childId}`, {
    token: parentToken,
    body: { dailyLimitMinutes: 90, bedtimeStart: '21:00', bedtimeEnd: '07:00' },
  });
  check('a screen-time rule is saved', screenTime.status === 200, JSON.stringify(screenTime.data));

  const appRule = await call('POST', `/blocking/${childId}/apps`, {
    token: parentToken,
    body: { appName: 'Example Game', appPackage: 'com.example.game', isBlocked: true },
  });
  check('an app-blocking rule is added', [200, 201].includes(appRule.status), JSON.stringify(appRule.data));

  // ── 5. Device linking ──────────────────────────────────────────────────────
  step('Device linking');
  const link = await call('POST', '/devices/link', {
    token: parentToken,
    body: { childId, deviceName: "Ada's Phone", type: 'android' },
  });
  check('a linking code is generated', link.status === 200 && !!link.data?.code, JSON.stringify(link.data));

  const confirm = await call('POST', '/devices/confirm', { body: { code: link.data.code } });
  check('the device exchanges the code for a device token', confirm.status === 200 && !!confirm.data?.deviceToken);
  const deviceToken = confirm.data.deviceToken;

  const reused = await call('POST', '/devices/confirm', { body: { code: link.data.code } });
  check('a linking code cannot be reused', reused.status >= 400, `got ${reused.status}`);

  const rules = await call('GET', '/devices/me/rules', { token: deviceToken });
  check('the device receives its rules', rules.status === 200 && Array.isArray(rules.data?.appRules));
  check('the blocked app is in the device rules', rules.data.appRules.some((r) => r.appPackage === 'com.example.game'));
  check('the screen-time limit reached the device', rules.data.screenTimeRule?.dailyLimitMinutes === 90);

  // ── 6. Device reporting ────────────────────────────────────────────────────
  step('Device reporting');
  const heartbeat = await call('POST', '/devices/me/heartbeat', { token: deviceToken });
  check('the device heartbeat is accepted', heartbeat.status === 200, `got ${heartbeat.status}`);

  const activity = await call('POST', '/devices/me/activity', {
    token: deviceToken,
    body: { appName: 'Example Game', appPackage: 'com.example.game', category: 'app_usage', durationMinutes: 30 },
  });
  check('the device logs activity', [200, 201].includes(activity.status), JSON.stringify(activity.data));

  const location = await call('POST', '/locations', {
    token: deviceToken,
    body: { latitude: 45.4215, longitude: -75.6972, accuracy: 12 },
  });
  check('the device posts a location', location.status === 201, `${location.status} ${JSON.stringify(location.data)}`);

  const locationUnauthed = await call('POST', '/locations', { body: { latitude: 1, longitude: 1 } });
  check('an unauthenticated location post is refused', locationUnauthed.status === 401);

  // ── 7. Parent reads the data back ──────────────────────────────────────────
  step('Parent visibility');
  const feed = await call('GET', `/activity/${childId}`, { token: parentToken });
  check('the activity feed shows the reported usage', feed.status === 200 && feed.data.count > 0, JSON.stringify(feed.data?.count));

  // GPS is a gated feature; a freshly registered account is inside its trial,
  // which is entitled to it.
  const current = await call('GET', `/locations/${childId}/current`, { token: parentToken });
  check(
    'the current location is available during the trial',
    current.status === 200 && current.data?.latitude === 45.4215,
    `${current.status} ${JSON.stringify(current.data)}`
  );

  await expireTrial(email);
  const gated = await call('GET', `/locations/${childId}/current`, { token: parentToken });
  check('the same feature is gated once the trial expires', gated.status === 403, `got ${gated.status}`);
  await restoreTrial(email);

  const report = await call('GET', `/reports/${childId}/daily`, { token: parentToken });
  check('a daily report is produced', report.status === 200, JSON.stringify(report.data));

  // ── 8. Tenant isolation ────────────────────────────────────────────────────
  step('Tenant isolation');
  const otherEmail = `e2e_other_${Date.now()}@parentix.test`;
  await call('POST', '/auth/register', { body: { name: 'Other', email: otherEmail, password } });
  const otherCode = await waitFor(
    () => serverOutput.match(new RegExp(`"email":"${otherEmail}","code":"(\\d{6})"`))?.[1],
    { label: 'the second verification code' }
  );
  const otherVerify = await call('POST', '/auth/verify-email', { body: { email: otherEmail, code: otherCode } });
  const otherToken = otherVerify.data.token;

  const stolen = await call('GET', `/activity/${childId}`, { token: otherToken });
  check("another parent cannot read this child's activity", stolen.status === 404, `got ${stolen.status}`);

  const stolenUpdate = await call('PUT', `/children/${childId}`, { token: otherToken, body: { name: 'Hijacked' } });
  check("another parent cannot modify this child", stolenUpdate.status === 404, `got ${stolenUpdate.status}`);

  // ── 9. Realtime ────────────────────────────────────────────────────────────
  step('Realtime');
  let anonymousRefused = false;
  try {
    await connectSocket(undefined);
  } catch {
    anonymousRefused = true;
  }
  check('a socket without a token is refused', anonymousRefused);

  const parentSocket = await connectSocket(parentToken);
  check('the parent socket connects', parentSocket.connected);

  const deviceSocket = await connectSocket(deviceToken);
  check('the device socket connects', deviceSocket.connected);

  const alerts = [];
  parentSocket.on('alert:new', (alert) => alerts.push(alert));
  const chatMessages = [];
  parentSocket.on('chat:message', (message) => chatMessages.push(message));

  deviceSocket.emit('alert:blocked_app', { appName: 'Example Game' });
  await waitFor(() => alerts.length > 0, { label: 'a blocked-app alert to reach the parent' });
  check('a device alert is delivered to the parent in realtime', alerts[0]?.type === 'blocked_app_attempt', JSON.stringify(alerts[0]));

  // A parent must not be able to forge an alert as if it came from a device.
  const beforeForge = alerts.length;
  parentSocket.emit('alert:screen_time_exceeded');
  await new Promise((resolve) => setTimeout(resolve, 400));
  check('a parent cannot forge a device alert', alerts.length === beforeForge);

  const storedAlerts = await call('GET', '/alerts', { token: parentToken });
  check('the alert was persisted', storedAlerts.status === 200 && storedAlerts.data.length > 0);

  // ── 10. Chat ───────────────────────────────────────────────────────────────
  step('Family chat');
  const fromChild = await call('POST', `/chats/${childId}/messages/from-child`, {
    token: deviceToken,
    body: { text: 'Home safe', messageType: 'normal' },
  });
  check('the child can send a message', [200, 201].includes(fromChild.status), JSON.stringify(fromChild.data));

  const reply = await call('POST', `/chats/${childId}/messages`, {
    token: parentToken,
    body: { text: 'Great, see you soon' },
  });
  check('the parent can reply', [200, 201].includes(reply.status), JSON.stringify(reply.data));

  // The endpoint paginates, so it answers { count, rows }.
  const thread = await call('GET', `/chats/${childId}/messages`, { token: parentToken });
  check('both messages are in the thread', thread.status === 200 && thread.data?.count >= 2, JSON.stringify(thread.data?.count));

  deviceSocket.emit('chat:send', { text: 'On my way', messageType: 'normal' });
  await waitFor(() => chatMessages.some((m) => m.text === 'On my way'), { label: 'a realtime chat message' });
  check('a chat message arrives over the socket', chatMessages.some((m) => m.text === 'On my way'));

  parentSocket.disconnect();
  deviceSocket.disconnect();

  // ── 11. Staff console ──────────────────────────────────────────────────────
  step('Staff console');
  const parentOnAdmin = await call('GET', '/admin/analytics', { token: parentToken });
  check('a parent is refused by the admin API', parentOnAdmin.status === 403, `got ${parentOnAdmin.status}`);

  // Promote through the same models the API uses, then sign in again — a role
  // change must be reflected on the next request, not require a new token.
  await promoteToAdmin(email);

  const analytics = await call('GET', '/admin/analytics', { token: parentToken });
  check('an admin can read platform analytics', analytics.status === 200, JSON.stringify(analytics.data));
  check('analytics reports the registered users', (analytics.data?.totalUsers ?? 0) >= 2);

  const users = await call('GET', '/admin/users', { token: parentToken });
  check('an admin can list users', users.status === 200 && Array.isArray(users.data?.rows));

  const audit = await call('GET', '/audit', { token: parentToken });
  check('the audit log is readable and non-empty', audit.status === 200 && (audit.data?.rows?.length ?? audit.data?.length ?? 0) > 0);

  // Paginated: { rows, count }.
  const sessions = await call('GET', '/admin/sessions/active?limit=10', { token: parentToken });
  check('active sessions are listed', sessions.status === 200 && Array.isArray(sessions.data?.rows));
  check('the session list reports a total for paging', (sessions.data?.count ?? 0) > 0, JSON.stringify(sessions.data?.count));

  // ── 12. Contact form ───────────────────────────────────────────────────────
  //
  // This harness runs with EMAIL_PROVIDER=none, so a submission genuinely cannot
  // be delivered — and the behaviour worth pinning is that the API says so.
  //
  // It used to assert a 2xx here, which is the one answer that would be a bug:
  // the endpoint was changed precisely because reporting success with no relay
  // configured meant a prospective customer read "message sent", closed the tab,
  // and waited for a reply to something that existed only in a log line. The
  // test asserting the old behaviour survived the fix and failed ever since.
  step('Marketing contact form');
  const contact = await call('POST', '/contact', {
    body: { name: 'Visitor', email: 'visitor@example.test', message: 'How does Parentix work?' },
  });
  check(
    'an undeliverable submission is reported as undeliverable, not as sent',
    contact.status === 502 && contact.data?.delivered === false,
    JSON.stringify(contact.data),
  );
  check(
    'the failure tells the visitor what to do instead',
    typeof contact.data?.error === 'string' && /email us directly/i.test(contact.data.error),
    JSON.stringify(contact.data?.error),
  );

  // Validation runs before delivery is attempted, so these answer the same way
  // with or without a relay.
  const contactBad = await call('POST', '/contact', {
    body: { name: 'Visitor', email: 'not-an-address', message: 'hello' },
  });
  check('a malformed address is rejected', contactBad.status === 400, JSON.stringify(contactBad.data));

  const contactEmpty = await call('POST', '/contact', { body: { name: 'Visitor' } });
  check('a missing message is rejected', contactEmpty.status === 400, JSON.stringify(contactEmpty.data));

  // ── 13. Sign-out ───────────────────────────────────────────────────────────
  step('Sign-out');
  const logout = await call('POST', '/auth/logout', { token: parentToken });
  check('sign-out succeeds', logout.status === 200);

  const afterLogout = await call('GET', '/auth/me', { token: parentToken });
  check('the token stops working after sign-out', afterLogout.status === 401, `got ${afterLogout.status}`);

  // ── 14. Unknown routes ─────────────────────────────────────────────────────
  step('Unknown routes');
  const missing = await call('GET', '/does-not-exist');
  check('an unknown API path is a clean 404', missing.status === 404);
};

/**
 * Applies an update straight to the database, the way an operator would — used
 * for the states a client cannot reach on its own (seeding staff, ageing out a
 * trial).
 */
const updateUser = (email, updates) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const { sequelize } = require('./src/config/db');
         const { User } = require('./src/models');
         User.update(${JSON.stringify(updates)}, { where: { email: ${JSON.stringify(email)} } })
           .then(() => sequelize.close())
           .then(() => process.exit(0))
           .catch((err) => { console.error(err.message); process.exit(1); });`,
      ],
      {
        cwd: API_ROOT,
        env: { ...process.env, ...dbEnv, NODE_ENV: 'development' },
        stdio: 'inherit',
      }
    );
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`failed to update ${email}`))));
  });

const promoteToAdmin = (email) =>
  updateUser(email, {
    role: 'super_admin',
    permissions: [
      'manage_users', 'manage_sessions', 'manage_billing',
      'manage_settings', 'send_notifications', 'view_audit_logs',
    ],
  });
const expireTrial = (email) => updateUser(email, { trialEndsAt: new Date(Date.now() - 86400000).toISOString() });
const restoreTrial = (email) => updateUser(email, { trialEndsAt: new Date(Date.now() + 86400000).toISOString() });

run()
  .then(() => {
    console.log(`\n${'─'.repeat(60)}`);
    if (failures.length) {
      console.log(`FAILED — ${passed} passed, ${failures.length} failed\n`);
      failures.forEach((f) => console.log(`  • ${f}`));
      shutdown();
      process.exitCode = 1;
    } else {
      console.log(`PASSED — ${passed} checks\n`);
      shutdown();
      process.exitCode = 0;
    }
  })
  .catch((err) => {
    console.error('\nE2E run aborted:', err.message);
    console.error('\n--- server output ---\n' + serverOutput.slice(-4000));
    shutdown();
    process.exitCode = 1;
  });
