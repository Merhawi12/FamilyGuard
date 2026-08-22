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
 * has just been locked out will try. The file is written every tick.
 */

const CACHE_KEY = 'fg_screen_time';

/** Longest gap between two samples that is still counted as continuous use. */
const MAX_CREDIT_MS = 90 * 1000;

/** Uploads are per app and cumulative, so this need not be frequent. */
const UPLOAD_INTERVAL = 5 * 60 * 1000;

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
 */
export function observe(sample, now = Date.now()) {
  rollDayIfNeeded();

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
}

async function persist() {
  if (!_persistDirty) return;
  _persistDirty = false;
  await writeJson(CACHE_KEY, {
    day: _state.day,
    seconds: _state.seconds,
    names: _state.names,
  }).catch((err) => console.warn('[screenTime] persist failed:', err.message));
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

  let uploaded = 0;
  for (const [appId, minutes] of Object.entries(appMinutes)) {
    try {
      await deviceApi.logActivity({
        appPackage: appId,
        appName: appNames[appId] || appId,
        category: 'app_usage',
        startTime: dayStart.toISOString(),
        endTime,
        durationMinutes: minutes,
      });
      uploaded += 1;
    } catch (err) {
      // One app failing must not abort the rest of the batch; the next pass
      // re-sends it, and the server upserts by (child, app, day).
      _state.lastError = err.message;
      console.warn('[screenTime] activity upload failed:', appId, err.message);
    }
  }

  if (uploaded > 0) {
    _state.lastUploadAt = new Date().toISOString();
    if (uploaded === Object.keys(appMinutes).length) _state.lastError = null;
  }
  return uploaded;
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
  _stopSampling = p.foreground.start((sample) => {
    observe(sample);
    persist();
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
  // a child loses the afternoon off their limit.
  observe(null);
  await persist();
}

export const __testing = { isExcluded, dayKeyOf, state: _state, MAX_CREDIT_MS };
