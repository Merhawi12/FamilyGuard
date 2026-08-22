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
};

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
      apply: async () => { spy.dnsApplied += 1; return true; },
      restore: async () => { spy.dnsRestored += 1; return true; },
    },

    lockScreen: {
      show: (state) => { spy.lock = state; spy.lockShows += 1; },
      hide: () => { spy.lock = null; spy.lockHides += 1; },
    },

    notify: (notification) => { spy.notifications.push(notification); },

    autostart: {
      supported: true,
      enabled: async () => false,
      set: async () => true,
    },

    permissions: {
      list: async () => [],
      open: async () => {},
    },
  };
}
