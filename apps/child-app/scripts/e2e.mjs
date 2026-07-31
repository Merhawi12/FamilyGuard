#!/usr/bin/env node
/**
 * Child App end-to-end test.
 *
 * Boots a real Parentix API and drives the child app's actual service layer
 * against it — api.js, socket.js, rules.js, chat.js and monitoring.js are the
 * shipping modules, with only the Expo / React Native platform packages stubbed
 * (see ./stubs). A parent socket connects alongside, so every assertion about
 * "the parent sees it" is checked on a real second client rather than inferred.
 *
 * What it does not cover: the Kotlin native modules. The stubs stand in for the
 * bridge, so this proves the JS contract and the wire protocol, not the Android
 * implementation. That still needs a device build.
 *
 *   node scripts/e2e.mjs
 */
import { register } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

register('./loader.mjs', import.meta.url);

const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_ROOT = path.resolve(APP_ROOT, '../../services/api');
const PORT = Number(process.env.CHILD_E2E_PORT || 5399);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const step = (title) => console.log(`\n${title}`);

// ── Boot the API ─────────────────────────────────────────────────────────────
const dataDir = mkdtempSync(path.join(tmpdir(), 'parentix-child-e2e-'));
let serverOutput = '';

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: API_ROOT,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(PORT),
    LOG_LEVEL: 'info',
    DATABASE_URL: '',
    DB_PATH: path.join(dataDir, 'child-e2e.sqlite'),
    JWT_SECRET: 'child-e2e-secret-that-is-long-enough',
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
server.stdout.on('data', (c) => { serverOutput += c; });
server.stderr.on('data', (c) => { serverOutput += c; });

const waitFor = (predicate, label, timeout = 20000) =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const tick = () => {
      const value = predicate();
      if (value) return resolve(value);
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

const cleanup = () => {
  server.kill('SIGTERM');
  setTimeout(() => server.kill('SIGKILL'), 3000).unref();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* the OS reclaims it */ }
};

const src = (file) => pathToFileURL(path.join(APP_ROOT, 'src', file)).href;

const run = async () => {
  await waitFor(() => serverOutput.includes('Parentix API listening'), 'server startup', 30000);

  // The child app reads its API base from the environment at import time.
  process.env.EXPO_PUBLIC_API_URL = `${BASE}/api`;
  process.env.EXPO_PUBLIC_SOCKET_URL = BASE;

  const stubs = await import('./stubs/platform.mjs');
  const { spy, platformState, emitNativeEvent, secureStoreStub } = stubs;

  // ── Parent-side fixture ────────────────────────────────────────────────────
  step('Parent sets up a child and rules');
  const email = `child_e2e_${Date.now()}@parentix.test`;
  const password = 'child-e2e-pass-1';
  await call('POST', '/auth/register', { body: { name: 'E2E Parent', email, password } });
  const code = await waitFor(
    () => serverOutput.match(new RegExp(`"email":"${email}","code":"(\\d{6})"`))?.[1],
    'the verification code'
  );
  const verify = await call('POST', '/auth/verify-email', { body: { email, code } });
  const parentToken = verify.data.token;
  check('the parent account is ready', !!parentToken);

  const child = await call('POST', '/children', { token: parentToken, body: { name: 'Ada', age: 11 } });
  const childId = child.data.id;
  check('a child profile exists', child.status === 201, JSON.stringify(child.data));

  await call('PUT', `/screen-time/${childId}`, {
    token: parentToken,
    body: { dailyLimitMinutes: 60, bedtimeStart: '21:00', bedtimeEnd: '07:00' },
  });
  await call('POST', `/blocking/${childId}/apps`, {
    token: parentToken,
    body: { appName: 'Example Game', appPackage: 'com.example.game', action: 'block' },
  });
  await call('POST', `/blocking/${childId}/websites`, {
    token: parentToken,
    body: { url: 'bad.example.com', category: 'custom', action: 'block' },
  });

  // ── Device linking ─────────────────────────────────────────────────────────
  step('Child device links itself');
  const link = await call('POST', '/devices/link', {
    token: parentToken,
    body: { childId, deviceName: "Ada's Phone", type: 'android' },
  });
  const linkCode = link.data.code;

  const { device: deviceApi } = await import(src('services/api.js'));
  const confirm = await deviceApi.confirmLink(linkCode);
  check('the app exchanges the code for a device token', !!confirm.data.deviceToken);

  await secureStoreStub.setItemAsync('fg_device_token', confirm.data.deviceToken);
  await secureStoreStub.setItemAsync('fg_device_id', confirm.data.device.id);
  await secureStoreStub.setItemAsync('fg_child_id', confirm.data.device.childId);
  check('the token is stored the way LinkScreen stores it',
    (await secureStoreStub.getItemAsync('fg_device_token')) === confirm.data.deviceToken);

  // ── Parent realtime listener ───────────────────────────────────────────────
  const parentEvents = { alerts: [], messages: [], locations: [] };
  const parentSocket = io(BASE, { auth: { token: parentToken }, transports: ['websocket'], reconnection: false });
  parentSocket.on('alert:new', (a) => parentEvents.alerts.push(a));
  parentSocket.on('chat:message', (m) => parentEvents.messages.push(m));
  parentSocket.on('location:update', (l) => parentEvents.locations.push(l));
  await new Promise((resolve, reject) => {
    parentSocket.on('connect', resolve);
    parentSocket.on('connect_error', reject);
    setTimeout(() => reject(new Error('parent socket timeout')), 8000);
  });
  check('the parent socket is connected', parentSocket.connected);

  // ── Monitoring start: rules reach the device ───────────────────────────────
  step('Monitoring applies the parent\'s rules');
  platformState.usageStats = {};
  const monitoring = await import(src('services/monitoring.js'));
  await monitoring.startMonitoring();

  const status = monitoring.getMonitoringStatus();
  check('the device fetched its rules', status.rules.appRules.length === 1 && status.rules.websiteRules.length === 1,
    JSON.stringify({ apps: status.rules.appRules.length, sites: status.rules.websiteRules.length }));
  check('the blocked package reached the native blocker',
    Array.isArray(spy.blockedApps) && spy.blockedApps.includes('com.example.game'), JSON.stringify(spy.blockedApps));
  // Regression: the app used to read `domain`, but the column is `url`, so the
  // VPN was always started with an empty list and blocked nothing.
  check('the blocked website reached the VPN',
    spy.vpnStarted && spy.vpnDomains?.includes('bad.example.com'), JSON.stringify(spy.vpnDomains));
  check('website blocking reports as on', status.status.websiteBlocking === true);
  check('a background sync task was registered', spy.backgroundTasks.length === 1);
  check('location tracking started', status.status.locationTracking === true);

  // ── Usage reporting ────────────────────────────────────────────────────────
  step('Usage is reported to the parent');
  platformState.usageStats = {
    'com.example.game': { appName: 'Example Game', minutes: 25 },
    'com.parentix': { appName: 'Parentix', minutes: 99 }, // must be excluded
  };
  await stubs.taskManagerStub.__run('fg-monitoring-task');

  const activity = await call('GET', `/activity/${childId}`, { token: parentToken });
  const games = activity.data.rows.filter((r) => r.appPackage === 'com.example.game');
  check('the parent sees the reported app usage', games.length === 1, JSON.stringify(activity.data.count));
  check('the monitoring app excludes itself from the totals',
    !activity.data.rows.some((r) => r.appPackage === 'com.parentix'));
  check('the device reports its own screen-time total', monitoring.getMonitoringStatus().todayMinutes === 25,
    String(monitoring.getMonitoringStatus().todayMinutes));

  // ── Screen-time limit: apply and release ───────────────────────────────────
  step('The screen-time limit applies, and releases the next day');
  platformState.usageStats = { 'com.example.game': { appName: 'Example Game', minutes: 75 } };
  await stubs.taskManagerStub.__run('fg-monitoring-task');

  check('everything is blocked once the limit is hit',
    Array.isArray(spy.blockedApps) && spy.blockedApps.includes('*'), JSON.stringify(spy.blockedApps));
  const limitAlert = await waitFor(
    () => parentEvents.alerts.find((a) => a.type === 'screen_time_exceeded'),
    'the screen-time alert'
  );
  check('the parent is alerted that the limit was reached', !!limitAlert);

  // A second run on the same day must not re-alert.
  const alertsBefore = parentEvents.alerts.filter((a) => a.type === 'screen_time_exceeded').length;
  await stubs.taskManagerStub.__run('fg-monitoring-task');
  await new Promise((r) => setTimeout(r, 400));
  check('the limit alert is sent once per day',
    parentEvents.alerts.filter((a) => a.type === 'screen_time_exceeded').length === alertsBefore);

  // Regression: usage resets at midnight. The wildcard block used to persist
  // natively, leaving the device blocked the next day until a rules update.
  platformState.usageStats = { 'com.example.game': { appName: 'Example Game', minutes: 3 } };
  await stubs.taskManagerStub.__run('fg-monitoring-task');
  check('the block is released when usage resets',
    Array.isArray(spy.blockedApps) && !spy.blockedApps.includes('*'), JSON.stringify(spy.blockedApps));
  check('the parent\'s own app rules survive the release',
    spy.blockedApps.includes('com.example.game'), JSON.stringify(spy.blockedApps));

  // ── Blocked-app attempt ────────────────────────────────────────────────────
  step('A blocked-app attempt reaches the parent');
  emitNativeEvent('onAppBlocked', 'com.example.game');
  const blockedAlert = await waitFor(
    () => parentEvents.alerts.find((a) => a.type === 'blocked_app_attempt'),
    'the blocked-app alert'
  );
  check('the parent is alerted', !!blockedAlert);
  check('the alert names the app', /Example Game/.test(blockedAlert.message), blockedAlert.message);

  // ── Live rule changes ──────────────────────────────────────────────────────
  step('A rule change pushes to the device');
  await call('POST', `/blocking/${childId}/apps`, {
    token: parentToken,
    body: { appName: 'Chat App', appPackage: 'com.example.chat', action: 'block' },
  });
  await waitFor(
    () => Array.isArray(spy.blockedApps) && spy.blockedApps.includes('com.example.chat'),
    'the new rule to reach the device'
  );
  check('the device picked up the new block over the socket', spy.blockedApps.includes('com.example.chat'));

  // ── Family chat, both directions ───────────────────────────────────────────
  step('Family chat works in both directions');
  const chat = await import(src('services/chat.js'));

  const received = [];
  await chat.onMessage((m) => received.push(m));

  const parentSend = await call('POST', `/chats/${childId}/messages`, {
    token: parentToken, body: { text: 'Dinner at six' },
  });
  check('the parent can send to the child', parentSend.status === 201);

  const delivered = await waitFor(() => received.find((m) => m.text === 'Dinner at six'), 'the parent message');
  check('the child receives it in realtime', !!delivered);

  const thread = await chat.fetchMessages();
  check('the child can read the thread', thread.some((m) => m.text === 'Dinner at six'), `${thread.length} messages`);

  await chat.sendMessage('On my way home');
  const reply = await waitFor(() => parentEvents.messages.find((m) => m.text === 'On my way home'), 'the child reply');
  check('the child can reply', !!reply);
  check('the reply is attributed to the child', reply.senderRole === 'child', reply.senderRole);

  const parentThread = await call('GET', `/chats/${childId}/messages`, { token: parentToken });
  check('both messages are in the parent\'s thread',
    parentThread.data.rows.filter((m) => ['Dinner at six', 'On my way home'].includes(m.text)).length === 2);

  // ── Emergency ──────────────────────────────────────────────────────────────
  step('The emergency button raises a high-severity alert');
  await chat.sendEmergency();
  const sos = await waitFor(
    () => parentEvents.alerts.find((a) => a.type === 'emergency_button'),
    'the emergency alert'
  );
  check('the parent gets an emergency alert', !!sos);
  check('it is high severity', sos.severity === 'high', sos.severity);

  const alertList = await call('GET', '/alerts', { token: parentToken });
  check('the alert is persisted for the parent dashboard',
    alertList.data.some((a) => a.type === 'emergency_button'));

  // ── Admin visibility ───────────────────────────────────────────────────────
  step('The staff console sees the activity');
  const { spawnSync } = await import('node:child_process');
  const adminEmail = `child_e2e_admin_${Date.now()}@parentix.test`;
  const adminPass = 'child-e2e-admin-1';
  spawnSync(process.execPath, ['scripts/create-admin.js', '--email', adminEmail, '--name', 'E2E Admin', '--role', 'super_admin'], {
    cwd: API_ROOT,
    env: { ...process.env, ADMIN_PASSWORD: adminPass, DATABASE_URL: '', DB_PATH: path.join(dataDir, 'child-e2e.sqlite'), NODE_ENV: 'development' },
    encoding: 'utf8',
  });
  const adminLogin = await call('POST', '/auth/login', { body: { email: adminEmail, password: adminPass } });
  const adminToken = adminLogin.data?.token;
  check('a staff account can sign in', !!adminToken);

  const analytics = await call('GET', '/admin/analytics', { token: adminToken });
  check('staff analytics count the parent account', (analytics.data?.totalUsers ?? 0) >= 1, JSON.stringify(analytics.data?.totalUsers));

  const audit = await call('GET', '/audit', { token: adminToken });
  check('the audit trail is readable by staff', audit.status === 200 && (audit.data?.rows?.length ?? 0) > 0);

  // ── Teardown ───────────────────────────────────────────────────────────────
  step('Monitoring stops cleanly');
  monitoring.stopMonitoring();
  check('the device stops blocking on shutdown',
    Array.isArray(spy.blockedApps) && spy.blockedApps.length === 0, JSON.stringify(spy.blockedApps));
  check('the VPN is torn down', spy.vpnStarted === false);

  parentSocket.disconnect();
};

run()
  .then(() => {
    console.log(`\n${'─'.repeat(60)}`);
    if (failures.length) {
      console.log(`FAILED — ${passed} passed, ${failures.length} failed\n`);
      failures.forEach((f) => console.log(`  • ${f}`));
      cleanup();
      process.exitCode = 1;
    } else {
      console.log(`PASSED — ${passed} checks`);
      cleanup();
    }
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  })
  .catch((err) => {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`ERROR — ${err.message}`);
    console.log(serverOutput.split('\n').slice(-25).join('\n'));
    cleanup();
    setTimeout(() => process.exit(1), 500);
  });
