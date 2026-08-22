import { dns } from './dns.js';

/**
 * What macOS makes Parentix ask for, which is less than you would expect.
 *
 * Screen-time measurement and app blocking need **no TCC consent at all** on
 * this platform, and that is the result of two deliberate choices rather than an
 * accident: `foreground.js` reads the frontmost app from LaunchServices instead
 * of driving System Events, and `processes.js` closes an app with a signal
 * instead of an AppleScript `quit`. Both of the alternatives would have raised
 * *"Parentix wants to control System Events"* on first use — a dialog a child
 * can refuse, that macOS never asks again, and that would leave the parent
 * looking at a monitoring screen with nothing on it.
 *
 * What is left is one thing, and it is genuinely privileged: changing the
 * machine's DNS servers, which is what website blocking and web history are
 * built on. That needs root, so it lives in a launchd helper the installer puts
 * in place. Without the helper, those two features do not run and this says so.
 */
export const permissions = {
  async list() {
    const installed = await dns.canConfigure();
    return [{
      key: 'dns-helper',
      label: 'Website filtering helper',
      granted: installed,
      why: installed
        ? 'Parentix can filter websites on this Mac.'
        : 'Without this, Parentix cannot block websites or record web history here. Ask your parent to reinstall Parentix and allow the helper when macOS asks.',
      // Nothing to open: this is installed by the .pkg, not granted in Settings.
      openable: false,
    }];
  },

  async open() {
    // Deliberately empty — see `openable: false` above.
  },
};
