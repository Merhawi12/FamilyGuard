/**
 * One lockout, shared by every factor that can be guessed.
 *
 * Four endpoints ask "is this secret correct?" and hand out a session when it
 * is: the password (`login`), the emailed code (`verifyEmail`), the SMS code
 * (`verifyPhoneCode`) and the second factor (`mfa/validate`). Three of them
 * counted failures against the account and locked it; `mfa/validate` counted
 * nothing at all, so the *strongest* door was the only one with no bound on
 * attempts — forty wrong codes left `failedLoginAttempts` at 0 and the account
 * answering 401 forever.
 *
 * The per-route IP limiter is not a substitute. It caps one address, and the
 * thing being protected here is a six-digit number: the account-wide counter is
 * what makes guessing it expensive no matter how many addresses the guesses
 * come from. Kept as one helper for the same reason `trialEndsAtFromNow` is —
 * so a fifth guessable factor cannot quietly ship without a ceiling.
 */

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

/** Whether the account is inside an active lockout window. */
const isLockedOut = (user) => !!user?.lockedUntil && new Date() < new Date(user.lockedUntil);

/**
 * Records one failed attempt, locking the account on the fifth.
 *
 * The counter resets as the lock is applied so the next window starts clean —
 * this is the behaviour the password path already had, kept identical here.
 *
 * @returns {Promise<boolean>} whether this attempt tripped the lock.
 */
const recordFailedAttempt = async (user) => {
  const attempts = (user.failedLoginAttempts || 0) + 1;
  const locked = attempts >= MAX_LOGIN_ATTEMPTS;
  await user.update({
    failedLoginAttempts: locked ? 0 : attempts,
    ...(locked ? { lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) } : {}),
  });
  return locked;
};

/** Clears the counters after a successful authentication. Cheap no-op when already clear. */
const clearFailedAttempts = async (user) => {
  if (user.failedLoginAttempts > 0 || user.lockedUntil) {
    await user.update({ failedLoginAttempts: 0, lockedUntil: null });
  }
};

module.exports = {
  MAX_LOGIN_ATTEMPTS,
  LOCKOUT_DURATION_MS,
  isLockedOut,
  recordFailedAttempt,
  clearFailedAttempts,
};
