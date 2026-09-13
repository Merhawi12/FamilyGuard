import { isElevated } from './processes.js';
import { setup } from './setup.js';

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
 * the process starts. First-run setup gets the permission for a short-lived
 * *helper* — which is how the sign-in task gets created (see `setup.js`) — and
 * the agent that task starts is elevated from its first instruction. So this
 * state means the agent was launched some other way, and the fix is to sign out
 * and back in rather than a click here.
 */
export const permissions = {
  async list() {
    const elevated = await isElevated();
    const list = [{
      key: 'administrator',
      label: 'Administrator access',
      granted: elevated,
      why: elevated
        ? 'Parentix can filter websites on this computer.'
        : 'Without this, Parentix cannot block websites or record web history here. '
          + 'Parentix has it when this computer starts it at sign-in, so signing out and back in is what turns it on.',
      // Nothing to open: Windows has no settings pane that grants this.
      openable: false,
    }];

    /**
     * The account being a Windows administrator is stated here as well as sent
     * to the parent, because a child is entitled to know what Parentix can and
     * cannot do on their computer — the same premise as the rest of this screen.
     * Only shown when it is a clean yes: `null` (a domain account, a machine that
     * would not answer) says nothing rather than guessing.
     */
    const isAdmin = await setup.sessionIsAdministrator().catch(() => null);
    if (isAdmin === true) {
      list.push({
        key: 'standard-account',
        label: 'Standard Windows account',
        granted: false,
        why: 'This computer is signed in to an administrator account, so Parentix here works by agreement rather '
          + 'than by force. A parent has been told; they can switch it to a standard account to make the controls hold.',
        openable: false,
      });
    }
    return list;
  },

  async open() {
    // Deliberately empty. `openable: false` above means the window never offers
    // a button, and a handler that opened something arbitrary would be a worse
    // answer than none.
  },
};
