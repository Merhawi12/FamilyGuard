import { device as deviceApi } from './api.js';
import { platform } from '../platform/index.js';
import { onUnlinked } from './link.js';
import { readJson, writeJson } from './store.js';

/**
 * How long the child has spent in each application today.
 *
 * Android is handed this figure by `UsageStatsManager`. A desktop has no such
 * service, so it is measured: the platform reports which application is in front
 * on a fixed tick, and the time between two ticks is credited to whatever was in
 * front at the start of it. Everything difficult about that is a way of *not*
 * counting time the child was not there.
 *
 * **The host only ticks while somebody is using the computer.** Idle, locked,
 * asleep and screensaver all mean "stop sampling" — that judgement is the
 * platform's, because only it knows how to ask. A laptop closed at 4pm and
 * reopened at 8pm must not have charged the child four hours of Chrome.
 *
 * **A gap is not credited to anyone.** Even with an attentive host there are
 * gaps — the agent is restarted, the machine hibernates without warning, a
 * sample is late. Anything longer than `MAX_CREDIT_MS` is dropped rather than
 * attributed, because a long gap is evidence the child was absent, not evidence
 * they were busy.
 *
 * **Totals survive a restart.** The daily limit is enforced against this number.
 * If it reset when the agent restarted, closing and reopening Parentix would be
 * all it took to get the afternoon back — which is precisely what a child who
 * has just been locked out will try. See `PERSIST_INTERVAL_MS` for how often
 * that reaches disk, and why it is no longer every tick.
 */

const CACHE_KEY = 'fg_screen_time';

/** Longest gap between two samples that is still counted as continuous use. */
const MAX_CREDIT_MS = 90 * 1000;

/** Uploads are per app and cumulative, so this need not be frequent. */
const UPLOAD_INTERVAL = 5 * 60 * 1000;

/**
 * Least time between two writes of the totals to disk.
 *
 * The totals were written on **every sample**, and the sample is every five
 * seconds (`SAMPLE_MS` in the platform's foreground module). That is not a cheap
 * write: `store.js` seals the value through the OS keystore — DPAPI on Windows,
 * the login Keychain on macOS — then writes a temp file and renames it over the
 * target. Seventeen thousand of those a day, on a machine this agent is supposed
 * to be unnoticeable on, for a number that changes by five seconds each time.
 * On a low-end laptop with a spinning disk it is the single most frequent thing
 * the agent does.
 *
 * A minute is chosen against what the file is *for*, which is one specific
 * defence: a child who has just been locked out closing and reopening Parentix
 * to get the afternoon back. Against that, the exposure is what the last write
 * missed — at most a minute — and the child would have to kill the agent every
 * minute, all day, to accumulate anything worth having. They would also be
 * killing the agent, which `tamper.js` reports.
 *
 * Nothing that matters is left to the timer, and that is the other half of this:
 * `stopScreenTime` forces a write, so a clean quit reaches disk immediately
 * whenever the last tick happened to have written.
 */
const PERSIST_INTERVAL_MS = 60 * 1000;

/**
 * Never counted: this agent, and the shell the desktop itself is drawn by.
 *
 * The mobile app learned this the expensive way — its exclusion list named the
 * wrong identifier, so every minute a child spent on the screen telling them how
 * much time they had left was charged against that time, and the minutes spent
 * in the permissions screens the app itself sends them to pushed them towards a
 * lock. The identifiers here are the ones the platform modules actually report:
 * an executable name on Windows, a bundle identifier on macOS.
 */
const EXCLUDED = new Set([
  // Windows
  'parentix.exe', 'explorer.exe', 'searchhost.exe', 'shellexperiencehost.exe',
  'startmenuexperiencehost.exe', 'lockapp.exe', 'logonui.exe', 'dwm.exe',
  'applicationframehost.exe', 'textinputhost.exe',
  // macOS
  'ca.parentix.child-desktop', 'com.apple.finder', 'com.apple.dock',
  'com.apple.loginwindow', 'com.apple.systemuiserver', 'com.apple.controlcenter',
  'com.apple.notificationcenterui', 'com.apple.screensaver',
]);

const isExcluded = (appId) => {
  const id = String(appId || '').toLowerCase();
  if (!id) return true;
  if (EXCLUDED.has(id)) return true;
  // A sibling build — a rename, a beta channel — is excluded too, rather than
  // this list needing an entry per variant.
  return id.startsWith('parentix') || id.startsWith('ca.parentix.');
};

/** The device's own calendar day, which is the only day this measurement means. */
const dayKeyOf = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const _state = {
  day: dayKeyOf(),
  /** appId → seconds today. Seconds, not minutes: a tick is smaller than a minute. */
  seconds: {},
  /** appId → the label a parent should see in their rules and reports. */
  names: {},
  lastUploadAt: null,
  lastError: null,
  sampling: false,
};

let _current = null;      // the sample the current interval is being credited to
let _lastSampleAt = 0;
let _stopSampling = null;
let _uploadTimer = null;
let _persistDirty = false;
let _lastPersistAt = 0;

/** Minutes, rounded down — the unit every rule and every report is written in. */
const toMinutes = (seconds) => Math.floor((seconds || 0) / 60);

export function getScreenTime() {
  const appMinutes = {};
  let todayMinutes = 0;
  for (const [appId, seconds] of Object.entries(_state.seconds)) {
    const minutes = toMinutes(seconds);
    if (minutes < 1) continue;
    appMinutes[appId] = minutes;
    todayMinutes += minutes;
  }
  return {
    supported: platform().foreground.supported,
    day: _state.day,
    todayMinutes,
    appMinutes,
    appNames: { ..._state.names },
    lastUploadAt: _state.lastUploadAt,
    lastError: _state.lastError,
    sampling: _state.sampling,
    current: _current ? { ..._current } : null,
  };
}

/** A new child gets a new day's measurement, not the previous holder's. */
onUnlinked(() => {
  _state.seconds = {};
  _state.names = {};
  _current = null;
});

function rollDayIfNeeded() {
  const today = dayKeyOf();
  if (today === _state.day) return false;
  _state.day = today;
  _state.seconds = {};
  // Names are kept: they cost nothing and let a rule the parent wrote yesterday
  // still be shown with a label rather than an executable name.
  _persistDirty = true;
  return true;
}

/**
 * Credit the interval that has just elapsed, then take the new sample.
 *
 * @param {{appId: string, appName?: string}|null} sample  null means "nobody is using it"
 * @returns {boolean} whether the calendar day rolled over on this call — the
 *   caller has to force the totals to disk when it did, since yesterday's are
 *   now gone from memory.
 */
export function observe(sample, now = Date.now()) {
  const rolled = rollDayIfNeeded();

  if (_current && _lastSampleAt) {
    const elapsed = now - _lastSampleAt;
    // A gap longer than the ceiling is a suspend, a crash or a late tick. None
    // of them is time the child spent in front of the screen.
    if (elapsed > 0 && elapsed <= MAX_CREDIT_MS && !isExcluded(_current.appId)) {
      _state.seconds[_current.appId] = (_state.seconds[_current.appId] || 0) + elapsed / 1000;
      _persistDirty = true;
    }
  }

  if (sample?.appId && sample.appName) _state.names[sample.appId] = sample.appName;
  _current = sample?.appId ? { appId: sample.appId, appName: sample.appName || sample.appId } : null;
  _lastSampleAt = now;
  return rolled;
}

/**
 * Write the totals to disk.
 *
 * @param {{force?: boolean}} [options] `force` skips the interval — used where
 *   the write cannot wait: a clean shutdown, and the day rolling over.
 */
async function persist({ force = false } = {}) {
  if (!_persistDirty) return;
  if (!force && Date.now() - _lastPersistAt < PERSIST_INTERVAL_MS) return;

  // Cleared before the await, not after: a second call arriving while this one
  // is in flight must not start a competing write of the same file.
  _persistDirty = false;
  _lastPersistAt = Date.now();
  await writeJson(CACHE_KEY, {
    day: _state.day,
    seconds: _state.seconds,
    names: _state.names,
  }).catch((err) => {
    // Put the flag back: the totals on disk are still the old ones, so the next
    // tick has to try again rather than assume this one landed.
    _persistDirty = true;
    console.warn('[screenTime] persist failed:', err.message);
  });
}

/**
 * Upload today's totals.
 *
 * One row per (app, day) on the server, upserted with `max()`, so re-sending a
 * cumulative total is the intended shape and a missed upload costs nothing. The
 * start time sent is this machine's local midnight — which day a sample belongs
 * to is a question only the device can answer, and it has to be *stable*, or one
 * usage day reports starts either side of a date boundary and is filed as two.
 */
export async function uploadUsage() {
  const { appMinutes, appNames } = getScreenTime();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const endTime = new Date().toISOString();

  const samples = Object.entries(appMinutes).map(([appId, minutes]) => ({
    appPackage: appId,
    appName: appNames[appId] || appId,
    category: 'app_usage',
    startTime: dayStart.toISOString(),
    endTime,
    durationMinutes: minutes,
  }));

  if (samples.length === 0) return 0;

  /**
   * One request for the whole list, not one per app.
   *
   * This looped and awaited per app, so a laptop that had been open all day
   * spent dozens of sequential round trips on every upload pass to send what is
   * one small object. The retry story is unchanged and is why batching is safe
   * here: the totals are cumulative and the server upserts by (child, app, day),
   * so a failed pass costs nothing but the wait until the next one.
   */
  try {
    await deviceApi.logActivityBatch(samples);
  } catch (err) {
    _state.lastError = err.message;
    console.warn('[screenTime] activity upload failed:', err.message);
    return 0;
  }

  _state.lastUploadAt = new Date().toISOString();
  _state.lastError = null;
  return samples.length;
}

/**
 * Begin measuring.
 *
 * `onTick` runs after every sample so the agent can re-evaluate what should be
 * blocked: an app crossing its own daily limit changes the answer without
 * anything else having happened.
 */
export async function startScreenTime({ onTick } = {}) {
  const cached = await readJson(CACHE_KEY, null);
  // Only today's cache is restored. Yesterday's totals would keep an app blocked
  // through a limit it has not spent.
  if (cached?.day === dayKeyOf()) {
    _state.day = cached.day;
    _state.seconds = cached.seconds || {};
    _state.names = { ..._state.names, ...(cached.names || {}) };
  } else if (cached?.names) {
    _state.names = { ..._state.names, ...cached.names };
  }

  const p = platform();
  if (!p.foreground.supported) {
    _state.sampling = false;
    return getScreenTime();
  }

  _stopSampling?.();
  _lastSampleAt = 0;
  _current = null;
  // The first tick after a start writes immediately rather than waiting out an
  // interval it did not spend running.
  _lastPersistAt = 0;
  _stopSampling = p.foreground.start((sample) => {
    // `observe` answers true when the calendar day rolled over on this tick, and
    // that one write is not deferred. Correctness does not depend on it — the
    // file still carries *yesterday's* `day` until it is rewritten, and the
    // restore above rejects a cache whose day is not today, so a crash inside
    // the deferral window loses nothing and resurrects nothing. It is forced
    // because it costs one write a day to keep the file and memory in step
    // across the one moment they diverge completely, which is worth more than
    // the write.
    const rolled = observe(sample);
    persist({ force: rolled });
    try { onTick?.(getScreenTime()); } catch (err) {
      console.warn('[screenTime] tick handler failed:', err.message);
    }
  });
  _state.sampling = true;

  clearInterval(_uploadTimer);
  _uploadTimer = setInterval(() => { uploadUsage(); }, UPLOAD_INTERVAL);
  _uploadTimer.unref?.();

  return getScreenTime();
}

export async function stopScreenTime() {
  _stopSampling?.();
  _stopSampling = null;
  _state.sampling = false;
  clearInterval(_uploadTimer);
  _uploadTimer = null;
  // The interval up to this moment still belongs to whatever was in front, and
  // the totals still have to reach disk — a clean shutdown must not be the way
  // a child loses the afternoon off their limit. Forced past the write interval
  // for exactly that reason: there is no next tick to defer to.
  observe(null);
  await persist({ force: true });
}

export const __testing = { isExcluded, dayKeyOf, state: _state, MAX_CREDIT_MS };
