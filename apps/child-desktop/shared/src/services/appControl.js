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
 *
 * The daily limit is the one lock that can be porous, and on a desktop it is
 * porous only when the child says so. A `'limit'` lock with an allowlist behind
 * it still raises the lock screen — the essay is still safe — but the screen now
 * offers a way through to the apps the parent left open. Taking it is what puts
 * this file into `allowlistMode`, and only then does anything get closed. The
 * child chose that, having been told on the button that everything else would
 * close; nothing does it to them while they are away from the machine.
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

/**
 * The apps that stay open when the daily limit runs out.
 *
 * Only for the `'limit'` tier — bedtime, an out-of-hours schedule and a parent's
 * own pause hand back an empty list. A `block` rule beats an `allow` rule on the
 * same app whichever order the rows arrive in: the two together are a parent who
 * blocked something and later added it to the homework list, and the safe reading
 * of that contradiction is the restrictive one.
 *
 * Character-for-character the phone's `allowedPackagesFor`, for the same reason
 * `schedule.js` is a copy of the phone's: one set of rules must not have two
 * interpretations.
 */
export function allowedAppsFor(rules, tier) {
  if (tier !== 'limit') return [];

  const blocked = new Set(
    (rules?.appRules || [])
      .filter((r) => r.action === 'block' && r.appPackage)
      .map((r) => r.appPackage.toLowerCase()),
  );

  const allowed = new Set();
  for (const rule of rules?.appRules || []) {
    if (rule.action !== 'allow' || !rule.appPackage) continue;
    const appId = rule.appPackage.toLowerCase();
    if (blocked.has(appId)) continue;
    allowed.add(appId);
  }
  return [...allowed];
}

/** The labels for those apps, so the lock screen can name what is still open. */
export function allowedAppNames(rules, allowedApps) {
  return allowedApps.map((appId) => {
    const rule = (rules?.appRules || [])
      .find((r) => String(r.appPackage || '').toLowerCase() === appId);
    return rule?.appName || appId;
  });
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
 * @param {object} context
 * @param {string[]} context.blockedApps
 * @param {string[]} [context.allowedApps]   survives a `'limit'` lock
 * @param {boolean} context.locked
 * @param {boolean} [context.allowlistMode]  the child chose to work past a limit lock
 * @param {object} context.rules
 */
export async function enforce(sample, {
  blockedApps, allowedApps = [], locked, allowlistMode = false, rules,
}) {
  if (!sample?.appId) return { action: 'none' };

  const appId = sample.appId.toLowerCase();

  if (locked) {
    /**
     * The lock screen has the display, so there is nothing to close — and
     * closing every application the child brings forward during bedtime would be
     * a way to lose an evening's homework.
     *
     * The exception is a child who has dismissed a `daily_limit` lock into their
     * allowlist. They asked for the desktop back on those terms and were told
     * what it costs, so from here the limit behaves like an ordinary block on
     * everything that is not on the list.
     */
    if (!allowlistMode) return { action: 'locked' };
    if (allowedApps.includes(appId)) return { action: 'allowed' };
  } else if (!blockedApps.includes(appId)) {
    return { action: 'none' };
  }

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

  /**
   * Three reasons an app can close, and they must not be described as one.
   *
   * The third is new and is the one that would have been wrong by default: an
   * app closed because the child is working inside their allowlist has no rule of
   * its own, so it would have taken the "your parent has paused this" wording —
   * telling a child their parent singled out the game they just opened, when what
   * actually happened is that the day's time ran out.
   */
  p.notify({
    title: `${label} is paused`,
    body: locked
      ? `Your screen time is used up. ${label} is closed until tomorrow — the apps your parent left open still work.`
      : rule?.action === 'limit'
        ? `You have used all your time on ${label} today.`
        : `Your parent has paused ${label} on this computer.`,
    data: { type: locked ? 'screen_time_blocked' : 'app_blocked', appPackage: sample.appId },
  });

  // The parent hears about it, but not once a minute. A child re-opening a
  // blocked app is one piece of news, however many times they try.
  //
  // Not while the limit is what is closing things: the parent has already been
  // told the limit was reached, once, and a child working through their allowlist
  // will brush against a dozen other apps in an evening. That would be a stream
  // of "tried to open a blocked app" alerts describing nothing the parent did not
  // already know, which is how an alert feed stops being read.
  if (!locked && now - (_lastAlert.get(appId) || 0) > REPEAT_ALERT_MS) {
    _lastAlert.set(appId, now);
    emitEvent('alert:blocked_app', { appName: label });
  }

  return { action: locked ? 'limit_blocked' : 'blocked', appId: sample.appId, appName: label, closed };
}

/** Test seam, and what `stopAgent` calls so a new link starts with no history. */
export function resetEnforcement() {
  _lastAction.clear();
  _lastAlert.clear();
}
