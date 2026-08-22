import { platform } from '../platform/index.js';
import { emitEvent } from './rules.js';

/**
 * Deciding what is paused, and doing something about it when the child opens it
 * anyway.
 *
 * The decision half is a port of the mobile app's, because it has to be: a
 * parent who blocks an app expects the same answer on the laptop as on the
 * phone, and "the daily limit is spent" has to mean the same thing in both
 * places. Three things drive it — an outright block rule, a per-app daily limit
 * that has been used up, and a full lock, which blocks everything with the `*`
 * wildcard.
 *
 * The enforcement half cannot be a port, because Android draws over the app and
 * a desktop has no equivalent. What a desktop can do is close it. That is
 * blunter, so two things soften it:
 *
 * - **The child is told, every time.** An application that vanishes with no
 *   explanation reads as a crash, and a child who thinks the laptop is broken
 *   tells nobody. The notification names the app and says who paused it.
 * - **A full lock does not close anything.** Bedtime arriving mid-essay must not
 *   be the thing that loses the essay. A lock raises the lock screen over the
 *   desktop; the work underneath is still there in the morning.
 */

/** Least time between two enforcement passes on the same app. */
const REPEAT_ACTION_MS = 15 * 1000;

/** Least time between two `blocked_app_attempt` alerts about the same app. */
const REPEAT_ALERT_MS = 10 * 60 * 1000;

const _lastAction = new Map();
const _lastAlert = new Map();

/**
 * The apps this device should block right now.
 *
 * A rule with no `appPackage` is dropped because there is nothing to match it
 * against; the API refuses to create one now, but a device can still be holding
 * a cached rule from before that.
 */
export function blockedAppsFor(rules, locked, appMinutes = {}) {
  if (locked) return ['*'];

  const blocked = new Set();
  for (const rule of rules?.appRules || []) {
    if (!rule.appPackage) continue;

    if (rule.action === 'block') {
      blocked.add(rule.appPackage.toLowerCase());
      continue;
    }

    // A `limit` rule blocks its own app once that app's total for the day
    // reaches the limit, and releases it when the count resets at midnight.
    if (rule.action === 'limit' && rule.dailyLimitMinutes > 0) {
      const used = appMinutes[rule.appPackage] ?? appMinutes[rule.appPackage.toLowerCase()] ?? 0;
      if (used >= rule.dailyLimitMinutes) blocked.add(rule.appPackage.toLowerCase());
    }
  }
  return [...blocked];
}

/** Blocked domains from the parent's website rules. The column is `url`. */
export function blockedDomainsFor(rules) {
  return (rules?.websiteRules || [])
    .filter((r) => r.action === 'block')
    .map((r) => r.url)
    .filter(Boolean);
}

/**
 * Act on a foreground sample.
 *
 * Returns what was done, so the agent can report it and the harness can assert
 * on it rather than on a side effect.
 *
 * @param {{appId: string, appName?: string}|null} sample
 * @param {{blockedApps: string[], locked: boolean, rules: object}} context
 */
export async function enforce(sample, { blockedApps, locked, rules }) {
  if (!sample?.appId) return { action: 'none' };

  // A lock is handled by the lock screen. Closing every application the child
  // brings forward during bedtime would be a way to lose an evening's homework.
  if (locked) return { action: 'locked' };

  const appId = sample.appId.toLowerCase();
  if (!blockedApps.includes(appId)) return { action: 'none' };

  const now = Date.now();
  if (now - (_lastAction.get(appId) || 0) < REPEAT_ACTION_MS) return { action: 'throttled' };
  _lastAction.set(appId, now);

  const p = platform();
  const rule = (rules?.appRules || []).find(
    (r) => String(r.appPackage || '').toLowerCase() === appId,
  );
  const label = rule?.appName || sample.appName || sample.appId;

  let closed = 0;
  if (p.apps.supported) {
    try {
      closed = await p.apps.close(sample.appId);
    } catch (err) {
      console.warn('[appControl] could not close', sample.appId, err.message);
    }
  }

  p.notify({
    title: `${label} is paused`,
    body: rule?.action === 'limit'
      ? `You have used all your time on ${label} today.`
      : `Your parent has paused ${label} on this computer.`,
    data: { type: 'app_blocked', appPackage: sample.appId },
  });

  // The parent hears about it, but not once a minute. A child re-opening a
  // blocked app is one piece of news, however many times they try.
  if (now - (_lastAlert.get(appId) || 0) > REPEAT_ALERT_MS) {
    _lastAlert.set(appId, now);
    emitEvent('alert:blocked_app', { appName: label });
  }

  return { action: 'blocked', appId: sample.appId, appName: label, closed };
}

/** Test seam, and what `stopAgent` calls so a new link starts with no history. */
export function resetEnforcement() {
  _lastAction.clear();
  _lastAlert.clear();
}
