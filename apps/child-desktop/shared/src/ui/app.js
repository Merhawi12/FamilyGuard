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

function renderShell() {
  const linked = !!status?.linked;
  $('nav').hidden = !linked;
  app.dataset.view = linked ? tab : 'link';

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

  const facts = [
    ['Computer', status.osVersion],
    ['Connected to', bridge.apiHost],
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

(async () => {
  $('api-host').textContent = bridge.apiHost;
  $('autostart').checked = await bridge.autostart.get();
  status = await bridge.getStatus();
  render();
  if (status.linked) loadMessages();
})();
