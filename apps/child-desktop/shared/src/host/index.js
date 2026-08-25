import { app, ipcMain, safeStorage, Notification, shell } from 'electron';
import { setPlatform } from '../platform/index.js';
import * as agent from '../services/agent.js';
import * as chat from '../services/chat.js';
import { hasLink } from '../services/link.js';
import { API_HOST } from '../services/api.js';
import {
  createMainWindow, showMain, sendToMain, showLock, hideLock, setApiHost, watchDisplays,
} from './windows.js';
import { createTray, trayIconPath } from './tray.js';

/**
 * Everything the Windows and macOS projects have in common, which is almost all
 * of it.
 *
 * A platform project is a `package.json`, a packaging config, and an object
 * describing the four things that genuinely differ — reading the front window,
 * closing an application, changing the resolver, and naming the permissions that
 * gate those. This assembles that with the parts Electron already provides
 * identically on both (an encrypted store, notifications, windows, autostart) and
 * runs the agent.
 *
 * The split is the same one `apps/child-app` makes between `shared/` and its two
 * Expo projects, for the same reason: a behaviour change has to land in one
 * place or it lands in one platform.
 */

/**
 * `before-quit` gets one chance to put the machine back, and it is not allowed
 * to take longer than this.
 *
 * Shutdown is the case that matters: Windows and macOS both kill an app that
 * will not close, and the thing left undone would be the resolver redirect —
 * a machine that boots with no working DNS and no explanation. The next start
 * repairs it (`repairSystemDns`), so this is the fast path rather than the only
 * one, but it is the one nobody has to notice.
 */
const SHUTDOWN_GRACE_MS = 8000;

const ok = (value) => ({ ok: true, value });
const fail = (error) => ({ ok: false, error: error?.response?.data?.error || error?.message || 'Something went wrong.' });

/**
 * @param {object} options
 * @param {(ctx: {dataDir: string}) => object} options.createOs  the
 *   platform-specific half — see contract.js. A factory rather than an object
 *   because `app.getPath('userData')` is not answerable until Electron is ready,
 *   and the DNS backup file has to live there.
 * @param {string} options.projectRoot  where `build/tray.png` lives
 */
export async function bootstrap({ createOs, projectRoot }) {
  /**
   * One agent per machine.
   *
   * Two would be worse than a wasted process: both would sample the front
   * window, both would try to bind port 53 (the second failing and reporting
   * website filtering as broken), and both would upload the same usage, which
   * the server upserts by max and would therefore accept without complaint.
   */
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return null;
  }
  app.on('second-instance', () => showMain());

  // Windows needs this before a notification will show the app's name and icon
  // rather than "electron.app.Electron"; it is also what the installer's Start
  // Menu shortcut is matched against.
  app.setAppUserModelId('ca.parentix.child-desktop');

  /**
   * Where per-user state lives, decided here rather than inherited.
   *
   * Electron derives `userData` from the app's `name`, and both platform
   * projects are npm-scoped — so it landed in `%APPDATA%\@parentix\
   * child-desktop-windows`, with the Mac using a different directory again for
   * the same product. That is not merely untidy: the Windows uninstaller and
   * the macOS preinstall script both go looking for the leftover DNS backup by
   * path, and a resolver redirect that outlives an uninstall is a computer with
   * no internet. One name, set before anything asks for a path.
   */
  app.setName('Parentix');

  await app.whenReady();

  const dataDir = app.getPath('userData');

  const platform = setPlatform({
    ...createOs({ dataDir }),
    dataDir: () => dataDir,

    /**
     * DPAPI on Windows, the login Keychain on macOS.
     *
     * `isEncryptionAvailable` can be false — a Linux session with no keyring, a
     * Mac whose Keychain is locked. Storing the device token in the clear in
     * that case would be a credential on disk that authenticates as the child,
     * so it is refused instead: the agent will not link, and says why.
     */
    secureStorage: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('This computer cannot store the Parentix credential securely.');
        }
        return safeStorage.encryptString(plain);
      },
      decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher)),
    },

    notify: ({ title, body }) => {
      if (!Notification.isSupported()) return;
      new Notification({ title, body, silent: false }).show();
    },

    lockScreen: {
      show: (state) => showLock(state),
      hide: () => hideLock(),
    },

    autostart: {
      supported: true,
      enabled: async () => app.getLoginItemSettings().openAtLogin,
      set: async (on) => {
        app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true, args: ['--parentix-autostart'] });
        return app.getLoginItemSettings().openAtLogin;
      },
    },
  });

  setApiHost(API_HOST);

  // ── The window ──────────────────────────────────────────────────────────────
  const linked = await hasLink();
  /**
   * Started by the login item, on a machine that is already linked: stay in the
   * tray. A window that opens itself over whatever the child was doing at every
   * sign-in is the fastest way to make a family uninstall a product that is
   * otherwise working. An *unlinked* machine opens the window regardless, since
   * there is nothing to do until somebody types a code.
   */
  const startedHidden = process.argv.includes('--parentix-autostart') && linked;
  createMainWindow({ show: !startedHidden });

  const tray = createTray({
    iconPath: trayIconPath(projectRoot),
    onStatusText: () => {
      const status = agent.getAgentStatus();
      if (!status.linked) return 'Not linked yet';
      // A locked machine the child is working on through their allowlist is not
      // the same state as a locked machine with the screen taken, and a tray that
      // called both "paused" would be describing a computer that is plainly in
      // use as though it were asleep.
      if (status.locked && status.allowlistMode) return 'Out of time — allowed apps only';
      if (status.locked) return 'Paused by a screen-time rule';
      return status.sync?.lastError ? 'Reconnecting…' : 'Linked and monitoring';
    },
  });

  agent.onAgentChange((status) => {
    sendToMain('agent:status', status);
    tray?.rebuild();
  });

  /**
   * Rebuild the lock windows when a display is plugged in — but not when the
   * child is working through their allowlist.
   *
   * `locked` alone was the right test until a lock could be dismissed. With
   * allowlist mode it would resurrect the lock screen the moment a second monitor
   * was connected, on a machine the child had been given permission to use, with
   * nothing to explain where it came from.
   */
  watchDisplays(() => {
    const status = agent.getAgentStatus();
    return status.locked && !status.allowlistMode;
  });

  // ── The bridge ──────────────────────────────────────────────────────────────
  ipcMain.handle('agent:status', () => ok(agent.getAgentStatus()));

  ipcMain.handle('agent:link', async (_event, code) => {
    try {
      await agent.linkThisDevice(code);
      return ok(agent.getAgentStatus());
    } catch (error) {
      // The server's sentence, not Electron's wrapper around it: "That code has
      // expired" is the thing the child has to read.
      return fail(error);
    }
  });

  ipcMain.handle('chat:list', async () => {
    try { return ok(await chat.fetchMessages()); } catch (error) { return fail(error); }
  });
  ipcMain.handle('chat:send', async (_event, text) => {
    try { return ok(await chat.sendMessage(text)); } catch (error) { return fail(error); }
  });
  ipcMain.handle('chat:emergency', async () => {
    try { return ok(await chat.sendEmergency()); } catch (error) { return fail(error); }
  });

  /**
   * The child dismissing a daily-limit lock into their allowlist.
   *
   * Handed straight to the agent, which owns the decision: this window is on a
   * child's own computer and a main-process handler that merely relayed its
   * request would be the whole policy. `useAllowedApps` refuses anything that is
   * not a `'limit'` lock with apps behind it, and hides the lock screen itself
   * when it agrees, so nothing here touches a window.
   */
  ipcMain.handle('lock:use-allowed', () => ok(agent.useAllowedApps()));

  ipcMain.handle('permissions:list', async () => {
    try { return ok(await platform.permissions.list()); } catch (error) { return fail(error); }
  });
  ipcMain.handle('permissions:open', async (_event, key) => {
    try { return ok(await platform.permissions.open(key, { shell })); } catch (error) { return fail(error); }
  });

  ipcMain.handle('autostart:get', async () => ok(await platform.autostart.enabled()));
  ipcMain.handle('autostart:set', async (_event, on) => ok(await platform.autostart.set(on)));

  chat.onMessage((message) => sendToMain('chat:message', message)).catch(() => {
    // No socket yet — the agent opens one as soon as this machine is linked, and
    // `onMessage` re-registers through the pending-listener list in socket.js.
  });

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  // A tray application: closing the last window is not quitting.
  app.on('window-all-closed', () => {});
  app.on('activate', () => createMainWindow({ show: true }));

  /**
   * Stop cleanly, once, however the quit was asked for.
   *
   * The resolver restore is the reason this is more than a formality, and the
   * timeout is the reason it is not a hang: a shutdown that blocks on a network
   * call is a machine that will not turn off.
   */
  let stopping = null;
  app.on('before-quit', (event) => {
    if (stopping) return;
    event.preventDefault();
    app.isQuitting = true;
    stopping = Promise.race([
      agent.stopAgent(),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
    ]).finally(() => app.exit(0));
  });

  await agent.startAgent();
  tray?.rebuild();

  return platform;
}
