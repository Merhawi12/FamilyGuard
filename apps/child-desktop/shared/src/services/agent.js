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
import { blockedAppsFor, blockedDomainsFor, enforce, resetEnforcement } from './appControl.js';
import { reportNewApps } from './newApps.js';
import { connectSocket, disconnectSocket, onSocket } from './socket.js';
import { lockState } from './schedule.js';
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
  childName: null,
  lastHeartbeatAt: null,
  screenTimeAlertedDate: null,
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
 * Re-derive what should be blocked from the current rules, usage and clock, and
 * push it wherever it has to go.
 *
 * This runs on a timer as well as after a sync, because bedtime and the daily
 * schedule turn on and off with the clock rather than with anything the agent
 * does — and it has to be able to *release* a lock as well as apply one.
 */
function refreshBlocking() {
  const rules = getRules();
  const { todayMinutes, appMinutes } = getScreenTime();
  const { blocked, reason } = lockState(rules.screenTimeRule, todayMinutes, new Date(), rules.blocked);

  const wasLocked = _state.locked;
  _state.locked = blocked;
  _state.lockReason = reason;
  _state.blockedApps = blockedAppsFor(rules, blocked, appMinutes);

  if (blocked && !wasLocked) {
    platform().lockScreen.show({ reason, childName: _state.childName });
    platform().notify({
      title: lockTitle(reason),
      body: 'Ask your parent if you need more time.',
      data: { type: 'locked', reason },
    });
  } else if (!blocked && wasLocked) {
    platform().lockScreen.hide();
  }

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
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (_state.screenTimeAlertedDate !== today) {
      _state.screenTimeAlertedDate = today;
      emitEvent('alert:screen_time_exceeded');
    }
  }

  if (wasLocked !== blocked) publish();
  return { blocked, blockedApps: _state.blockedApps };
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
      const { blocked, blockedApps } = refreshBlocking();
      await enforce(screenTime.current, {
        blockedApps,
        locked: blocked,
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
  _state.blockedApps = [];
  _state.blockedDomains = [];
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
