import { cssVariables } from '../theme.js';

/**
 * The child-facing window.
 *
 * Plain modules and DOM, with no framework and no build step. That is a
 * deliberate choice rather than an omission: this window is four views, it has
 * to open instantly on a laptop that a child is already annoyed with, and adding
 * a bundler here would mean a third build pipeline in a repository that already
 * has Vite for the web tier and Metro for the phones — for a UI that has no
 * state worth a state library.
 *
 * Everything it knows arrives from the agent through `window.parentix`, and it
 * re-renders whole sections rather than diffing. At this size that is both
 * simpler and impossible to get subtly wrong.
 */

const bridge = window.parentix;
const app = document.getElementById('app');

// The palette comes from theme.js so the stylesheet never repeats a hex.
const style = document.createElement('style');
style.textContent = cssVariables();
document.head.prepend(style);

let status = null;
let tab = 'home';
/** `{ current, pending, … }` from the updater — see `versionFact`. */
let updateStatus = null;
/** `{ phase, steps, … }` from firstRun.js — see `renderSetup`. */
let setupView = null;

// ── Small helpers ─────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

/** 135 → "2h 15m". Whole hours drop the minutes; under an hour drops the hours. */
function formatDuration(minutes) {
  const total = Math.max(0, Math.round(minutes || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Every string that reaches the DOM goes through here.
 *
 * App names and window titles come off the machine, message text comes from a
 * parent, and domains come from the rules — none of it is ours. `textContent`
 * rather than `innerHTML`, everywhere, so none of it can ever be markup.
 */
function row({ title, sub, pill, tone }) {
  const li = document.createElement('li');
  li.className = 'row';

  const text = document.createElement('div');
  text.className = 'row-text';
  const t = document.createElement('span');
  t.className = 'row-title';
  t.textContent = title;
  text.append(t);
  if (sub) {
    const s = document.createElement('span');
    s.className = 'row-sub';
    s.textContent = sub;
    text.append(s);
  }
  li.append(text);

  if (pill) {
    const p = document.createElement('span');
    p.className = 'pill';
    if (tone) p.dataset.tone = tone;
    p.textContent = pill;
    li.append(p);
  }
  return li;
}

const fill = (element, children) => {
  element.replaceChildren(...children);
};

// ── Views ─────────────────────────────────────────────────────────────────────

/**
 * Is the setup screen the thing this window should be showing?
 *
 * `dismissed` is the child having pressed "Continue without it", and it is
 * deliberately a fact about this window rather than about the machine: nothing
 * was written, the next launch will try again, and the "This computer" screen
 * goes on saying what is not working. All the button does is stop a screen
 * standing between a family and the three-quarters of the product that works
 * without the permission it is waiting for.
 */
const setupShowing = () =>
  !!setupView && ['running', 'failed', 'needs-permission'].includes(setupView.phase);

function renderShell() {
  const linked = !!status?.linked;
  const setup = setupShowing();
  $('nav').hidden = !linked || setup;
  app.dataset.view = setup ? 'setup' : (linked ? tab : 'link');

  for (const button of document.querySelectorAll('.nav-item')) {
    if (button.dataset.tab === tab) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }

  /**
   * "Connected" here means the rules this computer is enforcing are current.
   *
   * A sync that has been failing is shown as offline even though the process is
   * perfectly healthy, because from the child's point of view those are the same
   * situation and the alternative — a green light over stale rules — is the one
   * that is actually misleading.
   */
  const fresh = status?.sync?.lastSyncAt && !status?.sync?.lastError;
  $('conn-dot').dataset.state = fresh ? 'online' : 'offline';
  $('conn-label').textContent = !status?.linked
    ? 'Not linked'
    : (fresh ? 'Linked' : 'Reconnecting…');
}

/**
 * The setup screen.
 *
 * Three states and one screen, because a family watching it does not care that
 * they are different code paths: it is working, it needs a permission, or it
 * could not finish. What changes between them is the heading, at most two
 * buttons, and whether there is a sentence in red.
 */
const STEP_MARKS = { pending: '·', running: '…', done: '✓', failed: '✗' };

function renderSetup() {
  const view = setupView || {};
  const phase = view.phase;
  const updating = view.reason === 'update';

  $('setup-eyebrow').textContent = updating ? 'Update' : 'Setting up';
  $('setup-title').textContent = {
    running: updating ? 'Finishing an update…' : 'Setting up Parentix…',
    'needs-permission': 'Parentix needs permission',
    failed: 'Setup did not finish',
  }[phase] || 'Setting up Parentix…';

  /**
   * The lead says something the step list does not.
   *
   * The failing row already carries the sentence explaining what went wrong, so
   * this one says what it means — what still works, and that nothing was left
   * half-changed. Repeating the error here, which is what a banner under the
   * list amounts to, is the same words three times on one screen.
   */
  $('setup-lead').textContent = {
    running: updating
      ? 'This version has a little more to set up. Nothing to do.'
      : 'This happens once. You do not need to do anything.',
    'needs-permission': 'Without it, Parentix cannot block websites or record web history on this computer. Everything else works.',
    failed: 'Nothing on this computer was left half-changed. You can try again.',
  }[phase] || '';

  fill($('setup-steps'), (view.steps || []).map((step) => {
    const li = row({
      title: step.label,
      sub: step.state === 'failed' ? step.error : (step.state === 'done' ? step.detail : null),
    });
    li.dataset.state = step.state;
    const mark = document.createElement('span');
    mark.className = 'step-mark';
    mark.dataset.state = step.state;
    mark.textContent = STEP_MARKS[step.state] || STEP_MARKS.pending;
    // Before the text, which is where a list of steps is read from.
    li.prepend(mark);
    return li;
  }));

  /**
   * The banner is for a failure with no row to sit on.
   *
   * The step list already shows the sentence beside the step that produced it,
   * which is where somebody watching a list of five things is looking. The only
   * case left is a run that failed before any step did — a setup that could not
   * even start — and that is what this is for.
   */
  const error = $('setup-error');
  const onARow = (view.steps || []).some((step) => step.state === 'failed');
  error.hidden = phase !== 'failed' || !view.error || onARow;
  if (!error.hidden) error.textContent = view.error;

  const notes = $('setup-notes');
  notes.hidden = !(view.notes || []).length;
  if (!notes.hidden) notes.textContent = view.notes.join(' ');

  const action = $('setup-action');
  const dismiss = $('setup-dismiss');
  action.hidden = phase === 'running';
  dismiss.hidden = phase === 'running';
  if (!action.hidden) {
    action.textContent = phase === 'needs-permission'
      ? 'Allow and finish setup'
      : 'Try again';
    action.disabled = phase === 'needs-permission' && !view.canRequestPermission;
  }

  $('setup-foot').textContent = phase === 'needs-permission' && !view.canRequestPermission
    ? (view.hint || '')
    : `This computer talks to ${view.apiHost || ''}`;
}

function renderHome() {
  const screenTime = status.screenTime || {};
  const rule = status.rules?.screenTimeRule || null;
  const used = screenTime.todayMinutes || 0;
  const limit = rule?.dailyLimitMinutes || 0;

  $('home-greeting').textContent = status.childName ? `${status.childName}'s day` : 'My day';
  $('home-eyebrow').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  // A machine that cannot measure says so rather than showing an honest-looking
  // zero, which is indistinguishable from a child who has not used it.
  const canMeasure = status.capabilities?.find((c) => c.key === 'screenTime')?.supported;
  $('today-used').textContent = canMeasure ? formatDuration(used) : 'Not measured';

  const meter = $('today-meter');
  const share = limit ? Math.min(1, used / limit) : 0;
  meter.style.width = `${Math.round(share * 100)}%`;
  meter.dataset.tone = share >= 1 ? 'danger' : share >= 0.8 ? 'warning' : 'ok';

  $('today-foot').textContent = !canMeasure
    ? 'This computer cannot measure screen time.'
    : limit
      ? (used >= limit
        ? 'You have used all of today’s time.'
        : `${formatDuration(limit - used)} left of ${formatDuration(limit)}.`)
      : 'No daily limit set.';

  const lockLabels = {
    daily_limit: ['Time is up', 'You have used all of today’s time.'],
    bedtime: ['Bedtime', 'The computer is locked until the morning.'],
    outside_schedule: ['Off hours', 'This computer is outside the hours your parent set.'],
    blocked_by_parent: ['Paused', 'Your parent paused this computer.'],
  };
  const [state, foot] = lockLabels[status.lockReason] || ['Open', 'Everything on this computer is open.'];
  $('now-state').textContent = state;
  $('now-foot').textContent = foot;

  // Read from the agent's decision rather than re-derived from the rules here.
  // Filtering the rules for `action === 'block'` is a different question: it
  // counts an app whose time limit has not been reached, and misses one whose
  // limit has.
  const rows = [];
  const byId = new Map((status.rules?.appRules || []).map((r) => [String(r.appPackage || '').toLowerCase(), r]));
  for (const appId of status.blockedApps || []) {
    if (appId === '*') continue; // the lock is already stated above
    const match = byId.get(appId);
    rows.push(row({
      title: match?.appName || appId,
      sub: match?.action === 'limit' ? 'Daily limit used up' : 'Paused by your parent',
      pill: 'Paused',
      tone: 'blocked',
    }));
  }
  for (const domain of status.blockedDomains || []) {
    rows.push(row({ title: domain, sub: 'Website', pill: 'Blocked', tone: 'blocked' }));
  }

  fill($('blocked-list'), rows);
  $('blocked-empty').hidden = rows.length > 0;
}

/**
 * The version line on "This computer".
 *
 * Deliberately one string rather than a card with a "Check now" button. Updates
 * here are silent and automatic (see `host/updater.js`); a control offering to
 * check would imply the child has a say in it, and a button that only ever says
 * "up to date" is furniture. What is worth stating is the one case where the
 * running version is not the one that will be running tomorrow.
 */
function versionFact() {
  if (!updateStatus?.current) return '—';
  if (updateStatus.pending) return `${updateStatus.current} (${updateStatus.pending} installs on restart)`;
  return updateStatus.current;
}

function renderSettings() {
  const capabilities = status.capabilities || [];
  const monitorState = {
    screenTime: status.screenTime?.sampling,
    appBlocking: status.screenTime?.sampling,
    websiteBlocking: status.webFilter?.running && status.webFilter?.systemDnsApplied && (status.blockedDomains || []).length > 0,
    webHistory: status.webFilter?.running && status.webFilter?.systemDnsApplied,
    notifications: true,
  };

  fill($('monitor-list'), capabilities.map((capability) => {
    // An unavailable capability is described, not shown as a monitor that
    // happens to be off — those are different facts, and only one of them is
    // something the child could change.
    if (!capability.supported) {
      return row({ title: capability.label, sub: capability.unavailable, pill: 'Not available', tone: 'unavailable' });
    }
    const on = !!monitorState[capability.key];
    return row({
      title: capability.label,
      sub: on ? null : (status.webFilter?.lastError && capability.key.startsWith('web') ? status.webFilter.lastError : 'Off right now'),
      pill: on ? 'On' : 'Off',
      tone: on ? 'on' : 'off',
    });
  }));

  bridge.permissions.list().then((permissions) => {
    $('permissions-card').hidden = permissions.length === 0;
    fill($('permission-list'), permissions.map((permission) => {
      const li = row({
        title: permission.label,
        sub: permission.why,
        pill: permission.granted ? 'Granted' : 'Needed',
        tone: permission.granted ? 'on' : 'off',
      });
      if (!permission.granted && permission.openable) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn-quiet';
        button.textContent = 'Open settings';
        button.addEventListener('click', () => bridge.permissions.open(permission.key));
        li.append(button);
      }
      return li;
    }));
  });

  const contacts = status.contacts?.contacts || [];
  fill($('contact-list'), contacts.map((contact) => row({
    title: contact.name,
    sub: [contact.relationship, contact.phoneNumber].filter(Boolean).join(' · ') || null,
  })));
  $('contact-empty').hidden = contacts.length > 0;

  /**
   * What the first run arranged, stated on the screen that states everything
   * else.
   *
   * A setup that did not finish is the quietest way for this product to be
   * wrong — the app looks identical — so it is written here in the same list as
   * the version and the last sync, rather than only on a screen that goes away
   * once it has been dismissed.
   */
  const setupFact = () => {
    if (!setupView) return '—';
    if (setupView.phase === 'running') return 'In progress';
    if (setupView.phase !== 'done') {
      return 'Not finished — Parentix will try again next time this computer starts';
    }
    const when = setupView.completedAt ? new Date(setupView.completedAt).toLocaleString() : 'Finished';
    // A setup that finished with something it could not do — a resolver port
    // another program is holding, permissions it could not tighten — is the one
    // that would otherwise never be mentioned anywhere: the screen carrying the
    // note goes away the moment it succeeds.
    return setupView.notes?.length ? `${when} · ${setupView.notes.join(' ')}` : when;
  };

  const facts = [
    ['Computer', status.osVersion],
    ['Connected to', bridge.apiHost],
    ['Set up', setupFact()],
    // Shown to the child on purpose, alongside everything else on this screen.
    // It is also the answer to the first question support asks, and reading it
    // off the machine beats a parent describing what they think is installed.
    ['Parentix version', versionFact()],
    ['Rules updated', status.sync?.lastSyncAt ? new Date(status.sync.lastSyncAt).toLocaleString() : 'Never'],
    ['Websites checked', status.webFilter?.stats ? String(status.webFilter.stats.queries) : '—'],
    ['Waiting to send', String(status.webHistory?.queued ?? 0)],
  ];
  const nodes = [];
  for (const [term, value] of facts) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value ?? '—';
    nodes.push(dt, dd);
  }
  fill($('device-facts'), nodes);
}

// ── Messages ──────────────────────────────────────────────────────────────────

let messages = [];

function renderMessages() {
  const thread = $('thread');
  fill(thread, messages.map((message) => {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.dataset.from = message.senderRole === 'parent' ? 'parent' : 'child';
    if (message.messageType === 'emergency') bubble.dataset.emergency = 'true';
    bubble.append(document.createTextNode(message.text || ''));
    const time = document.createElement('time');
    time.textContent = new Date(message.createdAt || Date.now())
      .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    bubble.append(time);
    return bubble;
  }));
  thread.scrollTop = thread.scrollHeight;
}

async function loadMessages() {
  try {
    messages = await bridge.messages.list();
    // The API returns newest first; a thread reads oldest first.
    messages = [...messages].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    renderMessages();
  } catch {
    // Offline. The thread is not worth an error banner — the composer will say
    // so if a send actually fails.
  }
}

// ── Wiring ────────────────────────────────────────────────────────────────────

function render() {
  renderShell();
  if (setupShowing()) return renderSetup();
  if (!status?.linked) return;
  if (tab === 'home') renderHome();
  if (tab === 'settings') renderSettings();
  if (tab === 'messages') renderMessages();
}

for (const button of document.querySelectorAll('.nav-item')) {
  button.addEventListener('click', () => {
    tab = button.dataset.tab;
    if (tab === 'messages') loadMessages();
    render();
  });
}

/**
 * The one button on this screen that does anything to the computer.
 *
 * It is disabled while the attempt runs rather than left clickable, because the
 * thing it starts can raise an operating-system prompt and a second press would
 * raise a second one behind the first.
 */
$('setup-action').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Working…';
  try {
    setupView = await bridge.setup.run({ elevate: true });
  } catch (err) {
    // A refused prompt lands here as well as a genuine failure, and both are the
    // same thing to somebody looking at the screen: it did not happen, and the
    // button is still there.
    setupView = { ...(setupView || {}), phase: 'failed', error: err?.message || 'Setup could not finish.' };
  }
  render();
});

$('setup-dismiss').addEventListener('click', async () => {
  setupView = await bridge.setup.dismiss().catch(() => ({ ...(setupView || {}), phase: 'dismissed' }));
  render();
});

bridge.setup.onProgress((view) => {
  setupView = view;
  render();
});

$('link-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = $('link-submit');
  const error = $('link-error');
  const code = $('link-code').value.trim().toUpperCase();

  error.hidden = true;
  submit.disabled = true;
  submit.textContent = 'Linking…';
  try {
    status = await bridge.link(code);
    tab = 'home';
    render();
  } catch (err) {
    error.textContent = err?.message || 'That code was not recognised.';
    error.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = 'Link this computer';
  }
});

$('link-code').addEventListener('input', (event) => {
  // Codes are eight uppercase hex characters. Correcting the case as it is typed
  // saves a child who types lowercase from an error the server would not have
  // raised anyway.
  event.target.value = event.target.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 8);
});

/**
 * A code handed over by the browser (`parentix://link/…`).
 *
 * The main process is already redeeming it — this screen's whole job is to look
 * like something is happening and to leave a usable form behind if it fails.
 * The box is filled and disabled rather than hidden, because the two outcomes a
 * second later are "the app moves on" and "an error appears above a code you can
 * press Link on", and both read better from a form that was visibly there.
 */
bridge.onSetupCode((code) => {
  const input = $('link-code');
  const submit = $('link-submit');
  input.value = String(code || '').toUpperCase().slice(0, 8);
  $('link-error').hidden = true;
  input.disabled = true;
  submit.disabled = true;
  submit.textContent = 'Connecting…';
});

bridge.onSetupError((message) => {
  const submit = $('link-submit');
  const error = $('link-error');
  $('link-code').disabled = false;
  submit.disabled = false;
  submit.textContent = 'Link this computer';
  error.textContent = message || 'That code was not recognised.';
  error.hidden = false;
});

$('message-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('message-text');
  const error = $('message-error');
  const text = input.value.trim();
  if (!text) return;

  error.hidden = true;
  input.value = '';
  try {
    await bridge.messages.send(text);
    await loadMessages();
  } catch (err) {
    error.textContent = err?.message || 'That message could not be sent.';
    error.hidden = false;
    input.value = text;
  }
});

$('sos').addEventListener('click', async () => {
  const error = $('message-error');
  error.hidden = true;
  try {
    await bridge.messages.sendEmergency();
    await loadMessages();
  } catch (err) {
    error.textContent = err?.message || 'That could not be sent.';
    error.hidden = false;
  }
});

$('autostart').addEventListener('change', (event) => {
  bridge.autostart.set(event.target.checked);
});

bridge.messages.onMessage(() => { if (tab === 'messages') loadMessages(); });

bridge.onStatus((next) => {
  status = next;
  render();
});

bridge.update.onStatus((next) => {
  updateStatus = next;
  // Only one screen shows it, and re-rendering the others from an event that
  // fires twice a day would be work for nothing.
  if (tab === 'settings') render();
});

(async () => {
  $('api-host').textContent = bridge.apiHost;

  /**
   * Asked first, and painted before anything else is asked for.
   *
   * Two reasons, and the second is the one that bites. The main process may have
   * started — or finished — setup before this window existed, so the progress
   * events alone would leave a first run showing a link screen with a setup
   * running invisibly behind it. And every other call below is answered by a
   * handler the main process registers *after* the setup it is narrating, so
   * waiting for one of those before the first paint would mean the screen
   * appeared only once there was nothing left to watch.
   */
  setupView = await bridge.setup.status().catch(() => null);
  render();

  $('autostart').checked = await bridge.autostart.get();
  updateStatus = await bridge.update.status().catch(() => null);
  status = await bridge.getStatus();
  render();
  if (status.linked) loadMessages();
})();
