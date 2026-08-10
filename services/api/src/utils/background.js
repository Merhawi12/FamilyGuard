const logger = require('./logger');

/**
 * A register of the work that outlives the response that started it.
 *
 * Several things here deliberately do not block the reply: a new-sign-in notice
 * reaches an SMTP relay, and nobody logging in should wait on a mail server. The
 * usual way to express that is a bare un-awaited call, but that leaves the work
 * with no owner at all, and two things then go wrong.
 *
 * **Shutdown drops it.** Cloud Run sends SIGTERM and the handler closes the
 * database. A security email whose lookup is still in flight at that moment
 * loses its connection, so the one message that tells an account holder about an
 * intrusion is the message most likely to be thrown away — a redeploy is enough
 * to lose it.
 *
 * **Tests cannot see it.** There is nothing to await, so a test asserting the
 * mail was sent races the code that sends it. Draining the event loop is not
 * enough: the work waits on real database I/O, so the loop empties while the
 * query is still outstanding and the assertion runs early. That failure looks
 * exactly like a missing feature, which is how a passing suite starts hiding
 * whether the notice exists at all.
 *
 * `track` keeps a handle on the promise without making the caller wait, so both
 * problems have one answer: `flushBackground()`.
 */
const pending = new Set();

/**
 * Hold on to a promise that is intentionally not awaited by its caller.
 *
 * Rejections are swallowed on purpose. The callers already log their own
 * failures, and background work must never surface as an `unhandledRejection`
 * that the server logs as an unknown-state error.
 */
const track = (promise) => {
  const settled = Promise.resolve(promise).catch((err) => {
    logger.error('Background task failed', { error: err?.message || String(err) });
  });
  pending.add(settled);
  settled.finally(() => pending.delete(settled));
  return settled;
};

/**
 * Wait for everything currently outstanding, including work that a settling task
 * queues in turn — hence the loop rather than a single `Promise.all`.
 */
const flushBackground = async () => {
  while (pending.size > 0) {
    await Promise.all([...pending]);
  }
};

const pendingCount = () => pending.size;

module.exports = { track, flushBackground, pendingCount };
