import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import * as SecureStore from 'expo-secure-store';
import { device as deviceApi, location as locationApi } from './api';
import { startRulesSync, stopRulesSync, getRules } from './rules';
import AppBlocker from '../native/AppBlocker';
import UsageStats from '../native/UsageStats';
import VpnControl from '../native/VpnControl';

const BG_TASK = 'fg-monitoring-task';
const LOCATION_TASK = 'fg-location-task';

let _state = {
  status: {
    monitoring: false,
    appBlocking: false,
    websiteBlocking: false,
    locationTracking: false,
  },
  rules: { appRules: [], websiteRules: [], screenTimeRule: null },
  todayMinutes: 0,
};

export function getMonitoringStatus() {
  return { ..._state, rules: getRules() };
}

// ── Rules change handler ───────────────────────────────────────────────────────
async function applyRules(rules) {
  _state.rules = rules;

  // App blocking
  const blockedPackages = rules.appRules
    .filter((r) => r.action === 'block')
    .map((r) => r.appPackage)
    .filter(Boolean);
  AppBlocker.setBlockedApps(blockedPackages);
  _state.status.appBlocking = (await AppBlocker.isAccessibilityEnabled()) && blockedPackages.length > 0;

  // Website blocking
  const blockedDomains = rules.websiteRules
    .filter((r) => r.action === 'block')
    .map((r) => r.domain)
    .filter(Boolean);
  if (blockedDomains.length > 0 && (await VpnControl.hasPermission())) {
    await VpnControl.startVpn(blockedDomains);
    _state.status.websiteBlocking = true;
  } else if (blockedDomains.length === 0) {
    await VpnControl.stopVpn();
    _state.status.websiteBlocking = false;
  }
}

// ── Usage stats sync ──────────────────────────────────────────────────────────
async function syncUsageStats() {
  const hasPerm = await UsageStats.hasPermission();
  if (!hasPerm) return;

  const stats = await UsageStats.getUsageStats();
  let totalMinutes = 0;
  const deviceId = await SecureStore.getItemAsync('fg_device_id');
  const childId = await SecureStore.getItemAsync('fg_child_id');

  for (const [packageName, data] of Object.entries(stats)) {
    if (data.minutes < 1) continue;
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
    } catch (_) {}
  }

  _state.todayMinutes = totalMinutes;

  // Screen time limit enforcement
  const { screenTimeRule } = getRules();
  if (screenTimeRule?.dailyLimitMinutes && totalMinutes >= screenTimeRule.dailyLimitMinutes) {
    AppBlocker.setBlockedApps(['*']); // block everything
    // The accessibility service will handle home screen redirect
  }
}

// ── Location tracking ─────────────────────────────────────────────────────────
async function startLocationTracking() {
  const { granted: fg } = await Location.getForegroundPermissionsAsync();
  const { granted: bg } = await Location.getBackgroundPermissionsAsync();
  if (!fg) return false;

  const childId = await SecureStore.getItemAsync('fg_child_id');
  const deviceId = await SecureStore.getItemAsync('fg_device_id');

  if (!TaskManager.isTaskDefined(LOCATION_TASK)) {
    TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
      if (error || !data?.locations?.length) return;
      const loc = data.locations[0];
      try {
        await locationApi.post({
          childId,
          deviceId,
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          accuracy: loc.coords.accuracy,
          speed: loc.coords.speed,
          heading: loc.coords.heading,
        });
      } catch (_) {}
    });
  }

  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 60_000,      // min 1 update/min
    distanceInterval: 50,       // or every 50m
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'FamilyGuard',
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

  // Register background fetch (runs every ~15 min on Android)
  try {
    await BackgroundFetch.registerTaskAsync(BG_TASK, {
      minimumInterval: 15 * 60,
      stopOnTerminate: false,
      startOnBoot: true,
    });
  } catch (_) {}

  // Location
  _state.status.locationTracking = await startLocationTracking();

  // Heartbeat
  try { await deviceApi.heartbeat(); } catch (_) {}

  _state.status.monitoring = true;
}

export function stopMonitoring() {
  stopRulesSync();
  VpnControl.stopVpn().catch(() => {});
  AppBlocker.setBlockedApps([]);
  _state.status = { monitoring: false, appBlocking: false, websiteBlocking: false, locationTracking: false };
}
