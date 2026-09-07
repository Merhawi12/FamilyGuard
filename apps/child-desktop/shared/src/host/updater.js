/**
 * Keeping the installed agent current, without ever asking the child.
 *
 * This is the only Parentix client with no store behind it. The phones get new
 * versions from Play and the App Store whether or not anybody thinks about it;
 * a laptop agent that cannot update itself is a copy of whatever shipped the day
 * it was installed, forever — including the day a filtering bug or an expired
 * certificate makes it stop working. So the update path is not a nicety here, it
 * is the difference between a product and a one-off install.
 *
 * ── Three rules, and the reasoning for each ──────────────────────────────────
 *
 * **1. The child is never asked.** No prompt, no "restart now?", no visible
 * download. An update dialog on a monitored computer is a dialog with a Cancel
 * button on the software doing the monitoring, and the one user guaranteed to
 * press it is the one it restricts. The new version is fetched in the background
 * and swapped in on the next quit, which on this app means the next shutdown.
 *
 * **2. A failed update is not an error the child sees.** Every failure here is
 * silent to the renderer and recorded for the parent instead. The agent is
 * running, filtering, and enforcing; a server it could not reach an hour ago
 * changes none of that, and a red banner would only teach a child that the thing
 * is breakable.
 *
 * **3. Nothing runs unpackaged.** `electron-updater` against a dev build tries
 * to resolve an `app-update.yml` that electron-builder never wrote, and throws
 * on startup. The check is `app.isPackaged` rather than NODE_ENV because that is
 * the fact that actually decides whether the file exists.
 *
 * ── The security of it ───────────────────────────────────────────────────────
 *
 * The feed and the artifacts are fetched over HTTPS, and electron-updater
 * verifies the downloaded installer's SHA-512 against the value in the signed
 * feed file before it will run it — so a corrupted or truncated download is
 * rejected rather than executed. That is *integrity*, not *provenance*: anybody
 * who can write to the artifact bucket can publish a build this will install.
 * Provenance needs Authenticode, and when a signing certificate is configured
 * (see `windows/package.json`) electron-updater additionally refuses any
 * installer whose signature does not match `publisherName`. Until then the
 * bucket's write permissions are the whole of the trust model, and that is worth
 * knowing rather than assuming.
 */

/** First check after startup — late enough not to compete with the first sync. */
const INITIAL_DELAY_MS = 2 * 60 * 1000;

/** And every six hours after that, which is far more often than we ship. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const _state = {
  /** The version running right now — what the "This computer" tab shows. */
  current: null,
  /** A newer version that has been downloaded and will install on quit. */
  pending: null,
  checking: false,
  lastCheckedAt: null,
  /** Kept for the parent-facing status, never shown to the child. */
  lastError: null,
  /** False on a dev build, and on a machine where the updater would not load. */
  supported: false,
};

let _timer = null;
let _updater = null;

/**
 * `electron-updater` is CommonJS with no export map, so a named import from an
 * ESM main process resolves to undefined on some Node versions and throws on
 * others — the failure looks like a broken install rather than an interop
 * problem. Taking the default export and destructuring from it is the form that
 * works in both cases.
 *
 * Loaded dynamically as well as defensively: the shared package lists Electron
 * as an optional peer and is imported by a headless harness that has neither.
 */
async function loadUpdater() {
  if (_updater) return _updater;
  const mod = await import('electron-updater');
  _updater = mod.autoUpdater || mod.default?.autoUpdater || mod.default;
  return _updater;
}

export function getUpdateStatus() {
  return { ..._state };
}

/**
 * Start checking. Safe to call on every boot; does nothing on a dev build.
 *
 * @param {object} deps
 * @param {import('electron').App} deps.app
 * @param {(status: object) => void} [deps.onChange] re-render the settings tab
 * @param {string} [deps.feedUrl] overrides the feed baked in at build time —
 *   only useful if the artifacts move host, which is the one breakage a new
 *   build cannot fix because the old build cannot fetch it.
 */
export async function startUpdater({ app, onChange = () => {}, feedUrl = null }) {
  _state.current = app.getVersion();

  if (!app.isPackaged) {
    // Not an error: a developer running `npm run dev` has the newest build by
    // definition. Reported as unsupported so the settings tab says "development
    // build" rather than showing a check that will never happen.
    onChange(getUpdateStatus());
    return null;
  }

  let updater;
  try {
    updater = await loadUpdater();
  } catch (error) {
    _state.lastError = error?.message || 'The updater could not start.';
    onChange(getUpdateStatus());
    return null;
  }

  _state.supported = true;

  updater.autoDownload = true;
  // The whole of rule 1: fetched quietly, applied at shutdown, no interruption.
  updater.autoInstallOnAppQuit = true;
  // The agent is not the user's foreground application and has no window to show
  // release notes in, so there is nothing to gain from a full-fat log.
  updater.logger = null;

  if (feedUrl) {
    try {
      updater.setFeedURL({ provider: 'generic', url: feedUrl });
    } catch (error) {
      // A bad override must not cost us the baked-in feed, which is almost
      // certainly still correct.
      _state.lastError = error?.message || 'That update server could not be used.';
    }
  }

  updater.on('checking-for-update', () => {
    _state.checking = true;
    onChange(getUpdateStatus());
  });

  updater.on('update-not-available', () => {
    _state.checking = false;
    _state.lastCheckedAt = new Date().toISOString();
    _state.lastError = null;
    onChange(getUpdateStatus());
  });

  updater.on('update-downloaded', (info) => {
    _state.checking = false;
    _state.pending = info?.version || null;
    _state.lastCheckedAt = new Date().toISOString();
    _state.lastError = null;
    onChange(getUpdateStatus());
  });

  updater.on('error', (error) => {
    _state.checking = false;
    _state.lastError = error?.message || 'The update check did not finish.';
    onChange(getUpdateStatus());
  });

  const check = async () => {
    try {
      await updater.checkForUpdates();
    } catch {
      // Already recorded by the `error` handler; swallowed so an offline laptop
      // does not produce an unhandled rejection every six hours.
    }
  };

  // `unref` so a pending timer never holds the process open through a shutdown
  // the child is waiting on.
  const initial = setTimeout(check, INITIAL_DELAY_MS);
  initial.unref?.();
  _timer = setInterval(check, CHECK_INTERVAL_MS);
  _timer.unref?.();

  onChange(getUpdateStatus());
  return updater;
}

export function stopUpdater() {
  clearInterval(_timer);
  _timer = null;
}

/**
 * The running version is shown in the agent's own "This computer" tab and
 * nowhere else, and that is a decision rather than an omission.
 *
 * Sending it to the server would mean a socket event, a column on `devices` and
 * a line on the parent's device card — and the parent has no use for it. A build
 * number is a support question ("which version is that laptop on?"), and support
 * can have it read off the screen of the machine in question, which is where
 * somebody is already standing when the question gets asked. A field nobody
 * reads is the kind of half-feature this codebase has had to go back and delete
 * before.
 */
