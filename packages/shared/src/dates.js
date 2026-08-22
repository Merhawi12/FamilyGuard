/**
 * Time formatting for both web apps: calendar-day keys, elapsed time, and
 * durations.
 *
 * Calendar-day helpers, written against the day the *family* is living in.
 *
 * `toISOString().split('T')[0]` looks like "the date" and is not: it is the date
 * in UTC. Parentix runs on Cloud Run, which is UTC, and its families are in
 * Canada — so from about 20:00 local every evening the two disagree, and every
 * screen keyed off the wrong one quietly moves a day ahead of the data.
 *
 * That is not hypothetical. The dashboard's "Screen time — Today" tile looked up
 * tomorrow's bucket and reported 0 for the whole evening, and the week's bar
 * chart drew each day's total under the previous day's label. The Reports screen
 * opened its date picker on tomorrow and said "Nothing recorded that day".
 *
 * The server files a usage sample under the calendar day of the local midnight
 * the device reported (see `usageDayWindow` in deviceController.js), so the key
 * a client must ask for is the local one. These two functions are the only way
 * this codebase should build one.
 */

const pad = (n) => String(n).padStart(2, '0');

/** A `Date` → `YYYY-MM-DD` in the viewer's own timezone. */
export const localDateKey = (date = new Date()) => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * The last `count` local dates ending today, oldest first, as
 * `{ key, date }` — `key` for looking a day up, `date` for labelling it.
 *
 * Built by stepping a local calendar date rather than subtracting 24h at a time,
 * so a daylight-saving change does not skip or repeat a day.
 */
export const lastLocalDays = (count, today = new Date()) => {
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    out.push({ key: localDateKey(d), date: d });
  }
  return out;
};

/* ── Elapsed time and durations ──────────────────────────────────────────── */

/**
 * "how long ago", in the two registers the apps actually need.
 *
 * There were four of these — `timeAgo` in the console's Devices and Overview
 * screens, `timeAgo` in the Family App's notification bell, and `when` in its
 * active-sessions list. All four did the same arithmetic and disagreed about the
 * wording, so the console said "2 hrs ago" on one screen and "2 hours ago" on
 * the next. The two axes they genuinely differed on are the two options here;
 * everything else was drift.
 *
 * `absent` is what an empty or unparseable timestamp reads as, and it has to be
 * the caller's word: "never" is right for a device that has not checked in,
 * "Unknown" for a session with no recorded activity, and an empty string for a
 * column that should simply stay blank. Defaulting it to something cheerful
 * would put a wrong fact on the screen.
 *
 * `compact` is for a narrow column — the phone-width bell panel and the session
 * list. It shortens the units and, past a day, gives the date instead of a
 * running count, because "37 days ago" is a worse answer than the day itself
 * once the number stops being something you can picture.
 *
 * @param {string|number|Date} value
 * @param {{ absent?: string, compact?: boolean }} [options]
 */
export const timeAgo = (value, { absent = '', compact = false } = {}) => {
  const then = new Date(value ?? NaN).getTime();
  if (Number.isNaN(then)) return absent;

  // Clamped at zero: a device whose clock runs fast can report a "last seen"
  // slightly in the future, and "-1 min ago" is never the right thing to print.
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return compact ? `${minutes}m ago` : `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return compact ? `${hours}h ago` : `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;

  if (compact) return new Date(then).toLocaleDateString();
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
};

/**
 * A count of minutes as `2h 5m`, or `45m` under the hour.
 *
 * Rounded to the minute *before* being split, which the two copies this replaces
 * were not: they took `Math.floor(total / 60)` and `Math.round(total % 60)`
 * independently, so 119.7 minutes rendered as "1h 60m".
 */
export const formatMinutes = (total) => {
  const minutes = Math.max(0, Math.round(Number(total) || 0));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
};
