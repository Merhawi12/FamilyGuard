import { promises as fs } from 'node:fs';
import os from 'node:os';
import { dns } from './dns.js';
import { run } from './shell.js';

/**
 * First-run setup on a Mac, where almost none of it is privileged.
 *
 * This is the mirror image of `windows/src/platform/setup.js`, and the shape of
 * the difference is worth stating because it decides what the setup screen is
 * allowed to block on.
 *
 * **Nothing the setup itself does needs root.** The login item is written by the
 * app, into the app's own account; the state directory is inside the user's
 * Library; `chmod 700` is a change to a file the user owns. So `isElevated`
 * answers true — meaning "the privileged half of setup can be done now" — and
 * the setup finishes on any Mac.
 *
 * **What needs root is the running filter, and the app cannot install it.** The
 * resolver change goes through a launchd daemon that the `.pkg` puts in place;
 * a GUI app cannot write `/Library/LaunchDaemons` and should not be able to. Its
 * absence is a fact about the machine — a `.dmg` copy rather than a `.pkg`
 * install, or a helper somebody removed — and it is reported as a note the
 * setup carries, not as a step that fails. Blocking here would leave a Mac that
 * measures screen time, closes blocked apps, carries the family chat and shows
 * a lock screen sitting for ever on a setup screen it has no way to pass.
 *
 * The child already sees the truth of it in "This computer": `permissions.js`
 * lists the helper, and website blocking and web history report themselves as
 * unavailable rather than as monitors that are merely off.
 */

const STATE_MODE = 0o700;

/**
 * Who is at the console, and who are we?
 *
 * A GUI agent on macOS runs as the person who is signed in — there is no
 * over-the-shoulder equivalent of the Windows case this guards against — so
 * these agree on every healthy Mac. It is asked anyway rather than assumed:
 * agreeing for a reason that is checked is worth more than agreeing because a
 * file says so, and the shared setup step reads the same field on both
 * platforms.
 */
async function sessionOwner() {
  const current = os.userInfo().username;
  try {
    // The owner of /dev/console is the user of the graphical session, which is
    // the question being asked. `stat -f%Su` is the documented way to read it.
    const out = await run('/usr/bin/stat', ['-f%Su', '/dev/console']);
    const console_ = String(out || '').trim();
    if (!console_ || console_ === 'root') return null;
    return { console: console_, current, matches: console_ === current };
  } catch {
    // A machine that will not answer is left alone: not knowing is not evidence.
    return null;
  }
}

export const setup = {
  supported: true,

  /**
   * True, and deliberately not `dns.canConfigure()`.
   *
   * Everything this module does is unprivileged. Answering with the helper's
   * presence would tie *finishing setup* to a component the app cannot install,
   * which is the one thing a first-run screen must never do — see the note at
   * the top.
   */
  isElevated: async () => true,

  elevationHint:
    'Parentix could not finish setting up this Mac. Reinstall Parentix and allow the helper when macOS asks.',

  /** There is no prompt to raise: the helper comes from the installer package. */
  canRequestElevation: false,

  sessionOwner,

  async applyPrivileged({ stateDir }) {
    const problems = [];

    let stateDirSecured = false;
    try {
      await fs.mkdir(stateDir, { recursive: true, mode: STATE_MODE });
      // Re-asserted rather than left to `mkdir`, whose mode is masked by umask
      // and silently ignored on a directory that already exists — which is
      // every run after the first.
      await fs.chmod(stateDir, STATE_MODE);
      stateDirSecured = true;
    } catch (error) {
      problems.push(`Parentix could not lock down its credential folder: ${error.message}`);
    }

    if (!(await dns.canConfigure().catch(() => false))) {
      problems.push(
        'The Parentix website-filtering helper is not installed on this Mac, '
        + 'so websites cannot be blocked or recorded here.',
      );
    }

    /**
     * `null`, not a failure.
     *
     * macOS has no privileged startup arrangement to make: the app writes its
     * own login item, and the shared step does exactly that when this is null.
     * Windows returns a scheduled task here because the Run key cannot start an
     * elevated app at all.
     */
    return { startup: null, stateDirSecured, problems };
  },

  async verifyPrivileged({ stateDir }) {
    const problems = [];
    let stateDirSecured = false;
    try {
      const stat = await fs.stat(stateDir);
      // Nothing for the group, nothing for everyone else. Read off the
      // filesystem rather than remembered from the chmod above, because the
      // question is what the machine is, not what we asked it to be.
      stateDirSecured = (stat.mode & 0o077) === 0;
    } catch (error) {
      problems.push(`Parentix could not read its own credential folder: ${error.message}`);
    }
    return { startup: null, stateDirSecured, problems };
  },
};

export const __testing = { sessionOwner, STATE_MODE };
