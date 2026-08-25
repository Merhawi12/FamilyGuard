import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import { device as deviceApi, location as locationApi } from './api';
import { startRulesSync, stopRulesSync, getRules, getSyncStatus, emitEvent } from './rules';
import { startContactsSync, stopContactsSync, syncContacts, getContacts } from './contacts';
import {
  startWebHistory, stopWebHistory, uploadWebHistory, collectNow, getWebHistoryStatus,
} from './webHistory';
import { registerForPush, getPushStatus, notifyLocally } from './push';
import { reportNewApps } from './newApps';
import { lockState, bonusMinutesFrom, minutesUntilLimit } from './schedule';
import { disconnectSocket } from './socket';
import AppBlocker from '../native/AppBlocker';
import UsageStats from '../native/UsageStats';
import VpnControl from '../native/VpnControl';
import { colors } from '../theme';

const BG_TASK = 'fg-monitoring-task';
const LOCATION_TASK = 'fg-location-task';
const LOCK_TICK_MS = 60 * 1000;

/**
 * Packages excluded from screen-time totals: this app, launchers, core system UI.
 *
 * The entry here was `com.parentix`, and the app's `applicationId` is
 * `com.parentix.child` — so the exclusion never matched and Parentix counted
 * itself. Every minute a child spent on the screen that tells them how much time
 * they have left was charged against that time, and worse, the minutes spent in
 * Permissions and Settings — screens the app itself sends them to — pushed them
 * towards a lock. `com.parentix` is kept as a prefix so a future sibling package
 * (a family build, a rename) is excluded too, rather than repeating this.
 */
const isExcludedPackage = (pkg) =>
  pkg === 'com.parentix' ||
  pkg.startsWith('com.parentix.') ||
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
    contactSync: false,
    webHistory: false,
    pushNotifications: false,
  },
  rules: { appRules: [], websiteRules: [], screenTimeRule: null, screenTimeGrants: [] },
  todayMinutes: 0,
  // Minutes used today per package, which is what a per-app `limit` rule is
  // measured against. The whole-device total above cannot answer that question.
  appMinutes: {},
  screenTimeAlertedDate: null, // last date we alerted the parent about the limit
  locked: false,               // drives the wildcard block, and its release
  lockReason: null,            // 'daily_limit' | 'bedtime' | 'outside_schedule'
  /**
   * How much of the phone the current lock is entitled to take: `'limit'` lets
   * the parent's allowlist through, `'strict'` lets nothing through but the
   * safety exception the accessibility service holds. See schedule.js.
   */
  lockTier: null,
  /** Extra minutes the parent granted for today, already filtered to this day. */
  bonusMinutes: 0,
  /** The apps that survive a `daily_limit` lock, as handed to the blocker. */
  allowedPackages: [],
  /**
   * The last "you have N minutes left" that was shown, as `'YYYY-MM-DD:N'`.
   *
   * Keyed by day *and* threshold so each warning fires once: the tick runs every
   * minute, and a child sitting at nine minutes remaining must not be told nine
   * times. Cleared naturally by the date changing, and re-armed when a grant
   * pushes the remaining time back above a threshold — which is the case a bare
   * boolean would get wrong, leaving a child who was granted an hour with no
   * warning at all before the second lock.
   */
  lastLimitWarning: null,
  /**
   * What is blocked at this moment, as handed to the native blocker.
   *
   * The screens used to work this out for themselves by filtering the rules for
   * `action === 'block'`, which is a different question and gave a different
   * answer: it counted an app whose time limit has not been reached, and missed
   * one whose limit has. Reading the decision rather than re-deriving it is what
   * keeps "Paused right now" true.
   */
  blockedPackages: [],
};

let _blockSub = null;  // native onAppBlocked subscription
let _lockTimer = null; // re-evaluates the clock-driven locks
// The last sets handed to the native blocker, so an unchanged set is not pushed
// (and re-persisted to SharedPreferences) every minute.
let _pushedBlocks = null;
let _pushedAllows = null;

export function getMonitoringStatus() {
  return {
    ..._state,
    rules: getRules(),
    sync: getSyncStatus(),
    contacts: getContacts(),
    webHistory: getWebHistoryStatus(),
    push: getPushStatus(),
  };
}

/**
 * The packages this device should block right now.
 *
 * Kept in one place because three things drive it: the parent's outright block
 * rules, a per-app daily limit that has been spent, and a full lock — the
 * whole-device daily limit, bedtime or an out-of-hours schedule — which blocks
 * everything with the `*` wildcard. Working out the whole set each time is what
 * stops a lock on one day leaving the device blocked on the next.
 *
 * A rule with no `appPackage` is dropped because there is nothing to match it
 * against; the API now refuses to create one, but a device can still be holding
 * a cached rule from before that.
 */
function blockedPackagesFor(rules, locked, appMinutes = {}) {
  if (locked) return ['*'];

  const blocked = new Set();
  for (const rule of rules.appRules || []) {
    if (!rule.appPackage) continue;

    if (rule.action === 'block') {
      blocked.add(rule.appPackage);
      continue;
    }

    /**
     * `limit` was a rule the parent could set and nothing anywhere enforced.
     * The measurement it needs is already collected — `getUsageStats` reports
     * minutes per package — so the rule blocks its own app once that app's
     * total for the day reaches the limit, and releases it when usage resets at
     * midnight.
     */
    if (rule.action === 'limit' && rule.dailyLimitMinutes > 0) {
      if ((appMinutes[rule.appPackage] || 0) >= rule.dailyLimitMinutes) {
        blocked.add(rule.appPackage);
      }
    }
  }
  return [...blocked];
}

/**
 * The apps that stay open when the daily limit runs out.
 *
 * Only for the `'limit'` tier. Bedtime, an out-of-hours schedule and a parent's
 * own pause hand back an empty list, so the native side has nothing to let
 * through — the tier decision is made once, in schedule.js, and everything below
 * simply reads it.
 *
 * A `block` rule beats an `allow` rule on the same package, whichever order the
 * rows arrive in. The two together are a parent who blocked an app and later
 * added it to the homework list, and the safe reading of that contradiction is
 * the restrictive one.
 *
 * This is not the safety exception. The dialer, messaging, contacts and the clock
 * are never blocked by anything, with or without a rule, and that lives in
 * AppMonitorService.kt so it holds when this layer is not running at all.
 */
function allowedPackagesFor(rules, tier) {
  if (tier !== 'limit') return [];

  const blocked = new Set(
    (rules.appRules || [])
      .filter((r) => r.action === 'block' && r.appPackage)
      .map((r) => r.appPackage.toLowerCase()),
  );

  const allowed = new Set();
  for (const rule of rules.appRules || []) {
    if (rule.action !== 'allow' || !rule.appPackage) continue;
    const pkg = rule.appPackage.toLowerCase();
    if (blocked.has(pkg)) continue;
    allowed.add(pkg);
  }
  return [...allowed];
}

/** Blocked domains from the parent's website rules. The column is `url`. */
function blockedDomainsFor(rules) {
  return rules.websiteRules
    .filter((r) => r.action === 'block')
    .map((r) => r.url)
    .filter(Boolean);
}

/**
 * How many minutes before the daily limit the child is warned.
 *
 * **Ascending, and it has to be.** `find` takes the first threshold the remaining
 * time is at or under, so descending order answers "10" for four minutes left —
 * a threshold that has already fired, which silently swallows the five-minute
 * warning entirely. Ascending gives the tightest threshold that still applies.
 */
const LIMIT_WARNINGS = [5, 10];

const dayKey = (now) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/**
 * Tell the child before the phone stops, not as it stops.
 *
 * The Home screen has always said "Nearly out of time" under fifteen minutes, but
 * only to a child who happens to be looking at it — and a child who is about to
 * run out of time is, by definition, looking at something else. A lock that lands
 * with no warning reads as a fault, and the reasonable response to a phone that
 * has apparently broken is to keep trying it, which is the behaviour the alert
 * throttles then read as defiance.
 *
 * Fires at most once per threshold per day. The key carries the threshold as well
 * as the date so a grant that puts the child back above ten minutes re-arms the
 * warning — otherwise the second lock of the evening would arrive silently, which
 * is the one the child least expects.
 */
async function warnBeforeLimit(rule, now) {
  const remaining = minutesUntilLimit(rule, _state.todayMinutes, _state.bonusMinutes);
  if (remaining === null) return;

  const threshold = LIMIT_WARNINGS.find((t) => remaining <= t);
  if (threshold === undefined) return;

  const key = `${dayKey(now)}:${threshold}`;
  if (_state.lastLimitWarning === key) return;
  _state.lastLimitWarning = key;

  await notifyLocally({
    // The real figure, not the threshold that matched it. The threshold decides
    // *whether* to speak; saying "5 minutes left" to a child who has four is a
    // small lie that the lock arriving early will make them notice.
    title: `${remaining} ${remaining === 1 ? 'minute' : 'minutes'} left`,
    // Said as a choice rather than a countdown: "finish up" is something a child
    // can act on, and the ask is named because it is the only thing that changes
    // the outcome.
    body: threshold <= 5
      ? 'Your screen time is nearly up. Finish what you are doing, or ask your parent for more.'
      : 'Nearly out of screen time for today. Ask your parent if you need more.',
    data: { type: 'screen_time_warning', minutesLeft: remaining },
  });
}

/**
 * Re-derive what should be blocked from the current rules, usage, grants and
 * clock, and push it to the native blocker when the set has changed.
 *
 * Bedtime and the daily schedule turn on and off with the clock rather than with
 * anything the app does, so this has to run on a timer as well as after a sync
 * or a rules update — and it has to be able to *release* the block, since the
 * native side persists its list across restarts.
 *
 * The comparison is on the resulting package set, not on the lock state. Keying
 * it off the lock was why a per-app daily limit could never have worked: an app
 * crossing its own limit changes what is blocked without changing whether the
 * device is locked, so the new set was computed and then thrown away. The
 * allowlist is compared the same way and for the same reason: a parent adding an
 * app to it changes nothing about whether the phone is locked.
 */
function refreshBlocking() {
  const rules = getRules();
  const now = new Date();

  // Recomputed every pass rather than cached, because a grant expires on the
  // clock: a phone left running past midnight has to stop honouring yesterday's
  // extra minutes without anything else having happened.
  _state.bonusMinutes = bonusMinutesFrom(rules.screenTimeGrants, now);

  const { blocked, reason, tier } = lockState(
    rules.screenTimeRule, _state.todayMinutes, now, rules.blocked, _state.bonusMinutes,
  );

  _state.locked = blocked;
  _state.lockReason = reason;
  _state.lockTier = tier;

  /**
   * The allowlist goes down first, and the order is not cosmetic.
   *
   * The native side reads the two sets independently, on whichever window change
   * comes next. If the wildcard landed first, a child whose homework app is on
   * the allowlist would be bounced out of it during the gap — brief, but it is
   * the exact moment the lock arrives and the exact app they are entitled to. The
   * reverse gap is harmless: an allowlist with no wildcard yet blocks nothing.
   */
  const allowed = allowedPackagesFor(rules, tier);
  _state.allowedPackages = allowed;
  const allowedKey = [...allowed].sort().join(',');
  if (allowedKey !== _pushedAllows) {
    _pushedAllows = allowedKey;
    AppBlocker.setAllowedApps(allowed);
  }

  // '*' is the wildcard the accessibility service reads as "block everything".
  const packages = blockedPackagesFor(rules, blocked, _state.appMinutes);
  _state.blockedPackages = packages;
  const key = [...packages].sort().join(',');
  if (key !== _pushedBlocks) {
    _pushedBlocks = key;
    AppBlocker.setBlockedApps(packages);
  }

  // Advisory, and deliberately not awaited: the enforcement above is what this
  // tick owes the parent, and a notification queue that is slow or refused must
  // not delay it.
  if (!blocked) {
    warnBeforeLimit(rules.screenTimeRule, now).catch(() => {});
  }

  return { blocked, packages };
}

// ── Rules change handler ───────────────────────────────────────────────────────
async function applyRules(rules) {
  _state.rules = rules;

  // App blocking. The whole set is recomputed here rather than after: a parent
  // editing bedtime, the schedule or an app rule expects it to take effect on
  // the next sync, not at the next tick.
  const { packages } = refreshBlocking();
  _state.status.appBlocking = (await AppBlocker.isAccessibilityEnabled()) && packages.length > 0;

  // Website blocking and web history.
  //
  // Both ride on the same local tunnel: it is the DNS proxy that decides what to
  // refuse *and* the only thing on the device that can see which sites were
  // visited. So it runs whenever the child has granted the VPN permission, with
  // whatever block list currently applies — an empty list still collects
  // history. Blocking and history are then reported separately, because a parent
  // with no website rules has monitoring but no filtering.
  const blockedDomains = blockedDomainsFor(rules);
  if (await VpnControl.hasPermission()) {
    await VpnControl.startVpn(blockedDomains);
    _state.status.websiteBlocking = blockedDomains.length > 0;
    _state.status.webHistory = true;
  } else {
    // The child has not accepted the VPN prompt — report both as off rather than
    // leaving a stale "on" from a previous run.
    _state.status.websiteBlocking = false;
    _state.status.webHistory = false;
  }
}

// ── Usage stats sync ──────────────────────────────────────────────────────────
async function syncUsageStats() {
  const hasPerm = await UsageStats.hasPermission();
  if (!hasPerm) return;

  const stats = await UsageStats.getUsageStats();
  let totalMinutes = 0;
  // Rebuilt rather than accumulated, so yesterday's totals cannot keep an app
  // blocked after the usage window has rolled over.
  const appMinutes = {};
  // Labels alongside the totals, so a new-app alert can name the app rather than
  // hand the parent a package name to decipher.
  const appNames = {};

  /**
   * When this phone's usage day opened — the same local midnight
   * `UsageStatsModule` measures `totalTimeInForeground` from.
   *
   * Sent as the start of every sample so the server can tell which day a sample
   * belongs to, which is a question only the device can answer. It also has to
   * be *stable*: this used to be `now - minutes`, which drifts later every time
   * the child puts the phone down, so one usage day could report starts either
   * side of a date boundary and be filed as two.
   */
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  for (const [packageName, data] of Object.entries(stats)) {
    if (data.minutes < 1) continue;
    if (isExcludedPackage(packageName)) continue;
    totalMinutes += data.minutes;
    appMinutes[packageName] = data.minutes;
    appNames[packageName] = data.appName || packageName;

    try {
      await deviceApi.logActivity({
        appPackage: packageName,
        appName: data.appName || packageName,
        category: 'app_usage',
        startTime: data.startTime || dayStart.toISOString(),
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
  _state.appMinutes = appMinutes;

  /**
   * Anything on this phone the parent has not seen before.
   *
   * The set is already in hand — this is the only place on the device that knows
   * which apps a child actually opens — so the alert costs one comparison rather
   * than the `PACKAGE_ADDED` receiver the catalogue assumed. Awaited so a failed
   * cache write cannot leave the baseline unsaved and re-announce the phone on
   * the next launch. See services/newApps.js.
   */
  try {
    await reportNewApps(Object.keys(appMinutes), appNames);
  } catch (err) {
    console.warn('[monitoring] new-app check failed:', err.message);
  }

  /**
   * Screen-time enforcement.
   *
   * Usage resets at midnight, so this has to be able to *release* the block as
   * well as apply it — the earlier version only ever called `setBlockedApps`
   * when the limit was hit, and since the native side persists the list, a
   * device blocked yesterday stayed blocked today until a rules update landed.
   */
  refreshBlocking();

  // Notify the parent once per day that the limit was reached. Only the daily
  // limit is worth an alert: bedtime and the schedule arrive at their hour every
  // day by design, and alerting on those would be noise, not news.
  if (_state.lockReason === 'daily_limit') {
    /**
     * The phone's own calendar day, not UTC's.
     *
     * `toISOString()` here meant that in Canada the "day" rolled over at 20:00
     * local — so a limit reached at 19:00 and still in force at 21:00 alerted
     * the parent twice on the same evening, which is the one evening they are
     * most likely to be looking. The usage window this guards is the device's
     * local day, so the key has to be too.
     */
    const today = dayKey(new Date());
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
      /**
       * The newest fix in the batch, and the time it was actually taken.
       *
       * Android holds background location while the phone dozes and releases
       * the whole run at once, oldest first. This read `locations[0]`, so the
       * one fix that got reported was the *stalest* one the OS had been sitting
       * on — and it arrived with no timestamp, so the server stamped it "now".
       * A phone that woke after half an hour told the parent, as a current
       * position, where the child had been when it went to sleep.
       */
      const loc = data.locations[data.locations.length - 1];
      try {
        // The server derives childId and deviceId from the device token and
        // rejects them in the body, so only the fix itself is sent.
        await locationApi.post({
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          accuracy: loc.coords.accuracy,
          speed: loc.coords.speed,
          heading: loc.coords.heading,
          recordedAt: loc.timestamp ? new Date(loc.timestamp).toISOString() : undefined,
        });
      } catch (err) {
        // Background task: the device is often mid-handover between networks.
        // Dropping one fix is fine — another follows within the minute.
        console.warn('[monitoring] location upload failed:', err.message);
      }
    });
  }

  /**
   * Half of these keys are read by one platform and ignored by the other, which
   * is the whole difficulty of background location.
   *
   * Android only: `timeInterval` (iOS schedules on its own terms) and
   * `foregroundService` (the persistent notification Android requires before it
   * will keep a background service alive).
   *
   * iOS only: `showsBackgroundLocationIndicator`, and the two below.
   *
   * `pausesUpdatesAutomatically` is the one that matters, and it defends against
   * a failure with no symptom. iOS will suspend location updates when it decides
   * the device has been stationary long enough — and it does **not** resume them
   * by itself. Left at the system default, a child's phone sitting on a desk
   * through a lesson stops reporting, the parent's map keeps showing the last
   * fix as though it were current, and nothing anywhere records that updates
   * stopped. That is the same class of bug as the stalest-fix one above, arrived
   * at from the other direction.
   *
   * `activityType: Other` goes with it: the default (`AutomotiveNavigation`)
   * tells iOS to expect a car, which makes its own pausing heuristics wrong for
   * a child walking around a school.
   */
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 60_000,      // min 1 update/min
    distanceInterval: 50,       // or every 50m
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.Other,
    foregroundService: {
      notificationTitle: 'Parentix',
      notificationBody: 'Location monitoring active',
      // colors.teal700, the app's primary. It was the old business blue, which
      // survived the teal rebrand because it is a hex in a config object rather
      // than a token read from theme.js.
      notificationColor: colors.teal700,
    },
  });

  return true;
}

// ── Background sync task ──────────────────────────────────────────────────────
if (!TaskManager.isTaskDefined(BG_TASK)) {
  TaskManager.defineTask(BG_TASK, async () => {
    try {
      await syncUsageStats();
      // Also a catch-up for any contact change signalled while the socket was
      // down — the background task is the only thing that runs when the app has
      // been swapped out.
      await syncContacts();
      // Pull the current native window and drain the queue. Background fetch is
      // the only thing running when the app has been swapped out, so this is
      // what gets a backlog to the parent.
      await collectNow();
      await uploadWebHistory();
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

  // The approved-contact list is fetched alongside the rules. It comes from the
  // cache first, so a device that starts with no network still enforces the last
  // list the parent approved rather than treating everyone as unknown.
  await startContactsSync((contacts) => {
    _state.status.contactSync = contacts.fresh;
  });

  // Web history is started before the first sync so no visit collected during
  // startup is missed, and so a queue left behind by a previous run is drained.
  await startWebHistory();

  // Re-register the push token on every start. The OS reissues it after a
  // reinstall and occasionally on its own, and a stale token on the server is
  // indistinguishable from a device that simply never receives anything.
  const push = await registerForPush();
  _state.status.pushNotifications = push.ok;

  await syncUsageStats();

  // Relay native "a blocked app was opened" events to the parent as alerts.
  _blockSub?.remove();
  _blockSub = AppBlocker.onAppBlocked?.((packageName) => {
    const rule = getRules().appRules?.find((r) => r.appPackage === packageName);
    emitEvent('alert:blocked_app', { appName: rule?.appName || packageName });
  });

  // Bedtime and the daily schedule turn over on the clock, and background fetch
  // only runs every ~15 minutes — long enough for a child to notice bedtime had
  // not started yet. A minute tick costs nothing and makes the boundary sharp
  // while the app is alive; the background task covers the rest.
  clearInterval(_lockTimer);
  _lockTimer = setInterval(refreshBlocking, LOCK_TICK_MS);

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
  stopContactsSync();
  stopWebHistory();
  // Rules sync no longer owns the socket, so close it here — monitoring
  // stopping is what actually means "this device is done talking to the server".
  disconnectSocket();
  _blockSub?.remove();
  _blockSub = null;
  clearInterval(_lockTimer);
  _lockTimer = null;
  VpnControl.stopVpn().catch(() => {});
  AppBlocker.setBlockedApps([]);
  AppBlocker.setAllowedApps([]);
  // Cleared alongside them, or the next start would compare against sets the
  // native side no longer holds and skip the push that re-applies the rules.
  _pushedBlocks = null;
  _pushedAllows = null;
  _state.locked = false;
  _state.lockReason = null;
  _state.lockTier = null;
  _state.bonusMinutes = 0;
  _state.appMinutes = {};
  _state.blockedPackages = [];
  _state.allowedPackages = [];
  // Not the warning key: it is keyed by date, and a child who restarts the app
  // after being warned at ten minutes has not earned a second warning.
  _state.status = {
    monitoring: false, appBlocking: false, websiteBlocking: false,
    locationTracking: false, contactSync: false, webHistory: false, pushNotifications: false,
  };
}
