import path from 'node:path';
import { app, Menu, Tray, nativeImage } from 'electron';
import { showMain } from './windows.js';

/**
 * The tray icon, which is the whole of the agent's presence when its window is
 * closed.
 *
 * **There is no "Quit" on it, and that is the feature.** A parental control a
 * child can end from a menu is a parental control that ends at the first
 * inconvenience — and unlike closing the window, quitting would take the website
 * filter with it. Stopping Parentix is an uninstall, which needs the
 * administrator the installer asked for.
 *
 * A quit item does appear in a development run (`npm run dev`, or `PARENTIX_DEV`
 * in the environment), because the alternative during development is Task
 * Manager — and reaching for Task Manager is how a developer ends the process
 * *without* the shutdown handler running, leaving the machine's resolver pointed
 * at a proxy that is no longer there.
 */

const isDev = () => !!process.env.PARENTIX_DEV || process.argv.includes('--dev');

let _tray = null;

export function createTray({ iconPath, onStatusText }) {
  if (_tray) return _tray;

  const icon = nativeImage.createFromPath(iconPath);
  // An empty image gives a blank square in the tray with no error anywhere;
  // better to have no tray icon and know why.
  if (icon.isEmpty()) {
    console.warn('[tray] icon missing at', iconPath, '— run `npm run assets` from the repo root');
    return null;
  }

  _tray = new Tray(icon);
  _tray.setToolTip('Parentix');
  _tray.on('click', () => showMain());
  _tray.on('double-click', () => showMain());

  const rebuild = () => {
    const items = [
      { label: 'Open Parentix', click: () => showMain() },
      { type: 'separator' },
      { label: onStatusText?.() || 'Starting…', enabled: false },
    ];

    if (isDev()) {
      items.push(
        { type: 'separator' },
        {
          label: 'Quit (development only)',
          click: () => {
            app.isQuitting = true;
            app.quit();
          },
        },
      );
    }

    _tray.setContextMenu(Menu.buildFromTemplate(items));
  };

  rebuild();
  return { tray: _tray, rebuild };
}

export function trayIconPath(projectRoot) {
  return path.join(projectRoot, 'build', 'tray.png');
}
