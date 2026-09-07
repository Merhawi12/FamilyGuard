import { ps } from './powershell.js';

/**
 * Whether this computer will start Parentix on its own.
 *
 * There is a Windows-specific answer to that question and it is not the one
 * Electron gives, which is the whole reason this file exists.
 *
 * `app.getLoginItemSettings().openAtLogin` reads the Run key — and on Windows
 * the Run key is *not* how Parentix starts. It cannot be: website filtering
 * needs `Set-DnsClientServerAddress`, which needs an administrator, and Windows
 * will not auto-start an elevated application from the Run key at all. So the
 * installer registers a **scheduled task** instead (see `build/installer.nsh`),
 * and a correctly installed, perfectly healthy machine reports `openAtLogin`
 * as false for its entire life.
 *
 * That mattered the moment anything started *acting* on the answer. The tamper
 * watcher asks whether start-at-sign-in has been switched off, and against the
 * Electron answer it would have said yes — on every Windows installation, ninety
 * seconds after the first start, raising a false alarm with the parent about a
 * computer that was working exactly as designed. An alert that fires when
 * nothing is wrong is worse than no alert: it is what teaches a parent to stop
 * reading them.
 *
 * So the real question is asked of the real mechanism. Either arrangement counts
 * — the elevated task the installer made, or the ordinary login item the child
 * can toggle in Settings — because either one means the computer starts
 * Parentix without anybody remembering to.
 */

/** Created by the installer, and the only elevated way in. Named in installer.nsh. */
const LOGON_TASK = 'Parentix Child Agent';

/**
 * Does the logon task still exist?
 *
 * `schtasks /Query` exits non-zero when the task is not there, which is the
 * ordinary "somebody deleted it" answer and not an error worth logging. It also
 * exits non-zero on a machine where querying tasks is denied by policy, and the
 * two are not distinguishable from here — hence `null` rather than `false` for
 * anything that is not a clean yes or a clean no.
 *
 * @returns {Promise<boolean|null>} null when the question could not be answered
 */
async function logonTaskExists() {
  try {
    // `-ErrorAction Stop` so a missing task throws rather than writing to the
    // error stream and exiting 0, which is what `Get-ScheduledTask` does on some
    // builds and would read as "present".
    await ps(`$ErrorActionPreference = 'Stop'
$null = Get-ScheduledTask -TaskName '${LOGON_TASK}'
`);
    return true;
  } catch (err) {
    // "No MSFT_ScheduledTask objects found" — the task is genuinely gone.
    if (/No MSFT_ScheduledTask|cannot find|does not exist/i.test(err?.message || '')) return false;
    // Anything else (policy, a missing cmdlet on an old build, a timeout) is not
    // evidence of tampering, and must not be reported as such.
    return null;
  }
}

export const autostart = {
  /**
   * @param {() => Promise<boolean>} loginItemEnabled  the host's Electron answer
   * @returns {Promise<boolean|null>}
   */
  async systemIntact(loginItemEnabled) {
    const task = await logonTaskExists();
    if (task === true) return true;

    // No task: the login item is the remaining way this computer could start
    // Parentix, and it is a real one — degraded, because a login-item start is
    // unelevated and cannot filter websites, but not "will not start".
    const loginItem = await loginItemEnabled().catch(() => false);
    if (loginItem) return true;

    // Both absent, and we are sure about the task: this computer will not start
    // Parentix again on its own.
    return task === false ? false : null;
  },
};

export const __testing = { logonTaskExists, LOGON_TASK };
