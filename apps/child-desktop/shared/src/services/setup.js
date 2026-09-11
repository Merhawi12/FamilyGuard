import { randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { platform } from '../platform/index.js';
import { API_HOST, device, health } from './api.js';
import { hasLink } from './link.js';
import { getItem, removeItem, setItem } from './store.js';
import { LOCAL_DNS_PORT, getWebFilterStatus } from './webFilter.js';

/**
 * Setting this computer up, once, without asking a family to understand any of
 * it.
 *
 * The agent has always done this work — it created its directories the first
 * time it wrote to them, redirected the resolver the first time it started a
 * filter, and relied on the installer for the scheduled task. That is fine right
 * up until one of those silently does not happen, because every one of them
 * fails in the same shape: the app comes up, looks healthy, links, shows a
 * dashboard — and quietly monitors nothing. A parent has no way to tell that
 * apart from a well-behaved child.
 *
 * So the same work is done **once, in the open, in a stated order, and
 * verified**, and the machine is only recorded as set up when every step has
 * been read back off the machine rather than assumed from the fact that we
 * asked for it.
 *
 * ── Four rules this file is built around ─────────────────────────────────────
 *
 * **`setupCompleted` is written last, from evidence.** Not from "no exception
 * was thrown" — the `finalize` step re-reads the config file, the credential
 * store and the machine's own task list. A setup that half-worked must come back
 * as unfinished on the next launch, because the alternative is a permanently
 * half-configured computer that believes it is done.
 *
 * **Every step is idempotent, so recovery is just running it again.** A restart
 * mid-setup, a crash, a flat battery, a cancelled UAC prompt: the next launch
 * finds `setupCompleted` false and runs the whole list from the top. There is no
 * resume state to get wrong, and nothing is left half-applied in between.
 *
 * **The record holds no secrets.** It is a plain JSON file, deliberately
 * readable — it is what a support call reads out over the phone, the same
 * reasoning as `dns-backup.json`. The device token stays where it has always
 * been: in the OS-encrypted store. The install identifier lives here because it
 * is an opaque name for this installation and authenticates nothing.
 *
 * **An update is not a first run.** The record survives in `userData`, which the
 * Windows uninstaller only clears on a real uninstall (electron-builder guards
 * `deleteAppDataOnUninstall` with its `isUpdated` flag). A new version re-runs
 * the list only when it raises `SETUP_VERSION`, and then only because something
 * genuinely new has to be put in place.
 */

/**
 * Raise this when a new version has machine-level work to do that an existing
 * installation has never had done — a new startup entry, a new directory, a
 * permission that has to be re-applied.
 *
 * Every step is idempotent, so a bump re-runs all of them rather than needing a
 * migration list. What it must not be is a version number that tracks the app's:
 * an ordinary release has nothing to set up, and re-running setup on every
 * update would put a progress screen in front of a child for no reason.
 */
export const SETUP_VERSION = 1;

/**
 * The steps, as the setup screen lists them.
 *
 * Exported as plain data so the window can draw the whole list — all five, with
 * the ones still to come shown as pending — before the first one runs. A screen
 * that grows a line at a time reads as a program discovering what it has to do.
 */
export const SETUP_STEPS = Object.freeze([
  { key: 'components', label: 'Installing Parentix components' },
  { key: 'device', label: 'Configuring device' },
  { key: 'connect', label: 'Connecting to Parentix' },
  { key: 'security', label: 'Applying security settings' },
  { key: 'finalize', label: 'Finalizing setup' },
]);

const RECORD_FILE = 'setup-state.json';
const CONFIG_FILE = 'config.json';
const LOG_FILE = path.join('logs', 'setup.log');

/** A log nobody prunes is a disk nobody has left. Rewritten from the tail. */
const LOG_MAX_BYTES = 256 * 1024;

/** The store key the `components` step round-trips, and removes again. */
const PROBE_KEY = 'fg_setup_probe';

const dataDir = () => platform().dataDir();
const recordPath = () => path.join(dataDir(), RECORD_FILE);
const configPath = () => path.join(dataDir(), CONFIG_FILE);
const stateDir = () => path.join(dataDir(), 'state');
const logPath = () => path.join(dataDir(), LOG_FILE);

/**
 * Nothing that could be a credential reaches the setup log.
 *
 * The log exists to make a failed setup diagnosable over the phone, which means
 * it will be read out loud and pasted into a support ticket. Only error
 * *messages* are ever written — never a value read from the store — but an
 * axios error can carry a URL, and a URL can carry a token, so the belt is here
 * as well as the braces.
 */
export function redact(text) {
  return String(text ?? '')
    .replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted token]')
    .replace(/([?&](?:token|code|key|secret|password|auth)=)[^&\s]+/gi, '$1[redacted]');
}

async function writeLog(line) {
  try {
    await fs.mkdir(path.dirname(logPath()), { recursive: true });
    let existing = '';
    try {
      const stat = await fs.stat(logPath());
      if (stat.size > LOG_MAX_BYTES) {
        // Keep the recent half. The interesting part of a setup log is always
        // the most recent attempt, and the first attempt is weeks old by the
        // time anybody asks for it.
        const whole = await fs.readFile(logPath(), 'utf8');
        existing = `${whole.slice(-Math.floor(LOG_MAX_BYTES / 2))}\n`;
        await fs.writeFile(logPath(), existing, 'utf8');
      }
    } catch { /* no log yet */ }
    await fs.appendFile(logPath(), `${new Date().toISOString()}  ${redact(line)}\n`, 'utf8');
  } catch {
    // A setup that cannot write its own log still has to run. The log is
    // evidence, not a step.
  }
}

// ── The record ────────────────────────────────────────────────────────────────

const emptyRecord = () => ({
  version: 0,
  setupCompleted: false,
  installId: null,
  attempts: 0,
  startedAt: null,
  completedAt: null,
  lastError: null,
  steps: {},
});

/**
 * What this installation has been through, or a blank record.
 *
 * A record that will not parse is treated as absent rather than fatal: a
 * half-written JSON file after a power cut is exactly the moment the machine
 * must fall back to "set me up again", and every step is safe to repeat.
 */
export async function readSetupRecord() {
  try {
    const parsed = JSON.parse(await fs.readFile(recordPath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyRecord();
    return { ...emptyRecord(), ...parsed, steps: { ...(parsed.steps || {}) } };
  } catch {
    return emptyRecord();
  }
}

async function writeSetupRecord(record) {
  await fs.mkdir(dataDir(), { recursive: true });
  const temp = `${recordPath()}.tmp`;
  // Written beside and renamed over, for the same reason the encrypted store
  // does it: a record torn in half by a power cut during setup would be read
  // back on the next boot, and this one decides whether setup runs again.
  await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await fs.rename(temp, recordPath());
}

/**
 * Does this launch have to set anything up, and why?
 *
 * `'first-run'` — nothing has ever been recorded here. A fresh install, or a
 *   reinstall after the uninstaller took `userData` with it.
 * `'incomplete'` — a previous attempt did not finish. A restart mid-setup, a
 *   refused UAC prompt, a laptop with no network yet.
 * `'update'` — this build raised `SETUP_VERSION` over a machine that was
 *   already set up, so there is new machine-level work to do.
 */
export async function getSetupState() {
  const record = await readSetupRecord();
  if (!record.setupCompleted) {
    return { needed: true, reason: record.attempts > 0 ? 'incomplete' : 'first-run', record };
  }
  if (Number(record.version) !== SETUP_VERSION) {
    return { needed: true, reason: 'update', record };
  }
  return { needed: false, reason: null, record };
}

// ── The steps ─────────────────────────────────────────────────────────────────

/**
 * Can the local resolver's port actually be taken on this machine?
 *
 * Asked here rather than discovered later, because the way this fails is the
 * quietest failure in the product: another DNS proxy, a corporate agent, Docker,
 * or a Windows reserved port range holds 53, the filter never starts, and
 * website blocking reports itself off on a screen nobody opens. Answering it at
 * setup time turns that into a sentence a parent reads on the day they install.
 *
 * The probe binds and closes immediately — it is a question, not a reservation,
 * and holding it would be the thing that stopped the filter starting.
 */
function probeDnsPort(port = LOCAL_DNS_PORT) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    const done = (result) => {
      // A socket that failed to bind still holds a handle; close it either way.
      try { socket.close(); } catch { /* already closed */ }
      resolve(result);
    };
    socket.once('error', (err) => done({ ok: false, code: err.code || 'EFAIL', message: err.message }));
    socket.once('listening', () => done({ ok: true }));
    try {
      socket.bind(port, '127.0.0.1');
    } catch (err) {
      done({ ok: false, code: err.code || 'EFAIL', message: err.message });
    }
  });
}

/**
 * Create the directories, and prove the credential store works before anything
 * depends on it.
 *
 * The round-trip is the point. `safeStorage` reports itself unavailable on a
 * machine whose keychain is locked or whose profile has no DPAPI master key, and
 * `store.js` refuses to write a credential in the clear when that happens — so a
 * computer in that state can never link, and the failure would otherwise arrive
 * later as "that code was not recognised" with nothing to connect it to.
 */
async function stepComponents() {
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.mkdir(stateDir(), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(logPath()), { recursive: true });

  if (!platform().secureStorage.available()) {
    throw new Error(
      'This computer cannot store the Parentix credential securely, so Parentix cannot link to a family here.',
    );
  }

  const probe = `probe-${Date.now()}`;
  await setItem(PROBE_KEY, probe);
  const readBack = await getItem(PROBE_KEY);
  await removeItem(PROBE_KEY);
  if (readBack !== probe) {
    throw new Error('Parentix could not write to its own storage on this computer.');
  }

  return 'Folders created and secure storage checked.';
}

/**
 * The installation's own name for itself, and the facts a support call needs.
 *
 * The identifier is generated once and then left alone for the life of the
 * install — a new one on every launch would be a different computer every time,
 * which is worse than none. It is not a credential and does not authenticate
 * anything; it exists so two installations on one machine, or an installation
 * that has been re-linked to a second child, can be told apart in a log.
 */
async function stepDevice(record) {
  const p = platform();
  if (!record.installId) record.installId = randomUUID();

  const config = {
    installId: record.installId,
    platform: p.id,
    osVersion: p.osVersion(),
    deviceLabel: p.deviceLabel(),
    appVersion: record.appVersion || null,
    apiHost: record.apiHost || null,
    installedAt: record.installedAt || new Date().toISOString(),
    setupVersion: SETUP_VERSION,
  };
  record.installedAt = config.installedAt;

  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return `Identified as ${config.deviceLabel}.`;
}

/**
 * Can this computer reach Parentix, and is what it already holds still good?
 *
 * Two separate questions, and only the first one can fail the setup. A machine
 * with no link yet is the ordinary case — somebody has to read out a code — and
 * a machine whose link the parent removed while it was switched off has to come
 * up on the link screen rather than stuck on a setup screen it can never pass.
 */
async function stepConnect() {
  try {
    await health();
  } catch (error) {
    /**
     * The library's sentence is never the one shown.
     *
     * `timeout of 20000ms exceeded` is true and useless: it names neither what
     * was being reached nor what anybody should do. The two cases are worth
     * separating because only one of them is the family's to fix — a laptop that
     * is not on the Wi-Fi yet, against a backend having a bad afternoon.
     */
    throw new Error(error.response
      ? `Parentix reached ${API_HOST} but it is not answering yet. This usually clears on its own — Parentix will keep trying.`
      : `Parentix could not reach ${API_HOST}. Check this computer’s internet connection; Parentix will keep trying.`);
  }

  if (await hasLink()) {
    try {
      await device.heartbeat();
      return 'Connected, and this computer is still linked.';
    } catch {
      // A 401 here has already cleared the credential through the API client's
      // own interceptor, which is what puts the link screen back in front of the
      // child. Anything else is a network hiccup on a call we did not need.
      return 'Connected to Parentix.';
    }
  }
  return 'Connected to Parentix. Waiting for a linking code.';
}

/**
 * The half that needs permission: start-at-sign-in, and locking down the folder
 * holding the credential.
 *
 * This is the only step that can be blocked by the machine rather than by a bug,
 * and the three ways it is blocked are distinguished because a family can act on
 * two of them:
 *
 *   - **No permission yet.** Answerable: `elevate` asks the OS, which on Windows
 *     is a UAC prompt and on macOS is nothing the app can raise at all.
 *   - **Running as the wrong account.** A parent typed their own administrator
 *     password at a prompt on the child's desktop, so this process is *them* —
 *     and everything it stores, including the credential and this very record,
 *     is landing in the parent's profile rather than the child's. Refused,
 *     loudly, because completing would silently set up the wrong account.
 *   - **The resolver port is taken.** Reported, not refused: everything except
 *     website filtering still works, and a machine that will not finish setup
 *     over it would be worse off than one that is told.
 */
async function stepSecurity(record, { exePath, packaged, elevate }) {
  const p = platform();
  const owner = await p.setup.sessionOwner().catch(() => null);

  // `null` is "could not tell" — a machine with nobody at the console, a remote
  // session, fast user switching. Not knowing is not evidence, so it is left
  // alone rather than treated as a mismatch.
  if (owner && owner.matches === false) {
    throw new Error(
      `Parentix is running as ${owner.current}, but ${owner.console} is signed in to this computer. `
      + `Sign in as ${owner.console} and start Parentix there, so it sets up their account.`,
    );
  }

  if (!(await p.setup.isElevated())) {
    if (!elevate || !p.setup.canRequestElevation) {
      const error = new Error(p.setup.elevationHint);
      /**
       * Marked, because the screen leads with a different thing.
       *
       * "Parentix needs permission" is a request and gets a button; "the task
       * could not be registered" is a fault and gets an error. They arrive at
       * the same step and look identical from the outside, so the difference is
       * carried rather than guessed at from the message.
       */
      error.needsPermission = true;
      throw error;
    }
  }

  const result = await p.setup.applyPrivileged({
    stateDir: stateDir(),
    // Null on a development build, which asks the platform for the folder
    // permissions and nothing else. A startup entry pointing at a developer's
    // `electron.exe` would launch a bare Electron at every sign-in on their own
    // machine, which is a poor thing to leave behind.
    exePath: packaged ? exePath : null,
    user: owner?.console || owner?.current || null,
    elevate: !!elevate,
  });

  /**
   * Start-at-sign-in, by whichever mechanism this platform has.
   *
   * `startup: null` means the platform has no privileged arrangement and the
   * ordinary login item is the right answer — which is macOS, where the app
   * writes its own. On Windows it is a scheduled task, because Windows will not
   * auto-start an elevated application from the Run key at all; the login item
   * is the fallback when the task could not be created, and it is a real one,
   * just unelevated and therefore unable to filter websites.
   */
  let startup = result.startup;
  if (!startup?.registered) {
    if (!packaged) {
      startup = { registered: false, mechanism: null, detail: 'Development build — no startup entry was created.' };
    } else if (p.autostart.supported && await p.autostart.set(true).catch(() => false)) {
      startup = {
        registered: true,
        mechanism: 'login-item',
        detail: startup?.registered === false
          ? 'Parentix will start at sign-in, but without administrator access.'
          : 'Parentix will start at sign-in.',
      };
    } else {
      throw new Error('Parentix could not arrange to start when this computer is switched on.');
    }
  }
  record.startup = startup;
  record.stateDirSecured = !!result.stateDirSecured;

  /**
   * The port question, asked only when nobody has answered it already.
   *
   * A setup re-run on a machine that is up and filtering — a version bump, or
   * somebody pressing "Try again" — would find the port held by *this agent's
   * own resolver* and report a conflict with itself. "Another program is using
   * the name-lookup port" is exactly the sort of alarming, wrong sentence that
   * teaches a family to stop reading them.
   */
  const port = getWebFilterStatus().running ? { ok: true, heldByUs: true } : await probeDnsPort();
  record.dnsPort = { port: LOCAL_DNS_PORT, ...port };

  const notes = [...(result.problems || [])];
  if (!result.stateDirSecured) {
    // Not a failure: on a machine where the permissions cannot be tightened —
    // a policy, a roaming profile, a filesystem with no ACLs — the folder is
    // still inside the child's own profile and the credential is still sealed
    // by the OS. What would be wrong is not saying so.
    notes.push('Parentix could not tighten the permissions on the folder holding this computer’s credential.');
  }
  if (!port.ok) {
    notes.push(
      `Another program on this computer is using the name-lookup port (${port.code}), `
      + 'so Parentix cannot filter websites here.',
    );
  }
  record.securityNotes = notes;

  return notes.length
    ? `${startup.detail || 'Start-at-sign-in is registered.'} ${notes.join(' ')}`
    : (startup.detail || 'Start-at-sign-in is registered, and the credential folder is locked down.');
}

/**
 * Read it all back off the machine.
 *
 * This is what makes `setupCompleted` mean something. Every check here asks the
 * operating system or the filesystem rather than the record that is about to be
 * written — a step that reported success and left nothing behind is precisely
 * the failure this whole file exists to stop being invisible.
 */
async function stepFinalize(record, { packaged }) {
  const p = platform();

  const config = JSON.parse(await fs.readFile(configPath(), 'utf8'));
  if (!config.installId || config.installId !== record.installId) {
    throw new Error('The Parentix configuration file was not written correctly.');
  }

  await fs.access(stateDir());

  const verified = await p.setup.verifyPrivileged({ stateDir: stateDir() }).catch(() => null);
  if (!verified) throw new Error('Parentix could not confirm this computer’s settings.');

  /**
   * The login item counts, and the scheduled task counts, and on a development
   * build neither is expected — but a *packaged* install that ends up with
   * neither is a computer that will never start Parentix again on its own, which
   * is an install that has not happened.
   */
  const startupOk = verified.startup?.registered
    || record.startup?.mechanism === 'login-item'
    || !packaged;
  if (!startupOk) {
    throw new Error('Parentix is not registered to start when this computer is switched on.');
  }

  record.verified = {
    at: new Date().toISOString(),
    startup: verified.startup || record.startup || null,
    stateDirSecured: !!verified.stateDirSecured,
  };
  return 'Everything checked.';
}

const RUNNERS = {
  components: (record) => stepComponents(record),
  device: (record) => stepDevice(record),
  connect: () => stepConnect(),
  security: (record, ctx) => stepSecurity(record, ctx),
  finalize: (record, ctx) => stepFinalize(record, ctx),
};

// ── Running it ────────────────────────────────────────────────────────────────

/**
 * Run the whole list, top to bottom, stopping at the first step that fails.
 *
 * @param {object} options
 * @param {(event: {key: string, label: string, state: 'running'|'done'|'failed',
 *   detail?: string, error?: string}) => void} [options.onProgress]
 * @param {string} [options.exePath]   what a startup entry should launch
 * @param {boolean} [options.packaged] false in development, where no startup
 *   entry is created and none is expected
 * @param {boolean} [options.elevate]  may this ask the OS for permission? Only
 *   ever true when somebody has just pressed a button asking for exactly that.
 * @param {string} [options.appVersion]
 * @param {string} [options.apiHost]
 * @returns {Promise<{ok: boolean, record: object, failed?: string, error?: string}>}
 */
export async function runSetup({
  onProgress = () => {}, exePath = null, packaged = false, elevate = false,
  appVersion = null, apiHost = null,
} = {}) {
  const record = await readSetupRecord();
  const previously = record.setupCompleted;

  record.attempts = Number(record.attempts || 0) + 1;
  record.startedAt = new Date().toISOString();
  record.version = SETUP_VERSION;
  record.appVersion = appVersion || record.appVersion || null;
  record.apiHost = apiHost || record.apiHost || null;
  record.lastError = null;
  /**
   * Cleared before the first step, not after the last.
   *
   * A run that is interrupted has to come back as unfinished, and the only way
   * to guarantee that is for the flag to be false for the whole of the time the
   * machine is actually being changed. Leaving the previous `true` in place
   * while steps re-ran would mean a computer killed in the middle of an upgrade
   * migration came back believing it was done.
   */
  record.setupCompleted = false;
  await writeSetupRecord(record).catch(() => {});
  await writeLog(`setup started (attempt ${record.attempts}${previously ? ', re-running after an update' : ''})`);

  const ctx = { exePath, packaged, elevate };

  for (const { key, label } of SETUP_STEPS) {
    onProgress({ key, label, state: 'running' });
    try {
      const detail = await RUNNERS[key](record, ctx);
      record.steps[key] = { ok: true, at: new Date().toISOString(), detail: detail || null };
      await writeSetupRecord(record).catch(() => {});
      await writeLog(`  ok   ${key} — ${detail || ''}`);
      onProgress({ key, label, state: 'done', detail });
    } catch (error) {
      const message = redact(error?.message || 'Something went wrong.');
      record.steps[key] = { ok: false, at: new Date().toISOString(), error: message };
      record.lastError = { step: key, message, at: new Date().toISOString() };
      await writeSetupRecord(record).catch(() => {});
      await writeLog(`  FAIL ${key} — ${message}`);
      onProgress({ key, label, state: 'failed', error: message });
      return { ok: false, record, failed: key, error: message, needsPermission: !!error?.needsPermission };
    }
  }

  record.setupCompleted = true;
  record.completedAt = new Date().toISOString();
  await writeSetupRecord(record);
  await writeLog('setup completed');
  return { ok: true, record };
}

/**
 * Forget that this computer was ever set up.
 *
 * Only the uninstaller's job in production — it takes `userData` with it — but
 * the harness needs a way back to a first run, and a support conversation
 * occasionally needs one too.
 */
export async function resetSetupState() {
  await fs.unlink(recordPath()).catch(() => {});
  await fs.unlink(configPath()).catch(() => {});
}

export const __testing = {
  probeDnsPort, recordPath, configPath, logPath, stateDir, PROBE_KEY,
};
