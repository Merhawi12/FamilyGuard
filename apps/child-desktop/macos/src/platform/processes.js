import { tryRun } from './shell.js';

/**
 * Closing an application the parent has paused — the macOS half.
 *
 * **`kill`, not `osascript … to quit`.** Telling an application to quit through
 * AppleScript is the polite version and it needs Automation consent, which puts
 * a dialog in front of the child that they can refuse — the exact prompt
 * `foreground.js` avoids. Signals need nothing: SIGTERM is what an application
 * receives when the system logs out, and a Cocoa app handles it by terminating
 * cleanly. Anything still running four seconds later gets SIGKILL, because an
 * app that puts up "Save changes?" and waits is otherwise a way to keep a
 * blocked app open indefinitely.
 *
 * The deny-list below matters for the same reason it does on Windows: an app
 * rule is a string a parent typed, and a parent who blocks `com.apple.finder`
 * because they saw it in a list has asked the agent to take the desktop away.
 */

/** Bundle identifiers this agent will not act on, whatever a rule says. */
const PROTECTED = new Set([
  'com.apple.finder',
  'com.apple.dock',
  'com.apple.loginwindow',
  'com.apple.systemuiserver',
  'com.apple.controlcenter',
  'com.apple.notificationcenterui',
  'com.apple.windowserver',
  'com.apple.securityagent',
  'com.apple.coreservices.uiagent',
  'com.apple.systempreferences',
  'com.apple.systemsettings',
  'ca.parentix.child-desktop',
]);

/**
 * `com.Google.Chrome` → `com.google.chrome`, or null.
 *
 * A bundle identifier is a dotted reverse-DNS name, and nothing else is
 * accepted. The value goes into an argument array rather than a shell string, so
 * this is belt as well as braces — but it is also what stops a rule written
 * against a Windows executable name (`chrome.exe`) matching anything here, which
 * would otherwise be a confusing partial success.
 */
export function bundleId(appId) {
  const id = String(appId || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(id) || !id.includes('.')) return null;
  if (id.endsWith('.exe')) return null;
  if (PROTECTED.has(id)) return null;
  return id;
}

/** Every running process id for a bundle identifier, via LaunchServices. */
async function pidsFor(id) {
  // `lsappinfo find` prints one ASN per line for every running instance.
  const found = await tryRun('/usr/bin/lsappinfo', ['find', `bundleid=${id}`]);
  const asns = found.split('\n').map((line) => line.trim()).filter(Boolean);

  const pids = [];
  for (const asn of asns) {
    const info = await tryRun('/usr/bin/lsappinfo', ['info', '-only', 'pid', asn]);
    const match = /=\s*(\d+)/.exec(info);
    if (match) pids.push(Number(match[1]));
  }
  return pids;
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

export const apps = {
  supported: true,

  /**
   * @returns the number of processes that actually went away, so the caller can
   *          tell "closed it" from "tried and could not".
   */
  async close(appId) {
    const id = bundleId(appId);
    if (!id) {
      console.warn('[processes] refusing to close', appId);
      return 0;
    }

    const before = await pidsFor(id);
    if (before.length === 0) return 0;

    for (const pid of before) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    await wait(4000);

    for (const pid of await pidsFor(id)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await wait(500);

    const after = await pidsFor(id);
    return Math.max(0, before.length - after.length);
  },
};

export const __testing = { PROTECTED, pidsFor };
