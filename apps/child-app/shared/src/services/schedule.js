/**
 * When the parent's screen-time rule says the device should be locked, and how
 * much of the device the lock is entitled to take.
 *
 * Four separate things can each demand a lock, and the parent sets three of them
 * on the same screen:
 *
 *   - `dailyLimitMinutes` — the total for the day has been used up
 *   - `bedtimeStart`/`bedtimeEnd` — the nightly window, which normally wraps past
 *     midnight
 *   - `schedule[day]` — the hours the device is allowed to be used at all
 *   - the parent's own pause on this one device, which outranks all three
 *
 * **They are not the same lock, and treating them as one was the mistake this
 * file used to make.** Every reason produced a single `'*'` wildcard that blocked
 * every app on the phone, so a child who spent ninety minutes on YouTube lost the
 * dialer along with it. A product a family installs to make a child *safer* must
 * not be the reason that child cannot ring anyone at seven in the evening.
 *
 * So a lock now carries a tier, and the tier is what the enforcement layers read:
 *
 *   - `'limit'` — the entertainment budget is spent. The parent's allowlist
 *     applies: apps they marked `allow` stay open, because homework does not stop
 *     when YouTube does.
 *   - `'strict'` — bedtime, out-of-hours, or a deliberate pause. Nothing but the
 *     safety exception. These exist to stop use rather than to ration it, and an
 *     allowlist would quietly gut all three.
 *
 * The safety exception — the dialer, messaging, contacts, the clock — is in
 * neither tier and in no rule. It lives in the accessibility service itself so it
 * holds even when this layer is not running at all. See AppMonitorService.kt.
 *
 * Kept pure and separate from `monitoring.js` so the wrap-around, day-boundary
 * and grant-expiry cases can be tested directly, without a device or a clock stub.
 */

/** `'HH:MM'` → minutes since midnight, or null when it is not a valid time. */
export function parseTimeOfDay(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const minutesInto = (date) => date.getHours() * 60 + date.getMinutes();

/**
 * Whether `minute` falls inside a window that may wrap past midnight.
 *
 * 21:00→07:00 is the ordinary bedtime shape and covers two calendar days, so a
 * plain `start <= x < end` comparison would treat the whole night as outside it.
 */
export function withinWindow(minute, start, end) {
  if (start === null || end === null) return false;
  if (start === end) return false; // a zero-length window blocks nothing
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

/** Which reasons the parent's allowlist survives. Everything else is strict. */
const LIMIT_TIER_REASONS = new Set(['daily_limit']);

/** The tier a reason locks at. Exported so nothing has to re-derive it. */
export const tierFor = (reason) => (LIMIT_TIER_REASONS.has(reason) ? 'limit' : 'strict');

/**
 * The extra minutes a parent granted that are still worth anything.
 *
 * A grant is `{ minutes, grantedAt }` and expires with the day it was given — so
 * "today" has to be decided here, on the device, against this phone's own
 * midnight. The server deliberately does not decide it: Cloud Run runs in UTC and
 * the families are in Canada, so a server-side "today" rolls over at 20:00 local
 * and would take back minutes a parent granted during the evening they were asked
 * for. That is the same UTC-rollover bug that made every evening's screen time
 * double-count, arrived at from the other side.
 *
 * A grant stamped in the future is ignored rather than trusted: a phone whose
 * clock is behind would otherwise carry a grant across days for ever.
 */
export function bonusMinutesFrom(grants, now = new Date()) {
  if (!Array.isArray(grants) || grants.length === 0) return 0;

  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const from = midnight.getTime();
  const until = now.getTime();

  let total = 0;
  for (const grant of grants) {
    const minutes = Number(grant?.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    const at = new Date(grant?.grantedAt ?? NaN).getTime();
    if (Number.isNaN(at) || at < from || at > until) continue;
    total += minutes;
  }
  return total;
}

/**
 * How long until the daily limit is reached, or null when nothing is counting
 * down — no limit set, the rule switched off, or the limit already spent.
 *
 * Split out so the warning that arrives before a lock and the lock itself read
 * one number. A child being told "ten minutes left" and then locked eight minutes
 * later is worse than not warning them at all.
 */
export function minutesUntilLimit(rule, todayMinutes, bonusMinutes = 0) {
  if (!rule || rule.isActive === false) return null;
  const limit = rule.dailyLimitMinutes;
  if (!limit) return null;
  const remaining = (limit + (bonusMinutes || 0)) - todayMinutes;
  return remaining > 0 ? remaining : null;
}

/**
 * Should everything be blocked right now?
 *
 * @param {object|null} rule       the child's ScreenTimeRule, as the API returns it
 * @param {number} todayMinutes    usage recorded so far today
 * @param {Date} [now]
 * @param {object|null} [blocked]  the parent's pause on this device: `{ since, reason }`
 * @param {number} [bonusMinutes]  extra minutes granted for today — see `bonusMinutesFrom`
 * @returns {{ blocked: boolean, reason: string|null, tier: 'limit'|'strict'|null }}
 */
export function lockState(rule, todayMinutes, now = new Date(), blocked = null, bonusMinutes = 0) {
  /**
   * The parent's own pause, which outranks every scheduled reason.
   *
   * Checked before the rule is even looked at, because a device can be blocked
   * while its child has no screen-time rule at all — `lockState` would otherwise
   * return on the first line and the block would do nothing. It also has to beat
   * `isActive === false`: switching the schedule off is how a parent lifts a
   * bedtime, and it must not be how a child lifts a block.
   *
   * `blocked` is whatever the sync put there: `{ since, reason }` or null. It is
   * read for its presence, not its shape, so an older agent talking to a newer
   * server locks correctly even if the payload grows fields it has never seen.
   *
   * Always strict, whatever reason it carries. A parent reaching for the pause
   * button has decided something, and an allowlist they set up months ago for
   * homework must not decide it differently.
   */
  if (blocked) {
    return { blocked: true, reason: blocked.reason || 'blocked_by_parent', tier: 'strict' };
  }

  if (!rule || rule.isActive === false) return { blocked: false, reason: null, tier: null };

  /**
   * Granted minutes raise the bar rather than being spent first.
   *
   * The alternative — subtracting them from `todayMinutes` — reads the same until
   * the day rolls over, and then a grant made at 22:00 goes on paying for the
   * following morning. Adding to the limit keeps the grant attached to the day it
   * belongs to, which is the day `bonusMinutesFrom` already decided.
   */
  const limit = rule.dailyLimitMinutes;
  if (limit && todayMinutes >= limit + (bonusMinutes || 0)) {
    return { blocked: true, reason: 'daily_limit', tier: 'limit' };
  }

  if (rule.bedtimeEnabled) {
    const start = parseTimeOfDay(rule.bedtimeStart);
    const end = parseTimeOfDay(rule.bedtimeEnd);
    if (withinWindow(minutesInto(now), start, end)) {
      return { blocked: true, reason: 'bedtime', tier: 'strict' };
    }
  }

  // `schedule` arrives parsed from the API's JSON getter, but a device that has
  // never synced can hold the raw string, so accept both.
  let schedule = rule.schedule;
  if (typeof schedule === 'string') {
    try { schedule = JSON.parse(schedule); } catch { schedule = null; }
  }

  const today = schedule?.[DAY_KEYS[now.getDay()]];
  // An unchecked day carries no restriction — only an enabled one defines the
  // hours the device may be used, and anything outside them is a lock.
  if (today?.enabled) {
    const start = parseTimeOfDay(today.start);
    const end = parseTimeOfDay(today.end);
    if (start !== null && end !== null && !withinWindow(minutesInto(now), start, end)) {
      return { blocked: true, reason: 'outside_schedule', tier: 'strict' };
    }
  }

  return { blocked: false, reason: null, tier: null };
}
