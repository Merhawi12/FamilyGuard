import { platform } from '../platform/index.js';
import { emitEvent } from './rules.js';
import { readJson, writeJson } from './store.js';
import { getWebFilterStatus } from './webFilter.js';

/**
 * Noticing when the controls stop being in force, and telling the parent.
 *
 * ── What this is, and what it is honestly not ────────────────────────────────
 *
 * It is not anti-tamper. A child with an administrator password on their own
 * Windows account can end this process, and no amount of code in the process
 * being ended changes that. Claiming otherwise would be the worst outcome
 * available here: a parent who believes the laptop is covered, checking a
 * dashboard that agrees with them, while it is not.
 *
 * What is achievable is that **circumvention is not silent**. Every way of
 * getting around the agent leaves the same footprint — the controls stop being
 * applied — and the parent gets told. That converts a technical arms race, which
 * the product loses, into a conversation between a parent and their child, which
 * is the thing that actually works. It is the same judgement the lock screen
 * makes: a deterrent that is unmissable rather than a cage that is not real.
 *
 * ── The three things watched ─────────────────────────────────────────────────
 *
 * **1. A run that ended without shutting down.** The resolver backup on disk is
 * only there while the filter is live; a clean quit removes it. Finding one at
 * startup means the last run was killed. Note the wording of the alert — a power
 * cut, a battery running out and a forced restart all land here too, and telling
 * a parent their child killed the agent when the truth was a flat battery is a
 * false accusation the product should not make.
 *
 * **2. The resolver drifting back.** An elevated child can put DNS back to
 * automatic in Settings in about fifteen seconds, and the agent would go on
 * reporting website blocking as On while every lookup went round it. Checked
 * on a timer, re-applied, and reported.
 *
 * **3. Start-at-sign-in being switched off.** msconfig, Task Manager's Startup
 * tab, or deleting the scheduled task. Re-enabled where the platform allows it —
 * which for the login item is always, and for the elevated scheduled task is
 * never from an unelevated process, so that half is reported rather than fixed.
 *
 * ── Why it does not just alert every time ────────────────────────────────────
 *
 * A laptop that is genuinely broken — a VPN client that re-writes DNS on every
 * connect, a corporate profile that fights back — would otherwise produce an
 * alert every two minutes, and a parent who gets forty of those learns to
 * ignore the forty-first. One alert per kind per cooling-off window, and the
 * state is on disk so a restart is not a way to reset it.
 */

/** How often to look. Two minutes: long enough to be free, short enough to matter. */
const CHECK_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Don't re-report the same kind of problem inside six hours.
 *
 * Long, on purpose. The second alert about the same thing carries almost no
 * information the first did not, and the cost of over-alerting is that alerts
 * stop being read.
 */
const REPEAT_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Give a freshly started agent time to apply things before checking whether they
 * are applied. Without it the first check races `startWebFilter` and reports the
 * agent's own startup as tampering.
 */
const GRACE_MS = 90 * 1000;

const STATE_KEY = 'fg_tamper_state';

const KINDS = {
  /** The last run was killed rather than quitting. */
  UNEXPECTED_STOP: 'unexpected_stop',
  /** The machine's resolver is no longer pointed at us. */
  FILTER_BYPASSED: 'filter_bypassed',
  /** Parentix will not start with Windows any more. */
  AUTOSTART_REMOVED: 'autostart_removed',
  /**
   * The account at the keyboard is a local administrator.
   *
   * Not tampering — a standing weakness. Everything else in this file is a
   * fight the product can at least make noisy; this is the one condition under
   * which it cannot even do that, because an administrator can undo any of it.
   * The only fix is one the parent has to make, so the parent is who is told.
   */
  ADMIN_USER: 'admin_user',
};

const MESSAGES = {
  [KINDS.UNEXPECTED_STOP]:
    'Parentix on this computer stopped without shutting down properly. It has restarted and protection is active again.',
  [KINDS.FILTER_BYPASSED]:
    "This computer's network settings were changed so website filtering was bypassed. Parentix has put them back.",
  [KINDS.AUTOSTART_REMOVED]:
    'Parentix was set not to start when this computer is switched on.',
  [KINDS.ADMIN_USER]:
    'The account signed in to this computer is a Windows administrator, so Parentix cannot stop it being '
    + 'switched off, changed, or uninstalled. To keep protection in force, ask an adult to sign the child in '
    + 'to a standard (non-administrator) Windows account.',
};

/**
 * A standing condition, unlike the others, so it is re-stated at most once a day
 * rather than sharing the six-hour window. Long enough not to nag, short enough
 * that a parent who fixes it sees the alert stop and one who does not is reminded.
 */
const ADMIN_REPEAT_AFTER_MS = 24 * 60 * 60 * 1000;

let _timer = null;
let _startedAt = 0;
/** Last *delivered* report per kind, `{ [kind]: epoch ms }`, mirrored to disk. */
let _reported = {};
/** Raised but not yet delivered, `{ [kind]: payload }`. See `flush`. */
let _pending = {};

/**
 * Hand everything raised so far to the socket, and keep what would not go.
 *
 * The reason this is a queue rather than a call: `emitSocket` drops an event
 * when the socket is not connected and says so by returning false — and the
 * single most important alert in this file is raised at startup, *before*
 * `connectSocket()` has run. Emitting straight from `report` would have meant
 * that "the agent was killed and has restarted" — the one event that is by
 * definition preceded by the process not running — was the one event most
 * likely to be thrown away.
 *
 * A kind is only marked as reported once it has actually left the machine, so
 * the cooling-off window measures time since the parent could have seen it, not
 * time since we tried.
 */
async function flush() {
  const kinds = Object.keys(_pending);
  if (kinds.length === 0) return;

  let delivered = false;
  for (const kind of kinds) {
    if (!emitEvent('alert:tamper', _pending[kind])) continue;
    _reported = { ..._reported, [kind]: Date.now() };
    delete _pending[kind];
    delivered = true;
  }
  if (delivered) await writeJson(STATE_KEY, _reported).catch(() => {});
}

/**
 * Raise one, subject to the cooling-off window, and try to send it now.
 *
 * Re-raising a kind that is already queued overwrites its payload rather than
 * adding a second copy: the parent needs to know the filter was bypassed, not
 * how many times the check loop noticed while the laptop was offline.
 */
async function report(kind, extra = {}, repeatAfter = REPEAT_AFTER_MS) {
  const last = _reported[kind] || 0;
  if (Date.now() - last < repeatAfter) return false;

  _pending[kind] = { kind, message: MESSAGES[kind], ...extra };
  await flush();
  return true;
}

/**
 * Called once at startup, before the filter is started.
 *
 * @param {boolean} repaired  what `repairSystemDns()` returned — true means it
 *   found a resolver redirect that the previous run should have undone.
 */
export async function reportStartupState(repaired) {
  _reported = (await readJson(STATE_KEY, {}).catch(() => ({}))) || {};
  if (repaired) await report(KINDS.UNEXPECTED_STOP);
}

async function check() {
  // Anything the socket would not take earlier goes first, and is not subject to
  // the grace period — a queued report is about the *previous* run.
  await flush().catch(() => {});

  if (Date.now() - _startedAt < GRACE_MS) return;
  const p = platform();

  // Only meaningful when the filter is supposed to be running: an unelevated
  // install never applied a redirect, and "the redirect you never made is
  // missing" is not tampering, it is Tuesday.
  try {
    const filter = getWebFilterStatus();
    if (filter.systemDnsApplied && p.dns.supported) {
      const stillApplied = await p.dns.isApplied();
      if (!stillApplied) {
        // Put it back first, then say so. A parent reading the alert should
        // already be looking at a fixed machine — an alert that only complains
        // leaves them with something to do and no way to do it remotely.
        let restored = false;
        try {
          restored = await p.dns.apply({ port: filter.port, ipv6: false });
        } catch { /* reported as unrestored below */ }
        await report(KINDS.FILTER_BYPASSED, { restored });
      }
    }
  } catch { /* a check that throws must not stop the ones after it */ }

  /**
   * `systemIntact`, never `enabled`.
   *
   * `enabled` reads Electron's login item, and on Windows the login item is not
   * how Parentix starts — the installer registers an elevated scheduled task,
   * because Windows will not auto-start an elevated app from the Run key. So a
   * perfectly healthy Windows machine reports `enabled: false` for its whole
   * life, and this check written against it would have raised a tamper alert on
   * every single installation ninety seconds after first start. The alert that
   * fires when nothing is wrong is the one that stops the real ones being read.
   *
   * `null` is "could not tell" and is left alone — not knowing is not evidence.
   */
  try {
    if (p.autostart.supported) {
      const intact = await p.autostart.systemIntact();
      if (intact === false) {
        // Best effort, and honestly reported: on Windows this restores the
        // login item, which starts the agent unelevated. That is a real repair
        // and a partial one, and `restored` is what the parent's alert carries.
        let restored = false;
        try { restored = await p.autostart.set(true); } catch { /* below */ }
        await report(KINDS.AUTOSTART_REMOVED, { restored });
      }
    }
  } catch { /* same */ }

  /**
   * The one condition the product cannot fight, only surface.
   *
   * A local-administrator child can stop the agent, change the resolver and
   * uninstall, and no code running as them can prevent it — so the useful thing
   * is to make sure the parent knows, because the fix (a standard Windows
   * account) is theirs to make. Checked on the timer rather than only at startup
   * because an account can be promoted to administrator later, and answered
   * `null` on any platform that cannot tell — where nothing is reported, since
   * not knowing is not evidence.
   */
  try {
    if (p.setup?.supported) {
      const isAdmin = await p.setup.sessionIsAdministrator();
      if (isAdmin === true) await report(KINDS.ADMIN_USER, {}, ADMIN_REPEAT_AFTER_MS);
    }
  } catch { /* a check that throws must not stop the ones after it */ }
}

export function startTamperWatch() {
  stopTamperWatch();
  _startedAt = Date.now();
  _timer = setInterval(() => { check().catch(() => {}); }, CHECK_INTERVAL_MS);
  // Never the reason the process stays alive through a shutdown.
  _timer.unref?.();
  return _timer;
}

export function stopTamperWatch() {
  clearInterval(_timer);
  _timer = null;
}

/** Test seam: forget the cooling-off window and the queue between harness runs. */
export function resetTamperState() {
  _reported = {};
  _pending = {};
  _startedAt = 0;
}

export const __testing = {
  check,
  flush,
  report,
  pending: () => ({ ..._pending }),
  KINDS,
  MESSAGES,
  REPEAT_AFTER_MS,
  GRACE_MS,
};
export { KINDS as TAMPER_KINDS };
