/**
 * When the parent's screen-time rule says the device should be locked.
 *
 * Three separate things in `ScreenTimeRule` can each demand a full lock, and the
 * parent sets all of them on the same screen:
 *
 *   - `dailyLimitMinutes` — the total for the day has been used up
 *   - `bedtimeStart`/`bedtimeEnd` — the nightly window, which normally wraps past
 *     midnight
 *   - `schedule[day]` — the hours the device is allowed to be used at all
 *
 * Kept pure and separate from `monitoring.js` so the wrap-around and
 * day-boundary cases can be tested directly, without a device or a clock stub.
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

/**
 * Should everything be blocked right now?
 *
 * @param {object|null} rule       the child's ScreenTimeRule, as the API returns it
 * @param {number} todayMinutes    usage recorded so far today
 * @param {Date} [now]
 * @returns {{ blocked: boolean, reason: 'daily_limit'|'bedtime'|'outside_schedule'|null }}
 */
export function lockState(rule, todayMinutes, now = new Date(), blocked = null) {
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
   */
  if (blocked) return { blocked: true, reason: blocked.reason || 'blocked_by_parent' };

  if (!rule || rule.isActive === false) return { blocked: false, reason: null };

  const limit = rule.dailyLimitMinutes;
  if (limit && todayMinutes >= limit) return { blocked: true, reason: 'daily_limit' };

  if (rule.bedtimeEnabled) {
    const start = parseTimeOfDay(rule.bedtimeStart);
    const end = parseTimeOfDay(rule.bedtimeEnd);
    if (withinWindow(minutesInto(now), start, end)) return { blocked: true, reason: 'bedtime' };
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
      return { blocked: true, reason: 'outside_schedule' };
    }
  }

  return { blocked: false, reason: null };
}
