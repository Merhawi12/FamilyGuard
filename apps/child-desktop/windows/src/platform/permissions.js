import { isElevated } from './processes.js';

/**
 * What Windows makes Parentix ask for, which is one thing.
 *
 * There is no consent prompt for reading the foreground window or for closing a
 * process a user owns — a Windows application can do both in an ordinary user
 * session. The one gate is machine-wide settings, and it is a hard one:
 * `Set-DnsClientServerAddress` needs an administrator, so on a machine where the
 * agent is not elevated, website blocking and web history do not run.
 *
 * That is reported rather than hidden. A monitoring product whose website filter
 * is silently off is worse than one that has none, because the parent is told it
 * is on — the same rule the mobile app's `supported` flags exist for.
 *
 * **There is no "make me an administrator" button, and there cannot be.** UAC
 * elevation is not something a running process grants itself; it is decided when
 * the process starts. The installer requests it and installs the login item that
 * way, so this state means somebody launched the agent by hand from a standard
 * session — and the fix is to sign out and back in, not a click.
 */
export const permissions = {
  async list() {
    const elevated = await isElevated();
    return [{
      key: 'administrator',
      label: 'Administrator access',
      granted: elevated,
      why: elevated
        ? 'Parentix can filter websites on this computer.'
        : 'Without this, Parentix cannot block websites or record web history here. Sign out and back in, or ask your parent to reinstall Parentix.',
      // Nothing to open: Windows has no settings pane that grants this.
      openable: false,
    }];
  },

  async open() {
    // Deliberately empty. `openable: false` above means the window never offers
    // a button, and a handler that opened something arbitrary would be a worse
    // answer than none.
  },
};
