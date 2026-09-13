import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A desktop, for the harness to drive.
 *
 * Implements the platform contract with the four OS-specific capabilities under
 * the test's control: the harness decides which application is in front, and
 * records what the agent did about it. Everything above the contract — the
 * agent, the rules, the resolver, the queues, the enforcement decision — is the
 * shipping code.
 *
 * What this does **not** stub is the DNS proxy. The harness runs the real
 * `DnsProxy` on a high port with a real upstream of its own, and sends it real
 * DNS packets, because the wire format is precisely the part of this feature
 * that a mock would agree with while a resolver did not.
 */

export const spy = {
  closed: [],       // { appId, at }
  notifications: [], // { title, body }
  lock: null,        // the last lock state shown, or null when hidden
  lockShows: 0,
  lockHides: 0,
  dnsApplied: 0,
  dnsRestored: 0,
  dnsFlushed: 0,
};

/**
 * Two switches the harness flips to play the part of a tampered-with machine.
 *
 * Separate from `spy`, which records what the agent did; these are inputs
 * rather than observations. They are what makes the tamper checks testable at
 * all — the real signals are a resolver setting and a scheduled task, neither
 * of which exists under plain Node.
 */
export const machine = {
  /** False once "the child" has put DNS back to automatic. */
  dnsStillOurs: true,
  /** `true` | `false` | `null` — the last being "could not tell", see the contract. */
  startupIntact: true,

  // ── First-run setup ────────────────────────────────────────────────────────
  //
  // The privileged half of setup is a UAC token, a scheduled task and an ACL,
  // none of which exist under plain Node — so these stand in for the machine's
  // answers. They are inputs the harness sets, like the two above, rather than
  // observations.

  /** Does this process already hold the permission setup needs? */
  elevated: true,
  /** What happens when setup asks for it: `'grant'` or `'refuse'`. */
  elevationAnswer: 'grant',
  /** Who is at the keyboard, and who the agent is running as. */
  consoleUser: 'HOUSE\\ada',
  currentUser: 'HOUSE\\ada',
  /** Is the child a local administrator? `true` | `false` | `null` (unknown). */
  childIsAdmin: false,
  /** Set by `applyPrivileged`, read back by `verifyPrivileged` — the machine. */
  startupRegistered: false,
  stateDirSecured: false,
};

export function resetMachine() {
  machine.dnsStillOurs = true;
  machine.startupIntact = true;
  machine.elevated = true;
  machine.elevationAnswer = 'grant';
  machine.consoleUser = 'HOUSE\\ada';
  machine.currentUser = 'HOUSE\\ada';
  machine.childIsAdmin = false;
  machine.startupRegistered = false;
  machine.stateDirSecured = false;
}

let _onSample = null;

/** Push a foreground sample at the agent, as the platform watcher would. */
export function emitForeground(sample) {
  _onSample?.(sample);
}

export function resetSpy() {
  spy.closed = [];
  spy.notifications = [];
  spy.lock = null;
  spy.lockShows = 0;
  spy.lockHides = 0;
}

export function createFakePlatform({ dataDir = mkdtempSync(path.join(tmpdir(), 'parentix-desktop-')) } = {}) {
  return {
    id: 'win32',
    osVersion: () => 'Windows 11 Pro 10.0.26200',
    deviceLabel: () => 'TEST-PC · Windows',
    dataDir: () => dataDir,

    /**
     * Plaintext, and only here.
     *
     * The shipping hosts hand this to Electron's `safeStorage` — DPAPI or the
     * Keychain. Neither exists under plain Node, and a harness that skipped the
     * store entirely would not exercise the thing most likely to be wrong: that
     * every cache round-trips, and that an unlink really removes it.
     */
    secureStorage: {
      available: () => true,
      encrypt: (plain) => Buffer.from(plain, 'utf8'),
      decrypt: (cipher) => Buffer.from(cipher).toString('utf8'),
    },

    foreground: {
      supported: true,
      start(onSample) {
        _onSample = onSample;
        return () => { _onSample = null; };
      },
    },

    apps: {
      supported: true,
      async close(appId) {
        spy.closed.push({ appId, at: Date.now() });
        return 1;
      },
    },

    dns: {
      supported: true,
      canConfigure: async () => true,
      // The harness's own upstream, which it runs on the loopback. The real
      // implementations read this off the machine before redirecting it.
      upstreams: async () => ['127.0.0.1'],
      apply: async () => { spy.dnsApplied += 1; machine.dnsStillOurs = true; return true; },
      // The strict form the real implementations use: every connected interface
      // has to be resolving through us, because one that is not is a machine
      // browsing unfiltered while the agent reports filtering as on.
      isApplied: async () => machine.dnsStillOurs,
      restore: async () => { spy.dnsRestored += 1; return true; },
      // Flushing the OS cache needs the machine; here it is just recorded, so a
      // test can prove the filter asks for it when — and only when — a block was
      // added while it was running.
      flushCache: async () => { spy.dnsFlushed += 1; },
    },

    lockScreen: {
      show: (state) => { spy.lock = state; spy.lockShows += 1; },
      hide: () => { spy.lock = null; spy.lockHides += 1; },
    },

    notify: (notification) => { spy.notifications.push(notification); },

    autostart: {
      supported: true,
      enabled: async () => false,
      set: async () => { machine.startupIntact = true; return true; },
      /*
       * Not `enabled`. On Windows the installer starts the agent from an
       * elevated scheduled task, so `enabled` is false on a healthy machine and
       * a tamper check written against it would fire on every install. The
       * harness models the question the watcher actually asks.
       */
      systemIntact: async () => machine.startupIntact,
    },

    permissions: {
      list: async () => [],
      open: async () => {},
    },

    /**
     * First-run setup's privileged half.
     *
     * `verifyPrivileged` reads `machine`, and `applyPrivileged` is the only
     * thing that writes it — so the harness's `finalize` check is asking the
     * same question the shipping one does: not "did the step return without
     * throwing" but "is it there now". A fake that simply returned success
     * would agree with a setup that did nothing.
     */
    setup: {
      supported: true,
      canRequestElevation: true,
      elevationHint: 'Parentix needs administrator permission once, to finish setting up this computer.',

      isElevated: async () => machine.elevated,

      sessionOwner: async () => ({
        console: machine.consoleUser,
        current: machine.currentUser,
        matches: machine.consoleUser.toLowerCase() === machine.currentUser.toLowerCase(),
      }),

      sessionIsAdministrator: async () => machine.childIsAdmin,

      async applyPrivileged({ elevate }) {
        if (!machine.elevated) {
          if (!elevate) throw new Error('Parentix needs administrator permission.');
          // The prompt, answered. A refusal is a rejection from the OS, which is
          // what a cancelled UAC dialog actually is.
          if (machine.elevationAnswer !== 'grant') {
            throw new Error('The Parentix setup could not finish with administrator permission.');
          }
          machine.elevated = true;
        }
        machine.startupRegistered = true;
        machine.stateDirSecured = true;
        return {
          startup: { registered: true, mechanism: 'scheduled-task', detail: 'Parentix will start at sign-in.' },
          stateDirSecured: true,
          problems: [],
        };
      },

      async verifyPrivileged() {
        return {
          startup: { registered: machine.startupRegistered, mechanism: 'scheduled-task' },
          stateDirSecured: machine.stateDirSecured,
          problems: [],
        };
      },
    },
  };
}
