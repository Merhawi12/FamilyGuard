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
 * @property {() => Promise<boolean>} dns.isApplied             is *every* interface still on us?
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
 * @property {() => Promise<boolean>} autostart.enabled          is the login item set?
 * @property {(on: boolean) => Promise<boolean>} autostart.set
 * @property {() => Promise<boolean|null>} autostart.systemIntact  will this computer
 *   start Parentix on its own, by *any* arrangement? Not the same question as
 *   `enabled` on Windows, where the installer uses an elevated scheduled task
 *   and the login item is never set. `null` means it could not be determined,
 *   and nothing acts on that.
 *
 * @property {object} permissions
 * @property {() => Promise<PermissionState[]>} permissions.list
 * @property {(key: string) => Promise<void>} permissions.open  open the settings pane
 *
 * @property {object} setup                  the once-per-installation half
 * @property {boolean} setup.supported
 * @property {() => Promise<boolean>} setup.isElevated   can this process change
 *   machine-wide settings *right now*? On Windows that is a UAC token; on macOS
 *   it is whether the root launchd helper the .pkg installs is in place.
 * @property {string} setup.elevationHint    one sentence telling a family how to
 *   get that permission on this platform, shown when it is missing.
 * @property {boolean} setup.canRequestElevation  is `applyPrivileged({elevate})`
 *   able to ask the OS for permission, or does it have to be granted outside the
 *   app? True on Windows (a UAC prompt), false on macOS (the installer's helper).
 * @property {() => Promise<SessionOwner|null>} setup.sessionOwner  who is at the
 *   keyboard versus who this process is running as. `null` when it cannot be
 *   told — and nothing acts on `null`, because not knowing is not evidence.
 * @property {(o: PrivilegedSetup) => Promise<PrivilegedResult>} setup.applyPrivileged
 * @property {(o: {stateDir: string}) => Promise<PrivilegedResult>} setup.verifyPrivileged
 *   read back what `applyPrivileged` should have done, from the machine rather
 *   than from anything we remember writing.
 *
 * @typedef {object} SessionOwner
 * @property {string} console   the interactively signed-in account, `DOMAIN\name`
 * @property {string} current   the account this process is running as
 * @property {boolean} matches  whether the agent is running as the person using
 *   the computer. False is the over-the-shoulder UAC case — a parent typed their
 *   own administrator password, so `userData` is *their* profile and everything
 *   the agent stores would land in the wrong account.
 *
 * @typedef {object} PrivilegedSetup
 * @property {string} stateDir   the directory holding the device credential
 * @property {string} exePath    what a startup entry should launch
 * @property {string} user       the account a startup entry belongs to
 * @property {boolean} elevate   may this ask the OS for permission (a UAC
 *   prompt)? Only ever true when a person just pressed a button.
 *
 * @typedef {object} PrivilegedResult
 * @property {StartupResult|null} startup  null means this platform has no
 *   privileged startup mechanism, and the caller should use the login item.
 * @property {boolean} stateDirSecured
 * @property {string[]} problems  human sentences, already safe to log
 *
 * @typedef {object} StartupResult
 * @property {boolean} registered
 * @property {string} mechanism  e.g. `'scheduled-task'`
 * @property {string} [detail]
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
    // `true`, not `false`: on a platform that cannot redirect the resolver there
    // is no redirect to have been undone, and the tamper watcher must not read
    // "we never applied it" as "somebody removed it".
    isApplied: async () => true,
    restore: async () => false,
  },

  lockScreen: { show: () => {}, hide: () => {} },
  notify: () => {},

  autostart: {
    supported: false,
    enabled: async () => false,
    set: async () => false,
    // `null`, not `false`: a platform with no autostart has nothing that could
    // have been switched off, and the tamper watcher treats "cannot tell" as
    // nothing to report. `false` here would alert every parent, for ever.
    systemIntact: async () => null,
  },
  permissions: { list: async () => [], open: async () => {} },

  /**
   * First-run setup, on a platform that cannot do the privileged half.
   *
   * `isElevated` is false rather than true, and that is the safe direction: a
   * setup that believed it had permission would create nothing, verify nothing,
   * and write `setupCompleted: true` over a machine where the resolver can never
   * be redirected. False makes it say so instead.
   */
  setup: {
    supported: false,
    isElevated: async () => false,
    elevationHint: 'This computer cannot complete the Parentix setup.',
    canRequestElevation: false,
    sessionOwner: async () => null,
    applyPrivileged: async () => ({
      startup: null,
      stateDirSecured: false,
      problems: ['This computer cannot apply the Parentix security settings.'],
    }),
    verifyPrivileged: async () => ({
      startup: null,
      stateDirSecured: false,
      problems: [],
    }),
  },
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
