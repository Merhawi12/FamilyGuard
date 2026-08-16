/**
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
