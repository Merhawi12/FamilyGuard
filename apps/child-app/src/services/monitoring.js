import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import { device as deviceApi, location as locationApi } from './api';
import { startRulesSync, stopRulesSync, getRules, emitEvent } from './rules';
import { disconnectSocket } from './socket';
import AppBlocker from '../native/AppBlocker';
import UsageStats from '../native/UsageStats';
import VpnControl from '../native/VpnControl';

const BG_TASK = 'fg-monitoring-task';
const LOCATION_TASK = 'fg-location-task';

// Packages excluded from screen-time totals (own app, launchers, core system UI)
const EXCLUDED_PACKAGES = new Set(['com.parentix']);
const isExcludedPackage = (pkg) =>
  EXCLUDED_PACKAGES.has(pkg) ||
  pkg.startsWith('com.android.launcher') ||
  pkg.startsWith('com.google.android.apps.nexuslauncher') ||
  pkg === 'com.android.systemui' ||
  pkg.startsWith('com.android.settings');

const _state = {
  status: {
    monitoring: false,
    appBlocking: false,
    websiteBlocking: false,
    locationTracking: false,
  },
  rules: { appRules: [], websiteRules: [], screenTimeRule: null },
  todayMinutes: 0,
  screenTimeAlertedDate: null, // last date we alerted the parent about the limit
  limitReached: false,         // drives the wildcard block, and its release
};

let _blockSub = null; // native onAppBlocked subscription

export function getMonitoringStatus() {
  return { ..._state, rules: getRules() };
}

/**
 * The packages this device should block right now.
 *
 * Kept in one place because two things drive it: the parent's app rules, and
 * the screen-time limit, which blocks everything with the `*` wildcard. Working
 * out the whole set each time is what stops a limit hit on one day leaving the
 * device blocked on the next.
 */
function blockedPackagesFor(rules, limitReached) {
  if (limitReached) return ['*'];
  return rules.appRules
    .filter((r) => r.action === 'block')
    .map((r) => r.appPackage)
    .filter(Boolean);
}

/** Blocked domains from the parent's website rules. The column is `url`. */
function blockedDomainsFor(rules) {
  return rules.websiteRules
    .filter((r) => r.action === 'block')
    .map((r) => r.url)
    .filter(Boolean);
}

// ── Rules change handler ───────────────────────────────────────────────────────
async function applyRules(rules) {
  _state.rules = rules;

  // App blocking
  const blockedPackages = blockedPackagesFor(rules, _state.limitReached);
  AppBlocker.setBlockedApps(blockedPackages);
  _state.status.appBlocking = (await AppBlocker.isAccessibilityEnabled()) && blockedPackages.length > 0;

  // Website blocking
  const blockedDomains = blockedDomainsFor(rules);
  if (blockedDomains.length === 0) {
    await VpnControl.stopVpn();
    _state.status.websiteBlocking = false;
  } else if (await VpnControl.hasPermission()) {
    await VpnControl.startVpn(blockedDomains);
    _state.status.websiteBlocking = true;
  } else {
    // Rules exist but the child has not accepted the VPN prompt — report it as
    // off rather than leaving a stale "on" from a previous run.
    _state.status.websiteBlocking = false;
  }
}

// ── Usage stats sync ──────────────────────────────────────────────────────────
async function syncUsageStats() {
  const hasPerm = await UsageStats.hasPermission();
  if (!hasPerm) return;

  const stats = await UsageStats.getUsageStats();
  let totalMinutes = 0;

  for (const [packageName, data] of Object.entries(stats)) {
    if (data.minutes < 1) continue;
    if (isExcludedPackage(packageName)) continue;
    totalMinutes += data.minutes;

    try {
      await deviceApi.logActivity({
        appPackage: packageName,
        appName: data.appName || packageName,
        category: 'app_usage',
        startTime: data.startTime || new Date(Date.now() - data.minutes * 60000).toISOString(),
        endTime: new Date().toISOString(),
        durationMinutes: Math.round(data.minutes),
      });
    } catch (err) {
      // One app failing to upload must not abort the rest of the batch; the
      // next sync re-sends it, and the server upserts by (child, app, day).
      console.warn('[monitoring] activity upload failed:', packageName, err.message);
    }
  }

  _state.todayMinutes = totalMinutes;

  /**
   * Screen-time enforcement.
   *
   * Usage resets at midnight, so this has to be able to *release* the block as
   * well as apply it — the earlier version only ever called `setBlockedApps`
   * when the limit was hit, and since the native side persists the list, a
   * device blocked yesterday stayed blocked today until a rules update landed.
   */
  const { screenTimeRule } = getRules();
  const limit = screenTimeRule?.dailyLimitMinutes;
  const limitReached = !!limit && totalMinutes >= limit;

  if (limitReached !== _state.limitReached) {
    _state.limitReached = limitReached;
    // '*' is the wildcard the accessibility service reads as "block everything".
    AppBlocker.setBlockedApps(blockedPackagesFor(getRules(), limitReached));
  }

  // Notify the parent once per day that the limit was reached.
  if (limitReached) {
    const today = new Date().toISOString().slice(0, 10);
    if (_state.screenTimeAlertedDate !== today) {
      _state.screenTimeAlertedDate = today;
      emitEvent('alert:screen_time_exceeded');
    }
  }
}

// ── Location tracking ─────────────────────────────────────────────────────────
async function startLocationTracking() {
  const { granted: fg } = await Location.getForegroundPermissionsAsync();
  if (!fg) return false;

  if (!TaskManager.isTaskDefined(LOCATION_TASK)) {
    TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
      if (error || !data?.locations?.length) return;
      const loc = data.locations[0];
      try {
        // The server derives childId and deviceId from the device token and
        // rejects them in the body, so only the fix itself is sent.
        await locationApi.post({
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          accuracy: loc.coords.accuracy,
          speed: loc.coords.speed,
          heading: loc.coords.heading,
        });
      } catch (err) {
        // Background task: the device is often mid-handover between networks.
        // Dropping one fix is fine — another follows within the minute.
        console.warn('[monitoring] location upload failed:', err.message);
      }
    });
  }

  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 60_000,      // min 1 update/min
    distanceInterval: 50,       // or every 50m
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Parentix',
      notificationBody: 'Location monitoring active',
      notificationColor: '#2563eb',
    },
  });

  return true;
}

// ── Background sync task ──────────────────────────────────────────────────────
if (!TaskManager.isTaskDefined(BG_TASK)) {
  TaskManager.defineTask(BG_TASK, async () => {
    try {
      await syncUsageStats();
      await deviceApi.heartbeat();
      return BackgroundFetch.BackgroundFetchResult.NewData;
    } catch {
      return BackgroundFetch.BackgroundFetchResult.Failed;
    }
  });
}

// ── Public API ────────────────────────────────────────────────────────────────
export async function startMonitoring() {
  // Sync rules and apply them
  await startRulesSync(applyRules);
  await syncUsageStats();

  // Relay native "a blocked app was opened" events to the parent as alerts.
  _blockSub?.remove();
  _blockSub = AppBlocker.onAppBlocked?.((packageName) => {
    const rule = getRules().appRules?.find((r) => r.appPackage === packageName);
    emitEvent('alert:blocked_app', { appName: rule?.appName || packageName });
  });

  // Register background fetch (runs every ~15 min on Android)
  try {
    await BackgroundFetch.registerTaskAsync(BG_TASK, {
      minimumInterval: 15 * 60,
      stopOnTerminate: false,
      startOnBoot: true,
    });
  } catch (err) {
    // Background fetch is unavailable on some OEM builds and when the user has
    // restricted background activity. Monitoring still works in the foreground.
    console.warn('[monitoring] background fetch unavailable:', err.message);
  }

  // Location
  _state.status.locationTracking = await startLocationTracking();

  // Heartbeat
  try {
    await deviceApi.heartbeat();
  } catch (err) {
    // Offline at startup — the background task heartbeats again in ~15 min.
    console.warn('[monitoring] heartbeat failed:', err.message);
  }

  _state.status.monitoring = true;
}

export function stopMonitoring() {
  stopRulesSync();
  // Rules sync no longer owns the socket, so close it here — monitoring
  // stopping is what actually means "this device is done talking to the server".
  disconnectSocket();
  _blockSub?.remove();
  _blockSub = null;
  VpnControl.stopVpn().catch(() => {});
  AppBlocker.setBlockedApps([]);
  _state.limitReached = false;
  _state.status = { monitoring: false, appBlocking: false, websiteBlocking: false, locationTracking: false };
}
