import { cssVariables } from '../theme.js';

const bridge = window.parentix;

const style = document.createElement('style');
style.textContent = cssVariables();
document.head.prepend(style);

/**
 * What each lock says.
 *
 * Written for the child rather than for the rule that produced it. "Your parent
 * set a limit of 90 minutes and you have used 90" is a fact about a
 * configuration; "you have used all of today's time" is the thing they need to
 * know. The bedtime copy names the hour it ends because that is the first
 * question, and the schedule copy does not, because an out-of-hours window can
 * end at a different time on a different day and a wrong hour is worse than
 * none.
 */
const COPY = {
  daily_limit: {
    title: 'Time is up for today',
    detail: 'You have used all of your screen time. It starts again tomorrow morning.',
  },
  // Kept in step with the phone's wording for the same reason `schedule.js` is a
  // copy: a family with a laptop and a handset should be told the same thing.
  bedtime: {
    title: 'It is bedtime',
    detail: 'This computer is asleep until the morning.',
  },
  outside_schedule: {
    title: 'The computer is off right now',
    detail: 'You are outside the hours your parent set for this computer.',
  },
  // Named as a decision someone made, not as a malfunction. The other three
  // lift by themselves and the child can work out when; this one lifts when a
  // person chooses to lift it, so the copy points at the person rather than at
  // a clock that will never come round.
  blocked_by_parent: {
    title: 'This computer is paused',
    detail: 'Your parent paused this computer. It will come back when they unpause it.',
  },
};

/** "Word", "Word and Chrome", "Word, Chrome and Notes" — never "Word, Chrome". */
const list = (names) => (names.length <= 1
  ? names.join('')
  : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

function apply(state) {
  const copy = COPY[state?.reason] || { title: 'This computer is paused', detail: '' };
  document.getElementById('title').textContent = state?.childName
    ? `${copy.title}, ${state.childName}`
    : copy.title;
  document.getElementById('detail').textContent = copy.detail;

  /**
   * The way through, offered only where there is one.
   *
   * Both conditions matter. `tier === 'limit'` is the daily limit and nothing
   * else — bedtime and an out-of-hours schedule are strict, and a button that
   * lifted them would make them optional. A non-empty list matters because
   * dismissing into an empty allowlist gives the child a desktop that closes
   * everything they open, which is more confusing than the lock and no more
   * permissive.
   *
   * The agent checks both again on its side. This is presentation; that is the
   * boundary.
   */
  const allowed = Array.isArray(state?.allowedApps) ? state.allowedApps.filter(Boolean) : [];
  const offer = state?.tier === 'limit' && allowed.length > 0;

  const note = document.getElementById('allowed-note');
  note.hidden = !offer;
  note.textContent = offer ? `You can still use ${list(allowed)}.` : '';

  document.getElementById('allowed').hidden = !offer;
  document.getElementById('allowed-warning').hidden = !offer;
}

const clock = () => {
  document.getElementById('clock').textContent = new Date()
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};
clock();
setInterval(clock, 15_000);

/**
 * Asking is the only thing this screen can do, and it has to work.
 *
 * A locked screen with no way out is the state in which a child gives up on the
 * product and a parent gets a phone call instead of a message. `sendMessage`
 * prefers the socket and falls back to REST, so this survives a laptop that has
 * been asleep and has not reconnected yet.
 */
const sendOnce = (button, send) => {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await send();
      document.getElementById('sent').hidden = false;
    } catch {
      button.disabled = false;
      document.getElementById('sent').hidden = false;
      document.getElementById('sent').textContent =
        'That could not be sent right now — it will go as soon as this computer is online.';
    }
  });
};

sendOnce(document.getElementById('ask'), () =>
  bridge.messages.send('Can I have more time on the computer, please?'));
sendOnce(document.getElementById('sos'), () => bridge.messages.sendEmergency());

/**
 * Take the desktop back, on the allowlist's terms.
 *
 * Not routed through `sendOnce`: nothing is being sent to the parent, and the
 * "Sent to your parent" line underneath would be a lie. A refusal from the agent
 * — the lock changed to a strict one between the paint and the click — leaves the
 * screen exactly as it is and says so, rather than leaving a dead button.
 */
document.getElementById('allowed').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await bridge.lock.useAllowedApps();
    // On success this window is destroyed by the agent, so there is nothing left
    // to re-enable. Only the refusal path gets here with a window still open.
    if (!result?.ok) {
      button.disabled = false;
      document.getElementById('allowed-warning').textContent =
        'That is not available right now.';
    }
  } catch {
    button.disabled = false;
    document.getElementById('allowed-warning').textContent =
      'That did not work. Try again in a moment.';
  }
});

// Keyboard shortcuts that would reload this window into a developer tool, or
// close it, are not available to the child.
window.addEventListener('keydown', (event) => {
  if (event.key === 'F5' || (event.ctrlKey && ['r', 'w', 'n'].includes(event.key.toLowerCase()))) {
    event.preventDefault();
  }
});
window.addEventListener('contextmenu', (event) => event.preventDefault());

bridge.onLockState?.(apply);
apply(bridge.lockState ?? null);
