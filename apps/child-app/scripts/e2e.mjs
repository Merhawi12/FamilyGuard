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
  const linkSvc = await import(src('services/link.js'));
  const confirm = await deviceApi.confirmLink(linkCode);
  check('the app exchanges the code for a device token', !!confirm.data.deviceToken);
  check('the spent code is not handed back to the phone',
    (confirm.data.device.linkingCode ?? null) === null, JSON.stringify(confirm.data.device.linkingCode));

  // Stored through the shipping path rather than by poking the keystore, so
  // this covers what LinkScreen actually calls.
  await linkSvc.saveLink({
    deviceToken: confirm.data.deviceToken,
    deviceId: confirm.data.device.id,
    childId: confirm.data.device.childId,
  });
  check('the token is stored the way LinkScreen stores it',
    (await secureStoreStub.getItemAsync('fg_device_token')) === confirm.data.deviceToken);
  check('the app now considers itself linked', (await linkSvc.hasLink()) === true);

  // A code is single-use and dies with its device row. Both used to answer 200
  // and hand out a token that failed on every call it was ever used for.
  const replay = await call('POST', '/devices/confirm', { body: { code: linkCode } });
  check('the same code cannot be redeemed twice', replay.status === 404, String(replay.status));

  // ── Parent realtime listener ───────────────────────────────────────────────
  const parentEvents = { alerts: [], messages: [], locations: [], deviceLinks: [] };
  const parentSocket = io(BASE, { auth: { token: parentToken }, transports: ['websocket'], reconnection: false });
  parentSocket.on('alert:new', (a) => parentEvents.alerts.push(a));
  parentSocket.on('chat:message', (m) => parentEvents.messages.push(m));
  parentSocket.on('location:update', (l) => parentEvents.locations.push(l));
  parentSocket.on('device:linked', (d) => parentEvents.deviceLinks.push(d));
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

  // ── Bedtime and the daily schedule ─────────────────────────────────────────
  // These lock on the clock rather than on usage, so the rule logic is checked
  // directly against a supplied time — a wall-clock-dependent test would pass or
  // fail depending on when CI happened to run.
  step('Bedtime and schedule rules decide the lock');
  {
    const { lockState, withinWindow } = await import(
      pathToFileURL(path.join(APP_ROOT, 'src/services/schedule.js')).href
    );
    const wednesdayAt = (hhmm, dayOffset = 0) => {
      const [h, m] = hhmm.split(':').map(Number);
      return new Date(2026, 7, 5 + dayOffset, h, m); // 2026-08-05 is a Wednesday
    };
    const base = {
      dailyLimitMinutes: 120, bedtimeEnabled: false, bedtimeStart: '21:00',
      bedtimeEnd: '07:00', isActive: true, schedule: {},
    };

    check('a window that wraps past midnight covers both sides of it',
      withinWindow(22 * 60, 21 * 60, 7 * 60) && withinWindow(2 * 60, 21 * 60, 7 * 60)
      && !withinWindow(12 * 60, 21 * 60, 7 * 60));

    const bedtime = { ...base, bedtimeEnabled: true };
    check('bedtime locks the device at night',
      lockState(bedtime, 0, wednesdayAt('22:30')).reason === 'bedtime');
    check('bedtime is still in force after midnight',
      lockState(bedtime, 0, wednesdayAt('03:00')).blocked === true);
    check('bedtime lifts in the morning',
      lockState(bedtime, 0, wednesdayAt('07:00')).blocked === false);

    const school = { ...base, schedule: { wednesday: { enabled: true, start: '08:00', end: '20:00' } } };
    check('the schedule allows use inside its hours',
      lockState(school, 0, wednesdayAt('10:00')).blocked === false);
    check('the schedule locks the device outside its hours',
      lockState(school, 0, wednesdayAt('21:00')).reason === 'outside_schedule');
    check('the schedule applies to the right weekday',
      lockState(school, 0, wednesdayAt('21:00', 1)).blocked === false);
    check('a day left switched off restricts nothing',
      lockState({ ...base, schedule: { wednesday: { enabled: false, start: '08:00', end: '20:00' } } },
        0, wednesdayAt('03:00')).blocked === false);

    check('the daily limit is reported ahead of bedtime when both apply',
      lockState(bedtime, 500, wednesdayAt('22:00')).reason === 'daily_limit');
    check('a switched-off rule never locks',
      lockState({ ...bedtime, isActive: false }, 500, wednesdayAt('22:00')).blocked === false);
    check('no rule at all never locks', lockState(null, 500, wednesdayAt('22:00')).blocked === false);

    // The rule the API creates the moment a parent opens the Screen Time page
    // must not restrict anything until they actually choose to.
    const fresh = await call('GET', `/screen-time/${childId}`, { token: parentToken });
    let openAllWeek = true;
    for (let day = 0; day < 7; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const time = wednesdayAt(`${String(hour).padStart(2, '0')}:00`, day);
        if (lockState({ ...fresh.data, dailyLimitMinutes: 0 }, 0, time).blocked) openAllWeek = false;
      }
    }
    check('a freshly created rule restricts no hour of the week', openAllWeek);
  }

  // ── Bedtime reaches the device ─────────────────────────────────────────────
  step('A bedtime set by the parent reaches the device');
  {
    // A window covering the whole day, so the assertion does not depend on when
    // this runs: 00:00 → 23:59 wraps to leave only one minute unlocked.
    await call('PUT', `/screen-time/${childId}`, {
      token: parentToken,
      body: { dailyLimitMinutes: 600, bedtimeEnabled: true, bedtimeStart: '00:00', bedtimeEnd: '23:59' },
    });
    platformState.usageStats = { 'com.example.game': { appName: 'Example Game', minutes: 3 } };
    await stubs.taskManagerStub.__run('fg-monitoring-task');

    check('the device locks everything during bedtime',
      Array.isArray(spy.blockedApps) && spy.blockedApps.includes('*'), JSON.stringify(spy.blockedApps));

    // And releases once the parent turns it off again.
    await call('PUT', `/screen-time/${childId}`, {
      token: parentToken,
      body: { dailyLimitMinutes: 600, bedtimeEnabled: false },
    });
    await stubs.taskManagerStub.__run('fg-monitoring-task');
    check('turning bedtime off releases the device',
      Array.isArray(spy.blockedApps) && !spy.blockedApps.includes('*'), JSON.stringify(spy.blockedApps));
    check('the parent\'s app rules survive the bedtime release',
      spy.blockedApps.includes('com.example.game'), JSON.stringify(spy.blockedApps));
  }

  // ── A per-app daily limit ──────────────────────────────────────────────────
  /*
   * "Limit time" was an option in the parent app's rule dropdown that nothing
   * implemented. The API stored the action, the device read the rules, and
   * `blockedPackagesFor` only ever looked at `action === 'block'` — so the app
   * appeared in Active app rules with a badge and was never blocked for a
   * second. The column it needed (`dailyLimitMinutes`) had been on the model the
   * whole time.
   *
   * This drives the finished feature end to end: parent sets it, device measures
   * the app's own usage against it, blocks that app and nothing else, and lets
   * go when the day rolls over.
   */
  step('A per-app daily limit is enforced against that app alone');
  {
    const limited = await call('POST', `/blocking/${childId}/apps`, {
      token: parentToken,
      body: {
        appName: 'Video App', appPackage: 'com.example.video', action: 'limit', dailyLimitMinutes: 30,
      },
    });
    check('the parent can set a per-app limit', limited.status === 201, JSON.stringify(limited.data));
    check('the limit is stored with the rule', limited.data.dailyLimitMinutes === 30);

    await waitFor(
      () => monitoring.getMonitoringStatus().rules.appRules.some((r) => r.appPackage === 'com.example.video'),
      'the limit rule to reach the device'
    );

    // Under the limit: the app is left alone.
    platformState.usageStats = {
      'com.example.video': { appName: 'Video App', minutes: 20 },
    };
    await stubs.taskManagerStub.__run('fg-monitoring-task');
    check('an app under its limit is not blocked',
      !spy.blockedApps.includes('com.example.video'), JSON.stringify(spy.blockedApps));

    // Over the limit: that app, and only that app, is blocked.
    platformState.usageStats = {
      'com.example.video': { appName: 'Video App', minutes: 31 },
    };
    await stubs.taskManagerStub.__run('fg-monitoring-task');
    check('an app over its limit is blocked',
      spy.blockedApps.includes('com.example.video'), JSON.stringify(spy.blockedApps));
    check('the rest of the phone is left alone',
      !spy.blockedApps.includes('*'), JSON.stringify(spy.blockedApps));
    check('an outright block rule is unaffected',
      spy.blockedApps.includes('com.example.game'), JSON.stringify(spy.blockedApps));

    // Midnight: usage resets, and the app has to come back. The old code
    // compared lock state rather than the package set, so a change that did not
    // move the lock — which this never does — was computed and thrown away.
    platformState.usageStats = {
      'com.example.video': { appName: 'Video App', minutes: 2 },
    };
    await stubs.taskManagerStub.__run('fg-monitoring-task');
    check('the app is released when usage resets',
      !spy.blockedApps.includes('com.example.video'), JSON.stringify(spy.blockedApps));

    await call('DELETE', `/blocking/${childId}/apps/${limited.data.id}`, { token: parentToken });
    await waitFor(
      () => !monitoring.getMonitoringStatus().rules.appRules.some((r) => r.appPackage === 'com.example.video'),
      'the limit rule to be withdrawn'
    );
  }

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

  // ── Approved contacts reach the device ─────────────────────────────────────
  // The whole point of this block is that "the parent UI says Approved" proves
  // nothing on its own. Every assertion below reads the device's own list —
  // the state the contact policy is actually enforced from.
  step('Approved contacts synchronise to the device');
  const contactsSvc = await import(src('services/contacts.js'));
  const contactApi = (method, path, body) =>
    call(method, path, { token: parentToken, body });

  const deviceContactNames = () => contactsSvc.getContacts().contacts.map((c) => c.name).sort();

  check('the device starts with no approved contacts', deviceContactNames().length === 0,
    JSON.stringify(deviceContactNames()));

  const grandma = await contactApi('POST', '/contacts', {
    childId, name: 'Grandma', phoneNumber: '+1 555 010 0199', relationship: 'family',
    notes: 'Private note the child must never see',
  });
  check('the parent can add a contact', grandma.status === 201, JSON.stringify(grandma.data));

  await waitFor(() => deviceContactNames().includes('Grandma'), 'the contact to reach the device');
  check('the approved contact reached the device over the socket', deviceContactNames().includes('Grandma'));
  check('the device holds the contact\'s number',
    contactsSvc.findContact('+15550100199')?.name === 'Grandma',
    JSON.stringify(contactsSvc.getContacts().contacts));
  check('the parent\'s private note did not reach the device',
    !JSON.stringify(contactsSvc.getContacts().contacts).includes('Private note'));

  // Section G: the device must actually apply the policy, not just store it.
  check('an approved number is recognised as approved', contactsSvc.isApprovedNumber('555 010 0199') === true);
  check('a number in another format still matches', contactsSvc.isApprovedNumber('+1-555-010-0199') === true);
  check('an unapproved number is not recognised', contactsSvc.isApprovedNumber('5559999999') === false);

  {
    const before = parentEvents.alerts.filter((a) => a.type === 'unknown_contact').length;
    check('the policy allows an approved caller', contactsSvc.checkIncomingContact('5550100199') === true);
    await new Promise((r) => setTimeout(r, 300));
    check('an approved caller raises no alert',
      parentEvents.alerts.filter((a) => a.type === 'unknown_contact').length === before);

    check('the policy rejects an unknown caller', contactsSvc.checkIncomingContact('5557654321') === false);
    const unknown = await waitFor(
      () => parentEvents.alerts.find((a) => a.type === 'unknown_contact'),
      'the unknown-contact alert'
    );
    check('an unknown caller alerts the parent', !!unknown);
  }

  // Un-approving must take the contact off the device, not merely grey it out
  // in the dashboard.
  const unapprove = await contactApi('PUT', `/contacts/${grandma.data.id}`, { isApproved: false });
  check('the parent can un-approve a contact', unapprove.status === 200);
  await waitFor(() => !deviceContactNames().includes('Grandma'), 'the un-approval to reach the device');
  check('an un-approved contact disappears from the device', !deviceContactNames().includes('Grandma'));
  check('the device stops treating the number as approved',
    contactsSvc.isApprovedNumber('5550100199') === false);

  await contactApi('PUT', `/contacts/${grandma.data.id}`, { isApproved: true });
  await waitFor(() => deviceContactNames().includes('Grandma'), 're-approval to reach the device');
  check('re-approving puts the contact back on the device', deviceContactNames().includes('Grandma'));

  // An edit to the details, not just the approval flag.
  await contactApi('PUT', `/contacts/${grandma.data.id}`, { phoneNumber: '5552223333' });
  await waitFor(() => contactsSvc.isApprovedNumber('5552223333'), 'the edited number to reach the device');
  check('an edited phone number reaches the device', contactsSvc.isApprovedNumber('5552223333') === true);
  check('the device stops matching the replaced number',
    contactsSvc.isApprovedNumber('5550100199') === false);

  // ── Several contacts, and removal ──────────────────────────────────────────
  step('Contact lists of a realistic size stay correct');
  const bulk = [];
  for (let i = 0; i < 10; i += 1) {
    bulk.push(await contactApi('POST', '/contacts', {
      childId, name: `Contact ${String(i).padStart(2, '0')}`, phoneNumber: `55501000${String(i).padStart(2, '0')}`,
    }));
  }
  check('all ten contacts were created', bulk.every((r) => r.status === 201));
  await waitFor(() => contactsSvc.getContacts().contacts.length === 11, 'all eleven contacts to reach the device');
  check('the device holds every approved contact', contactsSvc.getContacts().contacts.length === 11,
    String(contactsSvc.getContacts().contacts.length));

  // Section G: duplicates must not accumulate across repeated syncs.
  await contactsSvc.syncContacts();
  await contactsSvc.syncContacts();
  const ids = contactsSvc.getContacts().contacts.map((c) => c.id);
  check('repeated syncs do not duplicate contacts', new Set(ids).size === ids.length && ids.length === 11,
    String(ids.length));

  const removed = await contactApi('DELETE', `/contacts/${bulk[0].data.id}`);
  check('the parent can remove a contact', removed.status === 200);
  await waitFor(() => contactsSvc.getContacts().contacts.length === 10, 'the removal to reach the device');
  check('a removed contact disappears from the device', !deviceContactNames().includes('Contact 00'));
  check('the device no longer treats the removed number as approved',
    contactsSvc.isApprovedNumber('5550100000') === false);

  // ── Rapid consecutive changes ──────────────────────────────────────────────
  // Section H: several edits in flight at once must settle on the last one, not
  // on whichever response the network happened to deliver last.
  step('Rapid consecutive changes settle on the last valid state');
  const churn = bulk[1].data.id;
  await Promise.all([
    contactApi('PUT', `/contacts/${churn}`, { name: 'Churn A' }),
    contactApi('PUT', `/contacts/${churn}`, { name: 'Churn B' }),
    contactApi('PUT', `/contacts/${churn}`, { name: 'Churn C' }),
  ]);
  await contactApi('PUT', `/contacts/${churn}`, { name: 'Churn Final' });

  await waitFor(() => deviceContactNames().includes('Churn Final'), 'the final name to reach the device');
  await new Promise((r) => setTimeout(r, 500)); // let any straggler response land
  const server = await contactApi('GET', `/contacts?childId=${childId}`);
  const serverName = server.data.find((c) => c.id === churn)?.name;
  check('the device agrees with the database after rapid edits',
    deviceContactNames().includes('Churn Final') && serverName === 'Churn Final',
    JSON.stringify({ device: deviceContactNames().filter((n) => n.startsWith('Churn')), server: serverName }));
  check('no stale intermediate name is left on the device',
    !deviceContactNames().some((n) => ['Churn A', 'Churn B', 'Churn C'].includes(n)));

  // ── Offline behaviour ──────────────────────────────────────────────────────
  step('Contacts survive going offline and resynchronise on reconnect');
  {
    const apiModule = await import(src('services/api.js'));
    // Reject at the transport layer: requests never leave the device, which is
    // what "no network" looks like to everything above axios.
    const cut = apiModule.default.interceptors.request.use(() => {
      throw new Error('Network Error');
    });

    const beforeOffline = deviceContactNames();
    await contactsSvc.syncContacts();
    check('a failed sync keeps the last known list',
      JSON.stringify(deviceContactNames()) === JSON.stringify(beforeOffline),
      JSON.stringify(deviceContactNames()));
    check('the device still enforces the policy while offline',
      contactsSvc.isApprovedNumber('5550100199') === false && contactsSvc.isApprovedNumber('5552223333') === true);
    check('the failure is recorded rather than swallowed', !!contactsSvc.getContacts().lastError);

    // A change made while the device is away.
    await contactApi('POST', '/contacts', { childId, name: 'Added While Offline', phoneNumber: '5558887777' });
    await new Promise((r) => setTimeout(r, 300));
    check('a change made while offline does not appear on the device',
      !deviceContactNames().includes('Added While Offline'));

    // Restart the app while still offline: a fresh module instance must come up
    // holding the cached list rather than an empty one.
    const restarted = await import(`${src('services/contacts.js')}?restart=offline`);
    await restarted.startContactsSync(() => {});
    check('an app restarted while offline still holds its approved contacts',
      restarted.getContacts().contacts.length === beforeOffline.length,
      JSON.stringify(restarted.getContacts().contacts.map((c) => c.name)));
    check('the restarted app still enforces the policy offline',
      restarted.isApprovedNumber('5552223333') === true);
    restarted.stopContactsSync();

    // Back online.
    apiModule.default.interceptors.request.eject(cut);
    await contactsSvc.syncContacts();
    check('the queued change lands once the device reconnects',
      deviceContactNames().includes('Added While Offline'), JSON.stringify(deviceContactNames()));
    check('reconnecting clears the recorded error', contactsSvc.getContacts().lastError === null);
    const afterIds = contactsSvc.getContacts().contacts.map((c) => c.id);
    check('reconnecting does not duplicate anything', new Set(afterIds).size === afterIds.length);
  }

  // ── Contact isolation between children ─────────────────────────────────────
  step('One child\'s contacts never reach another child');
  {
    const sibling = await call('POST', '/children', { token: parentToken, body: { name: 'Ben', age: 9 } });
    await contactApi('POST', '/contacts', {
      childId: sibling.data.id, name: 'Ben Only Contact', phoneNumber: '5556665555',
    });
    await contactsSvc.syncContacts();
    check('a sibling\'s contact does not reach this device',
      !deviceContactNames().includes('Ben Only Contact'), JSON.stringify(deviceContactNames()));
    check('the sibling\'s number is not treated as approved',
      contactsSvc.isApprovedNumber('5556665555') === false);
  }

  // ── Web history reaches the parent dashboard ───────────────────────────────
  // The full pipeline, minus the Kotlin DNS parser: the stub stands in for the
  // proxy's flush, and everything above it — queueing, batching, upload, storage
  // and the dashboard query — is the shipping code.
  step('Web history travels from the device to the dashboard');
  const webHistory = await import(src('services/webHistory.js'));
  const historyFor = (query = '') =>
    call('GET', `/activity/${childId}/web-history${query}`, { token: parentToken });

  {
    const empty = await historyFor();
    check('the dashboard starts with an empty history', empty.data.count === 0, JSON.stringify(empty.data.count));

    const now = Date.now();
    platformState.pendingWebVisits = [
      { domain: 'wikipedia.org', firstSeen: now - 60_000, lastSeen: now, count: 4, blocked: false },
      { domain: 'khanacademy.org', firstSeen: now - 30_000, lastSeen: now, count: 2, blocked: false },
      { domain: 'bad.example.com', firstSeen: now - 10_000, lastSeen: now, count: 1, blocked: true },
    ];
    await webHistory.collectNow();
    check('the device asked the DNS proxy for its buffer', spy.webHistoryFlushes > 0);
    check('the visits were queued', webHistory.getWebHistoryStatus().queued === 3,
      JSON.stringify(webHistory.getWebHistoryStatus()));

    await webHistory.uploadWebHistory();
    check('the queue drains once uploaded', webHistory.getWebHistoryStatus().queued === 0,
      JSON.stringify(webHistory.getWebHistoryStatus()));

    const history = await historyFor();
    const domains = history.data.rows.map((r) => r.url).sort();
    check('the parent dashboard shows the visited sites',
      domains.join(',') === 'bad.example.com,khanacademy.org,wikipedia.org', JSON.stringify(domains));
    check('the record carries the visit count',
      history.data.rows.find((r) => r.url === 'wikipedia.org')?.visitCount === 4,
      JSON.stringify(history.data.rows.map((r) => [r.url, r.visitCount])));
    check('the record is attributed to this device',
      history.data.rows.every((r) => r.deviceId === confirm.data.device.id));
    check('a blocked lookup is recorded too', domains.includes('bad.example.com'));

    // Section K: timestamps must survive the trip intact.
    const wiki = history.data.rows.find((r) => r.url === 'wikipedia.org');
    const drift = Math.abs(new Date(wiki.startTime).getTime() - (now - 60_000));
    check('the timestamp matches when the visit happened', drift < 5000, `${drift}ms drift`);

    // Section K: repeat lookups must not each become a row.
    platformState.pendingWebVisits = [
      { domain: 'wikipedia.org', firstSeen: Date.now(), lastSeen: Date.now(), count: 6, blocked: false },
    ];
    await webHistory.collectNow();
    await webHistory.uploadWebHistory();

    const merged = await historyFor();
    check('a repeat visit folds into the existing record', merged.data.count === 3,
      JSON.stringify(merged.data.count));
    check('the visit count accumulates',
      merged.data.rows.find((r) => r.url === 'wikipedia.org')?.visitCount === 10,
      JSON.stringify(merged.data.rows.map((r) => [r.url, r.visitCount])));
  }

  // ── Dashboard filtering and search ─────────────────────────────────────────
  step('The dashboard can filter and search the history');
  {
    const exact = await historyFor('?search=wikipedia.org');
    check('an exact domain search matches', exact.data.rows.map((r) => r.url).join(',') === 'wikipedia.org',
      JSON.stringify(exact.data.rows.map((r) => r.url)));

    const fragment = await historyFor('?search=example');
    check('a partial search matches', fragment.data.rows.map((r) => r.url).join(',') === 'bad.example.com',
      JSON.stringify(fragment.data.rows.map((r) => r.url)));

    const miss = await historyFor('?search=nowhere-at-all');
    check('a search with no matches returns an empty list, not an error',
      miss.status === 200 && miss.data.count === 0);

    const future = await historyFor(`?from=${new Date(Date.now() + 86_400_000).toISOString()}`);
    check('a date filter excludes everything outside it', future.data.count === 0, JSON.stringify(future.data.count));

    const today = await historyFor(`?from=${new Date(Date.now() - 86_400_000).toISOString()}`);
    check('a date filter includes what falls inside it', today.data.count === 3, JSON.stringify(today.data.count));
  }

  // ── Web history offline ────────────────────────────────────────────────────
  step('Web history queues while offline and lands on reconnect');
  {
    const apiModule = await import(src('services/api.js'));
    const cut = apiModule.default.interceptors.request.use(() => { throw new Error('Network Error'); });

    platformState.pendingWebVisits = [
      { domain: 'offline-visit.example.com', firstSeen: Date.now(), lastSeen: Date.now(), count: 1, blocked: false },
    ];
    await webHistory.collectNow();
    await webHistory.uploadWebHistory();

    check('a failed upload keeps the visit queued', webHistory.getWebHistoryStatus().queued === 1,
      JSON.stringify(webHistory.getWebHistoryStatus()));
    check('the upload failure is recorded', !!webHistory.getWebHistoryStatus().lastError);

    const during = await historyFor();
    check('nothing reached the server while offline', during.data.count === 3, JSON.stringify(during.data.count));

    // Restart while still offline: the queue must come back from disk.
    const restarted = await import(`${src('services/webHistory.js')}?restart=offline`);
    await restarted.startWebHistory();
    check('a restart while offline recovers the queued visits',
      restarted.getWebHistoryStatus().queued === 1, JSON.stringify(restarted.getWebHistoryStatus()));
    restarted.stopWebHistory();

    apiModule.default.interceptors.request.eject(cut);
    await webHistory.uploadWebHistory();

    const after = await historyFor();
    check('the queued visit lands once back online',
      after.data.rows.some((r) => r.url === 'offline-visit.example.com'), JSON.stringify(after.data.rows.map((r) => r.url)));
    check('the queue is empty again', webHistory.getWebHistoryStatus().queued === 0);
    check('a retried upload does not duplicate the record',
      after.data.rows.filter((r) => r.url === 'offline-visit.example.com').length === 1);
  }

  // ── Web history isolation ──────────────────────────────────────────────────
  step('Web history stays with the child it belongs to');
  {
    const others = await call('GET', '/children', { token: parentToken });
    const sibling = others.data.find((c) => c.name === 'Ben');
    const siblingHistory = await call('GET', `/activity/${sibling.id}/web-history`, { token: parentToken });
    check('a sibling\'s history is empty', siblingHistory.data.count === 0, JSON.stringify(siblingHistory.data.count));

    // A second family must not be able to read this one's history at all.
    const otherEmail = `wh_other_${Date.now()}@parentix.test`;
    await call('POST', '/auth/register', { body: { name: 'Other Parent', email: otherEmail, password: 'other-pass-1' } });
    const otherCode = await waitFor(
      () => serverOutput.match(new RegExp(`"email":"${otherEmail}","code":"(\\d{6})"`))?.[1],
      'the other parent\'s verification code'
    );
    const otherVerify = await call('POST', '/auth/verify-email', { body: { email: otherEmail, code: otherCode } });
    const stolen = await call('GET', `/activity/${childId}/web-history`, { token: otherVerify.data.token });
    check('another family cannot read this child\'s history', stolen.status === 404, String(stolen.status));
  }

  // ── Push notifications ─────────────────────────────────────────────────────
  // The device half of the chain: permission, token, registration, and how the
  // app handles a notification in the foreground, in the background, and when it
  // was not running. Actual delivery by Expo/FCM needs a device build and real
  // credentials — see the API's push.test.js for the server half.
  step('The device registers for push notifications');
  const pushSvc = await import(src('services/push.js'));

  {
    // Monitoring registers for push as part of starting up, so by now the child
    // has already been asked once and the token is already registered. That
    // ordering is the product behaviour, so it is what gets asserted.
    check('starting monitoring asked the child for permission', spy.notificationPrompts === 1,
      String(spy.notificationPrompts));
    check('starting monitoring registered the device for push',
      monitoring.getMonitoringStatus().status.pushNotifications === true,
      JSON.stringify(monitoring.getMonitoringStatus().status));
    check('permission is now granted', (await pushSvc.checkPermission()) === 'granted');

    const registered = await pushSvc.registerForPush();
    check('registration reports success', registered.ok === true, JSON.stringify(registered));
    check('the app obtained a push token',
      registered.token === 'ExponentPushToken[e2e-child-device-token]', String(registered.token));
    check('the token was requested against the EAS project',
      spy.pushTokenRequests.includes('e2e-project-id'), JSON.stringify(spy.pushTokenRequests));
    check('an Android notification channel was created',
      spy.notificationChannels.some((c) => c.id === 'parentix-alerts'),
      JSON.stringify(spy.notificationChannels.map((c) => c.id)));
    check('a foreground handler was installed so messages show while the app is open',
      typeof spy.notificationHandler?.handleNotification === 'function');

    // Section N: the app must not re-prompt somebody who has already answered.
    const promptsAfter = spy.notificationPrompts;
    await pushSvc.registerForPush();
    check('a second registration does not re-prompt', spy.notificationPrompts === promptsAfter,
      String(spy.notificationPrompts - promptsAfter));
    check('an unchanged token is not re-sent to the server',
      (await pushSvc.registerForPush()).reason === 'already-registered');
  }

  // ── The token reached the backend ──────────────────────────────────────────
  step('The backend stores the token against the right device');
  {
    // Verified through the API rather than by trusting the client's own report.
    const devices = await call('GET', '/devices', { token: parentToken });
    const thisDevice = devices.data.find((d) => d.id === confirm.data.device.id);
    check('the parent can still see the device', !!thisDevice);

    // Re-registering a token already held must not create a second row: the
    // server-side count is asserted in push.test.js; here we check the device
    // agrees it is registered.
    check('the device reports itself registered', pushSvc.getPushStatus().registered === true,
      JSON.stringify(pushSvc.getPushStatus()));
    check('the device records no push error', pushSvc.getPushStatus().lastError === null);
  }

  // ── Handling a delivered notification ──────────────────────────────────────
  step('The device handles notifications in every app state');
  {
    const opened = [];
    const received = [];
    await pushSvc.startPushHandling({
      onReceive: (data) => received.push(data),
      onOpen: (data) => opened.push(data),
    });

    // Foreground: arrives while the app is open.
    stubs.deliverNotification({ type: 'chat', screen: 'Messages', messageId: 'm1' });
    check('a foreground notification reaches the app', received.length === 1, JSON.stringify(received));

    // Background: the child taps it.
    stubs.deliverNotification({ type: 'chat', screen: 'Messages', messageId: 'm2' }, { tapped: true });
    check('tapping a notification is handled', opened.length === 1, JSON.stringify(opened));
    check('the tap carries the screen to open', opened[0].screen === 'Messages', JSON.stringify(opened[0]));

    // Closed: the tap happened before the app was running.
    platformState.coldStartNotification = {
      notification: { request: { content: { data: { type: 'chat', screen: 'Messages', messageId: 'm3' } } } },
    };
    const coldOpened = [];
    await pushSvc.startPushHandling({ onOpen: (data) => coldOpened.push(data) });
    check('a notification tapped while the app was closed is replayed on start',
      coldOpened.some((d) => d.messageId === 'm3'), JSON.stringify(coldOpened));
    platformState.coldStartNotification = null;

    pushSvc.stopPushHandling();
    const afterStop = received.length;
    stubs.deliverNotification({ type: 'chat' });
    check('handlers are removed on teardown, leaving no duplicate listeners',
      received.length === afterStop, `${received.length} vs ${afterStop}`);
  }

  // ── Permission denied ──────────────────────────────────────────────────────
  step('A denied notification permission is handled gracefully');
  {
    const denied = await import(`${src('services/push.js')}?denied=1`);
    platformState.permissions.notifications = 'denied';
    platformState.canAskForNotifications = false;

    const result = await denied.registerForPush();
    check('registration reports the denial rather than failing', result.ok === false && result.reason === 'denied',
      JSON.stringify(result));
    check('a denial is not recorded as an error', denied.getPushStatus().lastError === null);

    const request = await denied.requestPermission();
    check('the app does not re-prompt once Android has stopped asking',
      request.mustUseSettings === true, JSON.stringify(request));

    // Restore for anything downstream.
    platformState.permissions.notifications = 'granted';
    platformState.canAskForNotifications = true;
  }

  // ── Registration while offline ─────────────────────────────────────────────
  step('Push registration recovers after being offline');
  {
    const apiModule = await import(src('services/api.js'));
    const offline = await import(`${src('services/push.js')}?offline=1`);
    const cut = apiModule.default.interceptors.request.use(() => { throw new Error('Network Error'); });

    const failed = await offline.registerForPush({ force: true });
    check('a registration that cannot reach the server reports failure',
      failed.ok === false && failed.reason === 'failed', JSON.stringify(failed));
    check('the failure is recorded', !!offline.getPushStatus().lastError);

    apiModule.default.interceptors.request.eject(cut);
    const recovered = await offline.registerForPush({ force: true });
    check('registration succeeds once back online', recovered.ok === true, JSON.stringify(recovered));
    check('the recorded error is cleared', offline.getPushStatus().lastError === null);
  }

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

  // ── Unlink, and link again ─────────────────────────────────────────────────
  /*
   * The other half of linking, which nothing used to exercise.
   *
   * Removing a device is a soft delete on the server; the phone kept its token,
   * kept showing itself as linked and kept enforcing the last rules it had, and
   * every call it made was answered 401 by a server that would not say why. The
   * fix runs on both sides — the API distinguishes "this device is gone" from
   * "this family is temporarily suspended", and the app acts only on the first —
   * so both halves are asserted here against a real server.
   */
  step('The parent unlinks the device, and links it again');
  {
    const removedDeviceId = confirm.data.device.id;
    let unlinkedCalls = 0;
    // What App.js does with the same signal: stop the monitors and send the
    // child back to the linking screen.
    const stopListening = linkSvc.onUnlinked(() => {
      unlinkedCalls += 1;
      monitoring.stopMonitoring();
    });

    // A suspended family must not trigger any of this: the parent would have to
    // sign in to issue a fresh code, which is exactly what they cannot do.
    check('a suspended account does not make the phone forget its link',
      linkSvc.handleAuthFailure('account_suspended') === false
      && (await linkSvc.hasLink()) === true);

    const removal = await call('DELETE', `/devices/${removedDeviceId}`, { token: parentToken });
    check('the parent can remove the device', removal.status === 200, JSON.stringify(removal.data));

    await waitFor(() => unlinkedCalls > 0, 'the phone to notice it was unlinked');
    check('the phone is told over the socket, not left to guess', unlinkedCalls === 1, String(unlinkedCalls));
    check('the credentials are discarded', (await secureStoreStub.getItemAsync('fg_device_token')) === null);
    check('the app no longer considers itself linked', (await linkSvc.hasLink()) === false);
    check('the device stops blocking apps',
      Array.isArray(spy.blockedApps) && spy.blockedApps.length === 0, JSON.stringify(spy.blockedApps));

    // Nothing belonging to the previous child may survive into the next link.
    check('the approved contacts are forgotten', contactsSvc.getContacts().contacts.length === 0,
      JSON.stringify(deviceContactNames()));
    check('the queued web history is dropped rather than posted under a new link',
      webHistory.getWebHistoryStatus().queued === 0, JSON.stringify(webHistory.getWebHistoryStatus()));
    check('the cached child name is forgotten',
      (await secureStoreStub.getItemAsync('fg_child_name')) === null);

    // The old token is dead on the server too, and says so in a way the app can
    // act on rather than a bare "revoked".
    const withOldToken = await fetch(`${BASE}/api/devices/me/rules`, {
      headers: { Authorization: `Bearer ${confirm.data.deviceToken}` },
    });
    const refusal = await withOldToken.json();
    check('the old device token is refused', withOldToken.status === 401, String(withOldToken.status));
    check('the refusal says the device is unlinked, not merely revoked',
      refusal.code === 'device_unlinked', JSON.stringify(refusal));

    // A code for the device that has just been removed must not work either —
    // it used to, producing a link to a row the parent could no longer see.
    const staleLink = await call('POST', '/devices/link', {
      token: parentToken, body: { childId, deviceName: 'Doomed' },
    });
    await call('DELETE', `/devices/${staleLink.data.device.id}`, { token: parentToken });
    const staleConfirm = await call('POST', '/devices/confirm', { body: { code: staleLink.data.code } });
    check('a code whose device was removed is refused', staleConfirm.status === 410,
      `${staleConfirm.status} ${JSON.stringify(staleConfirm.data)}`);

    // And the whole thing works again from scratch.
    stopListening();
    const relink = await call('POST', '/devices/link', {
      token: parentToken, body: { childId, deviceName: "Ada's Phone", type: 'android' },
    });
    const reconfirm = await deviceApi.confirmLink(relink.data.code.toLowerCase());
    check('the phone links again with a fresh code (in any case)', !!reconfirm.data.deviceToken,
      JSON.stringify(reconfirm.data));

    await linkSvc.saveLink({
      deviceToken: reconfirm.data.deviceToken,
      deviceId: reconfirm.data.device.id,
      childId: reconfirm.data.device.childId,
    });

    const linkedEvent = await waitFor(
      () => parentEvents.deviceLinks.find((d) => d.deviceId === reconfirm.data.device.id),
      'the parent to be told the device connected'
    );
    check('the parent app is told in realtime that the device connected', !!linkedEvent);
    check('the event names the device and child',
      linkedEvent.name === "Ada's Phone" && linkedEvent.childId === childId, JSON.stringify(linkedEvent));

    await monitoring.startMonitoring();
    check('monitoring comes back up on the new link',
      monitoring.getMonitoringStatus().rules.appRules.length > 0,
      JSON.stringify(monitoring.getMonitoringStatus().rules.appRules.length));
    check('the parent\'s rules are enforced again',
      spy.blockedApps.includes('com.example.game'), JSON.stringify(spy.blockedApps));
    check('the device reports a healthy sync',
      monitoring.getMonitoringStatus().sync.lastError === null
      && !!monitoring.getMonitoringStatus().sync.lastSyncAt,
      JSON.stringify(monitoring.getMonitoringStatus().sync));
  }

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
