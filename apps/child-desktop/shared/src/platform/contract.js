/**
 * What a desktop platform has to be able to do, and what happens when it cannot.
 *
 * The agent is written once. Everything that differs between a Windows laptop
 * and a Mac — how you learn which window is in front, how you close an app, how
 * you point the machine's resolver at a local proxy, where a secret is kept —
 * is behind this one object, supplied by `windows/` or `macos/` at startup.
 *
 * Two rules govern it, and both are lessons the mobile app paid for:
 *
 * **A capability that is missing says so.** Every group carries `supported`.
 * Nothing here returns a plausible-looking zero — a screen-time figure of 0m is
 * indistinguishable from a well-behaved child, and a parent reading one has been
 * told something false. The Settings window filters on `supported` and the agent
 * never starts a monitor that reports itself unsupported, so a capability the
 * machine cannot provide is absent rather than permanently switched off.
 *
 * **A capability that needs a permission reports which one.** On macOS the
 * frontmost application is behind Automation/Accessibility consent, and DNS
 * changes need an administrator on both platforms. Those are answers, not
 * faults: `permissions.list()` names each one so the child can be walked through
 * granting it, the same job `PermissionsScreen` does on Android.
 *
 * @typedef {object} DesktopPlatform
 *
 * @property {'win32'|'darwin'} id
 * @property {() => string} osVersion        e.g. "Windows 11 Pro 10.0.26200"
 * @property {() => string} deviceLabel      e.g. "MERA-LAPTOP · Windows"
 * @property {() => string} dataDir          per-user directory for the agent's state
 *
 * @property {object} secureStorage          OS-backed encryption for the device token
 * @property {() => boolean} secureStorage.available
 * @property {(plain: string) => Buffer} secureStorage.encrypt
 * @property {(cipher: Buffer) => string} secureStorage.decrypt
 *
 * @property {object} foreground             which application is in front, over time
 * @property {boolean} foreground.supported
 * @property {(onSample: (s: ForegroundSample) => void) => () => void} foreground.start
 *
 * @property {object} apps                   acting on a running application
 * @property {boolean} apps.supported
 * @property {(appId: string) => Promise<number>} apps.close   → processes closed
 *
 * @property {object} dns                    system resolver control
 * @property {boolean} dns.supported
 * @property {() => Promise<boolean>} dns.canConfigure          are we elevated?
 * @property {() => Promise<string[]>} dns.upstreams            resolvers to forward to
 * @property {(o: {port: number, ipv6: boolean}) => Promise<boolean>} dns.apply   point the machine at us
 * @property {() => Promise<boolean>} dns.restore               and put it back
 *
 * @property {object} lockScreen             the full-screen "time is up" surface
 * @property {(state: LockState) => void} lockScreen.show
 * @property {() => void} lockScreen.hide
 *
 * @property {(n: {title: string, body: string, data?: object}) => void} notify
 *
 * @property {object} autostart              run when the child signs in
 * @property {boolean} autostart.supported
 * @property {() => Promise<boolean>} autostart.enabled
 * @property {(on: boolean) => Promise<boolean>} autostart.set
 *
 * @property {object} permissions
 * @property {() => Promise<PermissionState[]>} permissions.list
 * @property {(key: string) => Promise<void>} permissions.open  open the settings pane
 *
 * @typedef {object} ForegroundSample
 * @property {string} appId    the identifier a parent's rule is written against —
 *                             `chrome.exe` on Windows, `com.google.Chrome` on macOS
 * @property {string} appName  the human label, e.g. "Google Chrome"
 * @property {number} [pid]
 *
 * @typedef {object} LockState
 * @property {'daily_limit'|'bedtime'|'outside_schedule'} reason
 * @property {string} [childName]
 *
 * @typedef {object} PermissionState
 * @property {string} key
 * @property {string} label
 * @property {boolean} granted
 * @property {string} why      one sentence a child can read
 * @property {boolean} [openable]
 */

/**
 * A platform object with every capability switched off.
 *
 * This is what the agent runs against before a host installs its own, and what
 * the e2e harness starts from. It is deliberately complete rather than partial:
 * a missing method here would be a crash inside the agent, and the whole point
 * of the contract is that an unavailable capability is an answer.
 */
export const UNSUPPORTED = Object.freeze({
  id: 'unknown',
  osVersion: () => 'unknown',
  deviceLabel: () => 'Desktop',
  dataDir: () => '.',

  secureStorage: {
    available: () => false,
    encrypt: (plain) => Buffer.from(plain, 'utf8'),
    decrypt: (cipher) => Buffer.from(cipher).toString('utf8'),
  },

  foreground: { supported: false, start: () => () => {} },
  apps: { supported: false, close: async () => 0 },

  dns: {
    supported: false,
    canConfigure: async () => false,
    upstreams: async () => [],
    apply: async () => false,
    restore: async () => false,
  },

  lockScreen: { show: () => {}, hide: () => {} },
  notify: () => {},

  autostart: { supported: false, enabled: async () => false, set: async () => false },
  permissions: { list: async () => [], open: async () => {} },
});

/**
 * What this machine can and cannot do, in the form the Settings window renders.
 *
 * Kept here rather than in the UI because it is the honest-plumbing rule in one
 * place: the labels, and the fact that an unsupported capability is described
 * rather than shown as a monitor that is merely off.
 */
export function describeCapabilities(p) {
  return [
    {
      key: 'screenTime',
      label: 'Screen time',
      supported: p.foreground.supported,
      unavailable: 'This computer cannot report which app is in front, so screen time is not measured here.',
    },
    {
      key: 'appBlocking',
      label: 'App blocking',
      supported: p.foreground.supported && p.apps.supported,
      unavailable: 'Apps cannot be paused on this computer.',
    },
    {
      key: 'websiteBlocking',
      label: 'Website blocking',
      supported: p.dns.supported,
      unavailable: 'Websites cannot be filtered on this computer.',
    },
    {
      key: 'webHistory',
      label: 'Web history',
      supported: p.dns.supported,
      unavailable: 'Web history comes from the same filter, so it is not collected here.',
    },
    {
      key: 'notifications',
      label: 'Notifications',
      supported: true,
      unavailable: null,
    },
  ];
}
