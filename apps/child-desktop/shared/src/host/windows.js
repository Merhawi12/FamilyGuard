import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, screen } from 'electron';
import { colors } from '../theme.js';

/**
 * The windows: one the child opens, and one per display that they cannot.
 *
 * Both are `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
 * and load a `file://` URL with a content-security policy in the document. This
 * is the surface of the thing restricting a child, on that child's own computer,
 * and a renderer with Node in it is a way to switch the agent off from a page it
 * already has open.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, '..', 'ui');
const PRELOAD = path.join(HERE, '..', '..', 'preload.cjs');

const webPreferences = (extraArguments = []) => ({
  preload: PRELOAD,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  // Passed through `process.argv`, which is the only channel a sandboxed preload
  // can read before the first IPC round-trip. The link screen needs the API host
  // in its very first paint, and the lock screen needs its reason.
  additionalArguments: extraArguments,
  spellcheck: false,
});

let _main = null;
let _locks = [];
let _lockState = null;
let _apiHost = 'api.parentix.ca';

export function setApiHost(host) {
  _apiHost = host;
}

// ── The main window ───────────────────────────────────────────────────────────

export function createMainWindow({ show = true } = {}) {
  if (_main && !_main.isDestroyed()) {
    if (show) { _main.show(); _main.focus(); }
    return _main;
  }

  _main = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    show,
    title: 'Parentix',
    backgroundColor: colors.canvas,
    autoHideMenuBar: true,
    webPreferences: webPreferences([`--parentix-api-host=${encodeURIComponent(_apiHost)}`]),
  });

  // There is no menu bar to reach a developer console from, and no keyboard
  // shortcut either. Not a security boundary — a child with the installer can
  // do what they like — but the window a monitoring agent presents should not
  // have "Inspect element" one keystroke away.
  _main.setMenu(null);

  /**
   * Closing the window does not stop the agent.
   *
   * It hides to the tray instead. An agent a child can stop by clicking the X is
   * not a parental control, and a window that reappears when they close it is
   * not one either — hiding is what makes both true at once.
   */
  _main.on('close', (event) => {
    if (app.isQuitting) return;
    event.preventDefault();
    _main.hide();
  });

  _main.loadFile(path.join(UI, 'index.html'));
  return _main;
}

export function mainWindow() {
  return _main && !_main.isDestroyed() ? _main : null;
}

export function showMain() {
  const window = createMainWindow({ show: true });
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return window;
}

/** Push a status update to whichever windows are open. */
export function sendToMain(channel, payload) {
  if (_main && !_main.isDestroyed()) _main.webContents.send(channel, payload);
}

// ── The lock screen ───────────────────────────────────────────────────────────

/**
 * One full-screen window per display, above everything, that will not give the
 * focus back.
 *
 * `screen-saver` is the highest level Electron offers and is the one that sits
 * over a full-screen game. The `blur` handler is what makes it a lock rather
 * than a window: alt-tab moves the focus away, and it comes straight back.
 *
 * **This is a deterrent, not a cage, and the difference is worth being honest
 * about.** A child who knows how can reach a terminal on either platform and
 * end the process. What this does is make the boundary unmissable and
 * un-crossable by accident, which is what a screen-time rule in a family
 * actually needs to be. Turning it into something stronger means a Windows
 * service or a macOS daemon that a user session cannot terminate — a different
 * product decision, with an uninstall story attached, and not one to make
 * silently inside a window helper.
 */
export function showLock(state) {
  _lockState = state || null;
  const encoded = encodeURIComponent(JSON.stringify(state || {}));

  if (_locks.length) {
    for (const window of _locks) {
      if (!window.isDestroyed()) window.webContents.send('lock:state', state);
    }
    return _locks;
  }

  _locks = screen.getAllDisplays().map((display) => {
    const window = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      fullscreen: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      closable: false,
      minimizable: false,
      movable: false,
      resizable: false,
      backgroundColor: colors.teal900,
      webPreferences: webPreferences([
        `--parentix-api-host=${encodeURIComponent(_apiHost)}`,
        `--parentix-lock-state=${encoded}`,
      ]),
    });

    window.setMenu(null);
    window.setAlwaysOnTop(true, 'screen-saver');
    // Follow the child onto whichever desktop or space they switch to.
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    window.on('blur', () => {
      if (window.isDestroyed()) return;
      window.setAlwaysOnTop(true, 'screen-saver');
      window.show();
      window.focus();
    });

    window.loadFile(path.join(UI, 'lock.html'));
    return window;
  });

  return _locks;
}

export function hideLock() {
  for (const window of _locks) {
    if (window.isDestroyed()) continue;
    // `closable: false` refuses `close()`; destroy is the way out, and this is
    // the only place that is allowed to take it.
    window.removeAllListeners('blur');
    window.destroy();
  }
  _locks = [];
  _lockState = null;
}

/**
 * A display plugged in or unplugged while the screen is locked.
 *
 * Without this, connecting a second monitor during bedtime hands the child an
 * uncovered screen — the most obvious way around a lock, and one that needs no
 * knowledge at all.
 */
export function watchDisplays(isLocked) {
  const rebuild = () => {
    if (!isLocked()) return;
    const state = _lockState;
    hideLock();
    showLock(state);
  };
  screen.on('display-added', rebuild);
  screen.on('display-removed', rebuild);
  screen.on('display-metrics-changed', rebuild);
}
