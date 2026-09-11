import { platform } from '../platform/index.js';
import { API_HOST } from '../services/api.js';
import {
  SETUP_STEPS, SETUP_VERSION, getSetupState, runSetup,
} from '../services/setup.js';

/**
 * The first-run setup, as the child-facing window sees it.
 *
 * `services/setup.js` decides what has to happen and whether it worked. This
 * decides what a person watching the screen is told, and when the agent is
 * allowed to carry on — which is a separate question with its own judgement in
 * it:
 *
 * **A failed setup does not stop the agent.** It is tempting to make it a wall,
 * and it would be wrong. Everything except website filtering works without any
 * of the privileged half, and a laptop that shows a child an error screen
 * instead of their day — because a UAC prompt was dismissed, or because the
 * cable was out — is a product a family uninstalls. So a failure leaves a
 * screen they can retry from, and the agent starts behind it.
 *
 * **But it is never quiet.** The record on disk still says the machine is not
 * set up, every subsequent launch tries again, and the screen states in one
 * sentence what is not working and what to do about it. The rule this product
 * has everywhere applies here too: a capability that is off says so, because a
 * parent who has been told monitoring is on is worse off than one who has not.
 *
 * **The window does not wait for the network.** Setup is started and the agent
 * starts with it; the two do not race, because nothing the agent does depends on
 * the privileged half having finished. What the gate below actually waits for is
 * the *first-run* case only — a machine that has never been set up has nothing
 * to show anybody yet, so there is no reason to bring up a link screen behind a
 * setup screen and every reason not to.
 */

/** Retry a setup that stopped on the connectivity step, without anyone asking. */
const AUTO_RETRY_MS = 30_000;

const _state = {
  /** `'idle' | 'running' | 'done' | 'failed' | 'needs-permission'` */
  phase: 'idle',
  reason: null,
  steps: SETUP_STEPS.map(({ key, label }) => ({ key, label, state: 'pending' })),
  error: null,
  failedStep: null,
  /** Can the app raise a prompt for the permission it is missing? */
  canRequestPermission: false,
  hint: null,
  notes: [],
  /** When this installation was last recorded as fully set up. */
  completedAt: null,
};

let _send = () => {};
let _running = null;
let _retryTimer = null;
let _context = {};
/**
 * Resolves once the record on disk has been read and `_state` means something.
 *
 * `setup:status` waits on it. The window is created a few lines after this
 * module is called, and its very first act is to ask what to draw — so without
 * this there is a window in which the honest answer is "we have not looked yet"
 * and the reply would be a phase of `idle`, which renders as the link screen for
 * one frame on a computer that is about to show a setup screen.
 */
let _decided = null;

const publish = () => {
  _send('setup:progress', getSetupView());
};

/** Everything the setup screen renders, in one object. */
export function getSetupView() {
  return {
    ..._state,
    steps: _state.steps.map((step) => ({ ...step })),
    version: SETUP_VERSION,
    apiHost: API_HOST,
  };
}

function resetSteps() {
  _state.steps = SETUP_STEPS.map(({ key, label }) => ({ key, label, state: 'pending' }));
  _state.error = null;
  _state.failedStep = null;
  _state.notes = [];
}

/**
 * Run it once.
 *
 * `elevate` is true only when a person has just pressed the button that says so.
 * A setup that raised a UAC prompt on its own, at every launch, on a computer a
 * child is signed in to, would be the thing that teaches the household to click
 * through prompts without reading them.
 */
async function attempt({ elevate }) {
  if (_running) return _running;

  clearTimeout(_retryTimer);
  resetSteps();
  _state.phase = 'running';
  publish();

  _running = runSetup({
    ..._context,
    elevate,
    onProgress: ({ key, state, detail, error }) => {
      const step = _state.steps.find((candidate) => candidate.key === key);
      if (step) {
        step.state = state;
        step.detail = detail || null;
        step.error = error || null;
      }
      publish();
    },
  }).then((result) => {
    _state.phase = result.ok ? 'done' : 'failed';
    _state.failedStep = result.failed || null;
    _state.error = result.error || null;
    _state.notes = result.record?.securityNotes || [];
    _state.completedAt = result.record?.completedAt || null;

    /**
     * The one failure that is a request rather than a fault.
     *
     * A setup that stopped because it has no administrator permission is not
     * broken — it is waiting for somebody to say yes. It gets its own phase so
     * the screen can lead with the button instead of leading with an error,
     * and so a machine that cannot raise a prompt at all (a Mac, where the
     * helper comes from the installer package) says something a family can act
     * on rather than offering a button that does nothing.
     */
    if (!result.ok && result.needsPermission) _state.phase = 'needs-permission';

    /**
     * A connectivity failure retries itself.
     *
     * This is the interruption the specification calls out and the one a person
     * cannot usefully act on from a button: the laptop is not on the Wi-Fi yet,
     * or the hotel portal has not been signed in to. Plugging the cable in
     * should be enough, without anybody watching the screen having to know to
     * click.
     */
    if (!result.ok && result.failed === 'connect') {
      _retryTimer = setTimeout(() => { attempt({ elevate: false }).catch(() => {}); }, AUTO_RETRY_MS);
      _retryTimer.unref?.();
    }

    publish();
    return result;
  }).finally(() => { _running = null; });

  return _running;
}

/**
 * Decide whether this launch has setup to do, run it, and say when the agent may
 * carry on.
 *
 * Resolves as soon as the agent should start, which is *not* the same moment the
 * setup finishes:
 *
 *   - a machine that has never been set up waits, because there is nothing
 *     behind the setup screen worth showing yet;
 *   - a machine re-running setup after a failed attempt or a version bump does
 *     not, because it already has a credential, rules on disk and a child who
 *     expects their computer to work.
 *
 * @returns {Promise<{needed: boolean, reason: string|null, blocking: boolean}>}
 */
export async function beginFirstRun({
  ipcMain, sendToMain, showMain, exePath, packaged, appVersion,
}) {
  _send = sendToMain;
  _context = { exePath, packaged, appVersion, apiHost: API_HOST };

  /**
   * Handlers first, before any `await`.
   *
   * Everything below this point yields, and the caller creates the window
   * immediately after calling this — `ipcRenderer.invoke` against a channel with
   * no handler rejects at once rather than waiting, so a handler registered a
   * tick too late is a renderer that has already been told there is no setup.
   *
   * Registered whether or not setup is needed: the "This computer" screen reads
   * the same view to show when this machine was set up and what, if anything, is
   * still not working.
   */
  ipcMain.handle('setup:status', async () => {
    await _decided;
    return { ok: true, value: getSetupView() };
  });
  ipcMain.handle('setup:run', async (_event, { elevate = true } = {}) => {
    const result = await attempt({ elevate: !!elevate });
    return { ok: true, value: { ...getSetupView(), completed: result.ok } };
  });
  /**
   * "Carry on without it."
   *
   * Nothing is written when this is pressed. The machine is still not set up and
   * the next launch will still try — all this does is take the screen away,
   * which is the honest amount of power to give a button that cannot grant a
   * permission. It exists because the alternative is a family locked out of the
   * three-quarters of the product that works without one.
   */
  ipcMain.handle('setup:dismiss', () => {
    /**
     * The pending retry goes with it.
     *
     * Without this, a child who pressed "Continue without it" on a laptop that
     * is not on the Wi-Fi gets the setup screen back thirty seconds later, over
     * whatever they had moved on to. They have said "not now"; the next launch
     * is when it asks again.
     */
    clearTimeout(_retryTimer);
    _retryTimer = null;
    _state.phase = 'dismissed';
    publish();
    return { ok: true, value: getSetupView() };
  });

  const decide = getSetupState();
  _decided = decide.catch(() => {});
  const { needed, reason, record } = await decide;
  _state.reason = reason;
  _state.completedAt = record.completedAt || null;
  _state.notes = record.securityNotes || [];

  if (!needed) {
    _state.phase = 'done';
    _state.steps.forEach((step) => { step.state = 'done'; });
    return { needed: false, reason: null, blocking: false };
  }

  /**
   * Whether the screen may offer a button that asks the OS for permission.
   *
   * A Mac cannot: root there comes from the installer package, and a button
   * that raised nothing would be worse than the sentence explaining what to do.
   */
  const p = platform();
  _state.canRequestPermission = !!(p.setup.supported && p.setup.canRequestElevation);
  _state.hint = p.setup.elevationHint;

  showMain();
  publish();

  /**
   * The first attempt asks for no prompt.
   *
   * An installation that went the way it was meant to arrives here already
   * elevated — the installer started the agent from the task it had just
   * created — and there is nothing to ask for. Only a machine that got here
   * some other way sees a button, and only after the silent attempt has
   * established that it is genuinely needed.
   */
  const first = attempt({ elevate: false });

  const blocking = reason === 'first-run';
  if (blocking) await first.catch(() => {});

  return { needed: true, reason, blocking };
}

export function stopFirstRun() {
  clearTimeout(_retryTimer);
  _retryTimer = null;
}

export const __testing = { state: _state, attempt };
