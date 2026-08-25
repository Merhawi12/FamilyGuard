import { platform } from '../platform/index.js';
import { describeCapabilities } from '../platform/contract.js';
import { device as deviceApi } from './api.js';
import { saveLink, hasLink, onUnlinked } from './link.js';
import { startRulesSync, stopRulesSync, getRules, getSyncStatus, emitEvent } from './rules.js';
import { startContactsSync, stopContactsSync, syncContacts, getContacts } from './contacts.js';
import { startWebHistory, stopWebHistory, uploadWebHistory, ingestVisits, getWebHistoryStatus } from './webHistory.js';
import {
  startWebFilter, stopWebFilter, setBlockedDomains, flushVisits, getWebFilterStatus, repairSystemDns,
} from './webFilter.js';
import { startScreenTime, stopScreenTime, uploadUsage, getScreenTime } from './screenTime.js';
import {
  blockedAppsFor, blockedDomainsFor, allowedAppsFor, allowedAppNames, enforce, resetEnforcement,
} from './appControl.js';
import { reportNewApps } from './newApps.js';
import { connectSocket, disconnectSocket, onSocket } from './socket.js';
import { lockState, bonusMinutesFrom, minutesUntilLimit } from './schedule.js';
import { loadChildName } from './profile.js';

/**
 * The agent: everything this computer does on the parent's behalf, started once
 * and stopped once.
 *
 * It is the desktop counterpart of the mobile app's `monitoring.js`, and the
 * shape is deliberately the same — rules in, a decision, a set of things
 * enforced — because the two clients answer to one set of rules and a family
 * with a phone and a laptop must not have to hold two mental models.
 *
 * What differs is what a desktop can do about the decision, and the differences
 * are stated rather than papered over:
 *
 * | | Phone | This |
 * | --- | --- | --- |
 * | Screen time | read from the OS | measured by sampling the front window |
 * | Blocking an app | drawn over | the app is closed, and the child is told |
 * | A full lock | drawn over | a lock screen over every display |
 * | Websites | local VPN, DNS refused | local resolver, DNS refused |
 * | Location | GPS | **not reported at all** — see below |
 * | Push | Expo → FCM/APNs | **none** — the agent is always running, so the socket reaches it |
 *
 * **There is no location on a desktop, and inventing one would be worse than
 * having none.** A laptop has no GPS. The available substitutes are the Wi-Fi
 * geolocation services and the IP address, and both would put a marker on the
 * parent's map that looks exactly like a fix from their child's phone while
 * being, in the IP case, the middle of whichever city their ISP peers in. A
 * parent reading that map cannot tell the two apart. So this device reports no
 * location, and the parent's map shows what it has: their child's phone.
 */

/** Bedtime and the daily schedule turn over on the clock, not on anything we do. */
const LOCK_TICK_MS = 60 * 1000;

/** Heartbeat, the new-app check, and draining whatever the resolver has seen. */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

const _state = {
  running: false,
  linked: false,
  locked: false,
  lockReason: null,
  /**
   * What is blocked at this moment, as handed to the enforcer.
   *
   * Read by the UI rather than re-derived there. The mobile app learned that a
   * screen filtering the rules for `action === 'block'` is asking a different
   * question and gets a different answer: it counts an app whose time limit has
   * not been reached, and misses one whose limit has.
   */
  blockedApps: [],
  blockedDomains: [],
  /**
   * How much of the machine the current lock is entitled to take: `'limit'` can
   * be worked around through the allowlist, `'strict'` cannot. See schedule.js.
   */
  lockTier: null,
  /** The apps that survive a `'limit'` lock, and the labels to name them by. */
  allowedApps: [],
  allowedAppNames: [],
  /**
   * The child has dismissed a `'limit'` lock to work inside their allowlist.
   *
   * Only ever set by them, from the lock screen, and cleared by any change in the
   * lock itself — a new day, a new reason, a grant that lifts the lock — so it
   * cannot outlive the lock it was granted against. This is what turns the daily
   * limit from "the screen is taken" into "everything but the allowlist closes",
   * and nothing sets it on the child's behalf.
   */
  allowlistMode: false,
  /** Extra minutes the parent granted for today, already filtered to this day. */
  bonusMinutes: 0,
  childName: null,
  lastHeartbeatAt: null,
  screenTimeAlertedDate: null,
  /** Last "you have N minutes left" shown, as `'YYYY-MM-DD:N'` — see `warnBeforeLimit`. */
  lastLimitWarning: null,
};

let _lockTimer = null;
let _syncTimer = null;
let _unsubscribers = [];
const _listeners = new Set();

/** Subscribe to "something changed" so the window can re-render. */
export function onAgentChange(listener) {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

function publish() {
  const status = getAgentStatus();
  for (const listener of [..._listeners]) {
    try { listener(status); } catch { /* one bad subscriber must not stop the rest */ }
  }
}

export function getAgentStatus() {
  const p = platform();
  return {
    ..._state,
    platform: p.id,
    osVersion: p.osVersion(),
    capabilities: describeCapabilities(p),
    rules: getRules(),
    sync: getSyncStatus(),
    screenTime: getScreenTime(),
    webFilter: getWebFilterStatus(),
    webHistory: getWebHistoryStatus(),
    contacts: getContacts(),
  };
}

// ── The decision ──────────────────────────────────────────────────────────────

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
 * Tell the child before the screen goes, not as it goes.
 *
 * A lock screen that arrives without warning reads as a fault, and the reasonable
 * response to a computer that has apparently seized is to keep clicking at it. On
 * a desktop it is also the difference between saving the essay and not.
 *
 * Fires at most once per threshold per day. The key carries the threshold as well
 * as the date so a grant that puts the child back above ten minutes re-arms the
 * warning — otherwise the second lock of the evening would arrive silently, which
 * is the one they least expect.
 */
function warnBeforeLimit(rule, todayMinutes, now) {
  const remaining = minutesUntilLimit(rule, todayMinutes, _state.bonusMinutes);
  if (remaining === null) return;

  const threshold = LIMIT_WARNINGS.find((t) => remaining <= t);
  if (threshold === undefined) return;

  const key = `${dayKey(now)}:${threshold}`;
  if (_state.lastLimitWarning === key) return;
  _state.lastLimitWarning = key;

  platform().notify({
    // The real figure, not the threshold that matched it. The threshold decides
    // *whether* to speak; saying "5 minutes left" to a child who has four is a
    // small lie that the lock arriving early will make them notice.
    title: `${remaining} ${remaining === 1 ? 'minute' : 'minutes'} left`,
    body: threshold <= 5
      ? 'Your screen time is nearly up. Save what you are working on, or ask your parent for more.'
      : 'Nearly out of screen time for today. Ask your parent if you need more.',
    data: { type: 'screen_time_warning', minutesLeft: remaining },
  });
}

/**
 * Re-derive what should be blocked from the current rules, usage, grants and
 * clock, and push it wherever it has to go.
 *
 * This runs on a timer as well as after a sync, because bedtime, the daily
 * schedule and the expiry of a granted fifteen minutes all turn over on the clock
 * rather than on anything the agent does — and it has to be able to *release* a
 * lock as well as apply one.
 */
function refreshBlocking() {
  const rules = getRules();
  const { todayMinutes, appMinutes } = getScreenTime();
  const now = new Date();

  // Recomputed every pass rather than cached, because a grant expires on the
  // clock: a machine left running past midnight has to stop honouring yesterday's
  // extra minutes without anything else having happened.
  _state.bonusMinutes = bonusMinutesFrom(rules.screenTimeGrants, now);

  const { blocked, reason, tier } = lockState(
    rules.screenTimeRule, todayMinutes, now, rules.blocked, _state.bonusMinutes,
  );

  const wasLocked = _state.locked;
  const wasReason = _state.lockReason;
  _state.locked = blocked;
  _state.lockReason = reason;
  _state.lockTier = tier;
  _state.blockedApps = blockedAppsFor(rules, blocked, appMinutes);
  _state.allowedApps = allowedAppsFor(rules, tier);
  _state.allowedAppNames = allowedAppNames(rules, _state.allowedApps);

  /**
   * The child's dismissal dies with the lock it was given against.
   *
   * Anything else and a "let me use my homework apps" tap at six o'clock would
   * still be in force at bedtime, which is a strict lock that has no allowlist and
   * must not acquire one by inheritance. Cleared on the reason changing as well as
   * on the lock lifting, because `daily_limit` → `bedtime` is a transition where
   * the machine never unlocks in between.
   *
   * The third condition is the one that is easy to miss: the parent deleting the
   * last `allow` rule while the child is working inside it. The reason has not
   * changed and the lock has not lifted, but the list they were let through to is
   * now empty — leaving a desktop that closes everything the child opens, with no
   * lock screen to explain why. That is worse than the lock and no more
   * permissive, so it goes back to being a lock.
   */
  const strandedByAnEmptyList = _state.allowlistMode && _state.allowedApps.length === 0;
  if (!blocked || reason !== wasReason || strandedByAnEmptyList) _state.allowlistMode = false;

  const lockPayload = () => ({
    reason: _state.lockReason,
    tier: _state.lockTier,
    childName: _state.childName,
    // Named on the lock screen rather than counted, so "you can still use Word"
    // is something the child can act on instead of a promise to go and discover.
    allowedApps: _state.allowedAppNames,
  });

  if (blocked && !wasLocked) {
    platform().lockScreen.show(lockPayload());
    platform().notify({
      title: lockTitle(reason),
      body: 'Ask your parent if you need more time.',
      data: { type: 'locked', reason },
    });
  } else if (blocked && (reason !== wasReason || strandedByAnEmptyList)) {
    // Still locked, but not saying the right thing any more.
    //
    // Two cases. The reason changed under a screen that never went away — the
    // daily limit rolling into bedtime, where the copy and the allowlist both
    // move. Or the child was working inside an allowlist the parent has just
    // emptied, and the screen they dismissed has to come back rather than leave
    // them on a desktop that closes everything with nothing to explain it.
    platform().lockScreen.show(lockPayload());
  } else if (!blocked && wasLocked) {
    platform().lockScreen.hide();
  }

  if (!blocked) warnBeforeLimit(rules.screenTimeRule, todayMinutes, now);

  /**
   * Notify the parent once per day that the limit was reached.
   *
   * Only the daily limit is worth an alert: bedtime and the schedule arrive at
   * their hour every day by design, and alerting on those would be noise. The
   * key is this machine's own calendar day rather than UTC's — a limit reached
   * at 19:00 in Canada and still in force at 21:00 would otherwise alert twice
   * on the same evening, which is the one evening a parent is most likely to be
   * looking.
   */
  if (reason === 'daily_limit') {
    const today = dayKey(now);
    if (_state.screenTimeAlertedDate !== today) {
      _state.screenTimeAlertedDate = today;
      emitEvent('alert:screen_time_exceeded');
    }
  }

  if (wasLocked !== blocked || reason !== wasReason) publish();
  return {
    blocked,
    blockedApps: _state.blockedApps,
    allowedApps: _state.allowedApps,
    allowlistMode: _state.allowlistMode,
  };
}

/**
 * The child asking for the desktop back under a daily-limit lock.
 *
 * Refused for anything else, and the refusal is the important half: bedtime, an
 * out-of-hours schedule and a parent's own pause are strict, and a button that
 * lifted them would make every one of them optional. The lock screen only offers
 * this when the tier is `'limit'`, but the check lives here too — a renderer on a
 * child's own computer is not where a policy decision belongs.
 *
 * Also refused when there is nothing on the allowlist, since dismissing into an
 * empty list is a machine that closes everything the child opens, which is worse
 * than the lock screen and a great deal more confusing.
 */
export function useAllowedApps() {
  if (!_state.locked || _state.lockTier !== 'limit' || _state.allowedApps.length === 0) {
    return { ok: false, allowedApps: _state.allowedAppNames };
  }
  _state.allowlistMode = true;
  platform().lockScreen.hide();
  publish();
  return { ok: true, allowedApps: _state.allowedAppNames };
}

const lockTitle = (reason) => ({
  daily_limit: 'Time is up for today',
  bedtime: 'It is bedtime',
  outside_schedule: 'The computer is off right now',
  blocked_by_parent: 'Your parent paused this computer',
}[reason] || 'This computer is paused');

/** Rules changed: recompute the decision and re-point the resolver. */
async function applyRules(rules) {
  /**
   * The name first, because the lock screen greets the child by it.
   *
   * `refreshBlocking` only raises the lock on the transition into it, so a
   * device whose very first sync already lands inside bedtime would show an
   * unnamed lock and never get a second chance to correct it. The name arrives
   * with the rules, so it is available here — it just has to be read before the
   * decision rather than after.
   */
  _state.childName = await loadChildName();

  refreshBlocking();

  const domains = blockedDomainsFor(rules);
  _state.blockedDomains = domains;

  if (getWebFilterStatus().running) {
    setBlockedDomains(domains);
  } else {
    // Website filtering runs whenever the machine will allow it, with whatever
    // block list currently applies — an empty list still collects history, which
    // is the other half of what the resolver is for. So a parent with no website
    // rules has monitoring but no filtering, and the two are reported separately.
    await startWebFilter({ blockedDomains: domains, onVisits: (visits) => { ingestVisits(visits); } });
  }

  publish();
}

// ── Periodic work ─────────────────────────────────────────────────────────────

async function syncPass() {
  try {
    await uploadUsage();
  } catch (err) {
    console.warn('[agent] usage upload failed:', err.message);
  }

  try {
    const { appMinutes, appNames } = getScreenTime();
    // Awaited so a failed cache write cannot leave the baseline unsaved and
    // re-announce the whole machine on the next launch.
    await reportNewApps(Object.keys(appMinutes), appNames);
  } catch (err) {
    console.warn('[agent] new-app check failed:', err.message);
  }

  flushVisits();
  try {
    await uploadWebHistory();
  } catch (err) {
    console.warn('[agent] web-history upload failed:', err.message);
  }

  try {
    await deviceApi.heartbeat();
    _state.lastHeartbeatAt = new Date().toISOString();
  } catch (err) {
    // Offline. The next pass tries again; this is the ordinary case on a laptop.
    console.warn('[agent] heartbeat failed:', err.message);
  }
  publish();
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Redeem a linking code and, if it is accepted, start.
 *
 * `type` and `osVersion` are what this machine knows about itself and the
 * dashboard does not: the parent chose a device type from a screen that is not
 * in front of the computer being set up.
 */
export async function linkThisDevice(code) {
  const p = platform();
  const res = await deviceApi.confirmLink(String(code || '').trim().toUpperCase(), {
    osVersion: p.osVersion(),
    type: p.id === 'darwin' ? 'mac' : 'windows',
  });

  await saveLink({
    deviceToken: res.data.deviceToken,
    deviceId: res.data.device.id,
    childId: res.data.device.childId,
  });

  await startAgent();
  return res.data.device;
}

export async function startAgent() {
  if (_state.running) return getAgentStatus();
  if (!(await hasLink())) {
    _state.linked = false;
    return getAgentStatus();
  }
  _state.linked = true;

  // Before anything else touches the network stack: a previous run that did not
  // shut down cleanly may have left this machine pointed at a resolver that is
  // no longer listening, and that is a computer with no internet at all.
  await repairSystemDns();

  await startRulesSync(applyRules);
  await startContactsSync(() => publish());
  await startWebHistory();

  await startScreenTime({
    onTick: async (screenTime) => {
      // Re-derived every tick rather than only on a rules change: an app
      // crossing its own daily limit changes what is blocked without changing
      // anything else, which is the case the phone's first version got wrong.
      const { blocked, blockedApps, allowedApps, allowlistMode } = refreshBlocking();
      await enforce(screenTime.current, {
        blockedApps,
        allowedApps,
        locked: blocked,
        allowlistMode,
        rules: getRules(),
      });
    },
  });

  await connectSocket();
  _unsubscribers.push(onSocket('chat:message', (message) => {
    if (message?.senderRole !== 'parent') return;
    platform().notify({
      title: 'Message from your parent',
      body: message.text || '',
      data: { type: 'chat', messageId: message.id },
    });
  }));

  clearInterval(_lockTimer);
  _lockTimer = setInterval(refreshBlocking, LOCK_TICK_MS);
  _lockTimer.unref?.();

  clearInterval(_syncTimer);
  _syncTimer = setInterval(syncPass, SYNC_INTERVAL_MS);
  _syncTimer.unref?.();

  _state.running = true;
  await syncPass();
  return getAgentStatus();
}

/**
 * Stop everything, and put the machine back the way it was.
 *
 * The resolver restore is the part that matters and is why this is awaited
 * rather than fired off: quitting the agent must not leave a laptop unable to
 * resolve a name.
 */
export async function stopAgent() {
  stopRulesSync();
  stopContactsSync();
  stopWebHistory();
  await stopScreenTime();
  await stopWebFilter();

  disconnectSocket();
  _unsubscribers.forEach((off) => off());
  _unsubscribers = [];

  clearInterval(_lockTimer);
  _lockTimer = null;
  clearInterval(_syncTimer);
  _syncTimer = null;

  platform().lockScreen.hide();
  resetEnforcement();

  _state.running = false;
  _state.locked = false;
  _state.lockReason = null;
  _state.lockTier = null;
  _state.allowlistMode = false;
  _state.bonusMinutes = 0;
  _state.blockedApps = [];
  _state.allowedApps = [];
  _state.allowedAppNames = [];
  _state.blockedDomains = [];
  // Not `lastLimitWarning`: it is keyed by date, and a child who restarts the
  // agent after being warned at ten minutes has not earned a second warning.
  publish();
}

/**
 * The parent removed this device.
 *
 * Everything the agent was enforcing stops, including the resolver redirect —
 * an unlinked machine whose DNS still points at a proxy that is no longer
 * running would be a laptop with no internet and no way for the family to
 * connect the two facts.
 */
onUnlinked(() => {
  _state.linked = false;
  stopAgent().catch((err) => console.warn('[agent] stop after unlink failed:', err.message));
});

export { syncContacts, refreshBlocking };
export const __testing = { state: _state, syncPass, applyRules };
