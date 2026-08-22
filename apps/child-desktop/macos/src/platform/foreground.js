import { stream } from './shell.js';

/**
 * Which application the child is actually using, sampled — the macOS half.
 *
 * **`lsappinfo`, not AppleScript, and the reason is a permission prompt.** The
 * obvious way to ask macOS which app is in front is
 * `tell application "System Events" to get … whose frontmost is true`, and it
 * puts a TCC consent dialog in front of the child on first use: *"Parentix wants
 * to control System Events."* A child who clicks Don't Allow has switched screen
 * time off, macOS will not ask again, and the parent is told nothing.
 * `lsappinfo` is LaunchServices — it answers the same question, needs no
 * consent, and cannot be refused. The result is that this agent asks macOS for
 * **no TCC permission at all**, which is worth more than any single feature it
 * could have bought with one.
 *
 * **Idle time comes from `ioreg`.** `HIDIdleTime` is nanoseconds since the last
 * keyboard or trackpad event, and it also counts a locked screen and a sleeping
 * display as idle — which is exactly the behaviour wanted. A MacBook left open
 * on a browser must not spend a child's whole daily allowance while they are at
 * dinner.
 *
 * **The identifier is the bundle identifier** — `com.google.Chrome` — where
 * Windows reports `chrome.exe`. Both are what a rule is written against on that
 * platform, and both reach the parent's "known apps" picker the same way, from
 * the usage samples this machine uploads.
 */

const SAMPLE_SECONDS = 5;
const IDLE_SECONDS = 60;

/**
 * Everything is `sed`-extracted as "the last double-quoted value on the line",
 * rather than by naming `CFBundleIdentifier` and `LSDisplayName`. `lsappinfo`'s
 * key names have moved between macOS releases; the shape of its output — one
 * `"key"="value"` pair per line for a single-key query — has not.
 */
const SCRIPT = `
while :; do
  idle=$(ioreg -c IOHIDSystem 2>/dev/null | awk '/HIDIdleTime/ { print int($NF / 1000000000); exit }')
  [ -z "$idle" ] && idle=0
  bundle=""
  name=""
  if [ "$idle" -lt ${IDLE_SECONDS} ]; then
    front=$(lsappinfo front 2>/dev/null)
    if [ -n "$front" ]; then
      bundle=$(lsappinfo info -only bundleid "$front" 2>/dev/null | sed -n 's/.*="\\([^"]*\\)".*/\\1/p')
      name=$(lsappinfo info -only name "$front" 2>/dev/null | sed -n 's/.*="\\([^"]*\\)".*/\\1/p')
    fi
  fi
  printf '%s\\t%s\\t%s\\n' "$idle" "$bundle" "$name"
  sleep ${SAMPLE_SECONDS}
done
`;

export const foreground = {
  supported: true,

  /**
   * Begin sampling. `onSample` receives `{appId, appName}` while somebody is
   * using the machine and `null` while nobody is.
   *
   * Restarted if it exits, because the alternative is a Mac that silently stops
   * measuring: the loop can be killed by a cleanup tool, by a policy, or by a
   * child who has found Activity Monitor.
   */
  start(onSample) {
    let stopped = false;
    let stopChild = null;
    let restarts = 0;

    const launch = () => {
      if (stopped) return;
      stopChild = stream(SCRIPT, ([, bundle, name]) => {
        restarts = 0;
        const appId = String(bundle || '').trim().toLowerCase();
        onSample(appId ? { appId, appName: String(name || '').trim() || appId } : null);
      }, {
        onExit: () => {
          if (stopped) return;
          const delay = Math.min(60_000, 2_000 * 2 ** Math.min(restarts, 5));
          restarts += 1;
          console.warn(`[foreground] watcher exited; retrying in ${delay}ms`);
          setTimeout(launch, delay).unref?.();
        },
      });
    };

    launch();

    return () => {
      stopped = true;
      stopChild?.();
    };
  },
};

export const __testing = { SCRIPT, SAMPLE_SECONDS, IDLE_SECONDS };
