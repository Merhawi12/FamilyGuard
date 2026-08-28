/**
 * One-time codes — generation, storage, expiry, attempt limits and resend
 * limits, in one place.
 *
 * Three flows on this service hand somebody six digits and then trust them:
 * confirming an address at signup, signing in with a phone number, and resetting
 * a forgotten password. Each had grown its own copy of the same four lines, and
 * each copy was slightly different — the email code counted its failures against
 * the account lockout only after an audit added it, no path limited *resends* at
 * all beyond a per-IP ceiling, and every code sat in the database in plain text.
 * A code is a credential: `verify-email` ends by issuing a session and
 * `verify-reset-code` ends by minting a password-reset ticket, so guessing one is
 * a takeover, and reading one out of a database backup is the same takeover
 * without the guessing.
 *
 * The policy lives here rather than in the controllers so that a fourth flow
 * cannot be added with a fifth version of it. Controllers stay responsible for
 * what a code *means* — which account it activates, whether a failure also
 * counts towards the account lockout — and this module owns everything that is
 * the same regardless.
 *
 * **Codes are stored as a keyed hash, never as digits.** The key is derived from
 * `JWT_SECRET`, which lives in Secret Manager rather than in the database, so a
 * leaked dump or a stray backup yields nothing usable. A plain digest would not
 * do: six digits is a million possibilities and any unkeyed hash of them is
 * reversible in milliseconds, which is why this is an HMAC and not a SHA. The
 * hashing happens in the User model's setters (see `models/User.js`), so every
 * write path is covered — including `User.create`, which is how registration
 * issues its first code.
 *
 * The two shapes below are pure functions over a record and a clock. They return
 * the columns to write rather than writing them, which is what lets registration
 * fold a fresh code into `User.create` and every other caller fold it into
 * `user.update`, with one implementation between them.
 */
const crypto = require('node:crypto');
const { env } = require('../config/env');

/** Six digits, because that is what fits on a lock screen and in an SMS. */
const CODE_DIGITS = 6;

/** Long enough to go and find the message, short enough that a leak ages out. */
const CODE_TTL_MS = 15 * 60 * 1000;

/**
 * Wrong guesses one code will tolerate before it is destroyed.
 *
 * Per code, not per account: the point is that a live code has a bounded number
 * of chances, so a guesser cannot ride out the route's per-IP limiter from a
 * second address and keep going against the same six digits. Once it is spent
 * the holder asks for a new one, which is cheap for them and starts the guesser
 * again from scratch against a different number.
 */
const MAX_ATTEMPTS = 5;

/**
 * Resend limits, which are about the *recipient*, not the caller.
 *
 * The per-IP limiters on the routes stop one machine flooding the service. They
 * do nothing about the case that actually hurts a person: an attacker who names
 * somebody else's address and has enough addresses to spread the requests
 * across, which is a mail bomb aimed at a stranger's inbox and, for the reset
 * flow, reissues the victim's code often enough that the one they are half way
 * through typing keeps dying. These two limits are counted against the account
 * being messaged, so where the requests come from does not matter.
 */
const RESEND_COOLDOWN_MS = 60 * 1000;
const RESEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 5;

/**
 * Which columns carry each kind of code.
 *
 * The three purposes share this module's policy but not their storage — an
 * address confirmation and a password reset can legitimately be outstanding at
 * the same time, so they cannot share a column.
 */
const PURPOSES = {
  email: { code: 'emailVerificationCode', expires: 'emailVerificationExpires' },
  phone: { code: 'phoneVerificationCode', expires: 'phoneVerificationExpires' },
  reset: { code: 'passwordResetCode', expires: 'passwordResetCodeExpires' },
  // The second factor on a password sign-in. Separate storage for the same
  // reason as the rest: somebody part-way through verifying their address can
  // also be part-way through signing in, and one must not clear the other.
  login: { code: 'loginCode', expires: 'loginCodeExpires' },
};

const columnsFor = (purpose) => {
  const columns = PURPOSES[purpose];
  // A typo in a purpose name would otherwise write to `undefined` and silently
  // issue a code nothing could ever verify.
  if (!columns) throw new Error(`Unknown OTP purpose: ${purpose}`);
  return columns;
};

/**
 * `randomInt` over the whole range and then padded, rather than starting at
 * 100000 — a code that may not begin with a zero is a code with 10% fewer
 * possibilities for no reason. The six input boxes accept a leading zero, and
 * everything on both sides of the wire treats a code as a string.
 */
const generateCode = () => String(crypto.randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');

/**
 * The HMAC key, derived once from the signing secret rather than used directly.
 *
 * Derivation means a code hash cannot be fed back to anything else that trusts
 * `JWT_SECRET`, and it is lazy so that this module can be required before the
 * environment has finished being read.
 */
let cachedKey = null;
const otpKey = () => {
  if (!cachedKey) {
    cachedKey = crypto
      .createHmac('sha256', String(env.auth.jwtSecret || ''))
      .update('parentix:otp:v1')
      .digest();
  }
  return cachedKey;
};

const HASHED = /^[a-f0-9]{64}$/;

const digest = (value) => crypto.createHmac('sha256', otpKey()).update(String(value)).digest('hex');

/**
 * A code on its way into storage. Null in, null out — clearing a code is the
 * commonest write this goes through.
 *
 * Already-hashed input passes through untouched, so that applying this twice
 * cannot quietly turn a live code into one that can never match. Sequelize
 * builds rows read from the database with `raw: true` and so does not re-run
 * setters on them, but this is not a property worth resting on a library's
 * internals. A real code is six digits and can never take the shape below.
 */
const hashCode = (code) => {
  if (code === null || code === undefined || code === '') return null;
  const value = String(code);
  return HASHED.test(value) ? value : digest(value);
};

/**
 * Constant-time comparison of a *submitted* code against what is stored.
 *
 * Deliberately hashes through `digest` rather than `hashCode`: the idempotence
 * above belongs to storage and must not reach the check, or the stored hash
 * would itself be accepted as the code. That is not a theoretical distinction —
 * reading the column is precisely the position hashing exists to defend against,
 * and pass-the-hash would hand back everything it takes away.
 */
const codeMatches = (stored, submitted) => {
  if (!stored || submitted === null || submitted === undefined || submitted === '') return false;
  const a = Buffer.from(String(stored), 'utf8');
  const b = Buffer.from(digest(submitted), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * The password-reset *ticket*, hashed for storage.
 *
 * `verify-reset-code` mints 32 random bytes and `reset-password` takes them
 * back; between those two requests the value sat in `users.password_reset_token`
 * as plain text. That is the one secret on this service that authorises a
 * password change outright — no code, no session, no second step — so a database
 * dump, a stray backup or a read-only SQL injection anywhere in the estate was a
 * ready-made takeover of every account with a reset in flight, for the fifteen
 * minutes each one lasts. The six digits that *buy* the ticket have been hashed
 * since the OTP work above; the ticket itself was the half that was missed.
 *
 * Deliberately **not** `hashCode`. That function passes an already-hashed value
 * through untouched so that applying it twice cannot break a live code, and it
 * recognises "already hashed" as 64 hex characters — which is exactly the shape
 * of the ticket (`randomBytes(32).toString('hex')`). Routed through it, every
 * ticket would be stored verbatim and the hashing would silently do nothing.
 * This one always hashes, and the label keeps it out of the same space as the
 * codes so neither can ever be replayed as the other.
 */
const hashTicket = (token) => (token ? digest(`reset-ticket:${token}`) : null);

/* ── The bookkeeping column ───────────────────────────────────────────────────
 *
 * `users.otp_state` is JSON in a TEXT column, holding one entry per purpose:
 *
 *   { "reset": { "sends": 2, "windowStartedAt": …, "lastSentAt": …, "attempts": 1 } }
 *
 * TEXT rather than a JSON column type because the two engines this runs on
 * disagree about JSON equality in ways that have already cost this codebase a
 * migration bug, and nothing here ever needs the database to look inside it.
 * Unreadable content is treated as absent rather than thrown on: this is
 * counters, and refusing to send somebody their signup code because a counter
 * would not parse is the wrong trade.
 */
const EMPTY = { sends: 0, windowStartedAt: 0, lastSentAt: 0, attempts: 0 };

const readState = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const stateFor = (raw, purpose) => ({ ...EMPTY, ...(readState(raw)[purpose] || {}) });

const withState = (raw, purpose, next) => JSON.stringify({ ...readState(raw), [purpose]: next });

/**
 * Mint a code, if the recipient is allowed another one yet.
 *
 * Takes anything with an `otpState` — a User instance, or a bare object for an
 * account that does not exist yet — and returns the plain code alongside the
 * columns that carry it. The caller sends the code and writes the columns; the
 * model hashes on the way in, so the digits exist only in memory and in the
 * message.
 *
 * @returns {{allowed: true, code: string, fields: object}
 *          |{allowed: false, reason: 'cooldown'|'quota', retryAfter: number}}
 */
const prepareCode = (record, purpose, now = Date.now()) => {
  const { code: codeColumn, expires: expiresColumn } = columnsFor(purpose);
  const raw = record?.otpState;
  const state = stateFor(raw, purpose);

  // A window that has run out starts again rather than being topped up, so an
  // account cannot bank unused sends.
  const windowLive = state.windowStartedAt > 0 && now - state.windowStartedAt < RESEND_WINDOW_MS;
  const windowStartedAt = windowLive ? state.windowStartedAt : now;
  const sends = windowLive ? state.sends : 0;

  if (state.lastSentAt && now - state.lastSentAt < RESEND_COOLDOWN_MS) {
    return {
      allowed: false,
      reason: 'cooldown',
      retryAfter: Math.ceil((RESEND_COOLDOWN_MS - (now - state.lastSentAt)) / 1000),
    };
  }

  if (sends >= MAX_SENDS_PER_WINDOW) {
    return {
      allowed: false,
      reason: 'quota',
      retryAfter: Math.ceil((windowStartedAt + RESEND_WINDOW_MS - now) / 1000),
    };
  }

  const code = generateCode();
  return {
    allowed: true,
    code,
    fields: {
      [codeColumn]: code,
      [expiresColumn]: new Date(now + CODE_TTL_MS),
      // A new code starts its own attempt budget. Otherwise five wrong guesses
      // would poison every code issued afterwards.
      otpState: withState(raw, purpose, { sends: sends + 1, windowStartedAt, lastSentAt: now, attempts: 0 }),
    },
  };
};

/**
 * Check a submitted code, and say what to write either way.
 *
 * A code is destroyed on success and on exhaustion, and in both cases the
 * returned `fields` are what does it — nothing here writes. `expired` is
 * deliberately not counted as an attempt: a code that is already dead cannot be
 * guessed, and counting it would let anyone burn a stranger's budget by
 * replaying yesterday's message.
 *
 * @returns {{ok: true, fields: object}
 *          |{ok: false, reason: 'expired'|'invalid'|'too_many', attemptsRemaining?: number, fields: object}}
 */
const checkCode = (record, purpose, submitted, now = Date.now()) => {
  const { code: codeColumn, expires: expiresColumn } = columnsFor(purpose);
  const raw = record.otpState;
  const state = stateFor(raw, purpose);
  const stored = record[codeColumn];
  const expires = record[expiresColumn];

  /**
   * Success clears the whole entry, not just the attempt counter.
   *
   * The resend limits exist to stop somebody being sent messages they did not
   * ask for, and a code that comes back is proof that these ones reached the
   * person they were meant for — nobody completes a verification for a number or
   * an address they cannot read. Keeping the budget spent after that would
   * punish only the legitimate holder: sign out and back in within the minute
   * and the product refuses to send the code it needs. An attacker aimed at
   * someone else's inbox never reaches this branch, so their counters go on
   * accumulating exactly as before.
   *
   * A failure keeps the send history and only zeroes attempts when the code is
   * destroyed, so burning codes is not a way to buy more of them.
   */
  const consume = {
    [codeColumn]: null,
    [expiresColumn]: null,
    otpState: withState(raw, purpose, { ...EMPTY }),
  };

  const spend = {
    [codeColumn]: null,
    [expiresColumn]: null,
    otpState: withState(raw, purpose, { ...state, attempts: 0 }),
  };

  if (!stored || !expires || now > new Date(expires).getTime()) {
    return { ok: false, reason: 'expired', fields: {} };
  }

  if (state.attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: 'too_many', attemptsRemaining: 0, fields: spend };
  }

  if (!codeMatches(stored, submitted)) {
    const attempts = state.attempts + 1;
    const spent = attempts >= MAX_ATTEMPTS;
    return {
      ok: false,
      reason: spent ? 'too_many' : 'invalid',
      attemptsRemaining: Math.max(MAX_ATTEMPTS - attempts, 0),
      fields: spent ? spend : { otpState: withState(raw, purpose, { ...state, attempts }) },
    };
  }

  return { ok: true, fields: consume };
};

module.exports = {
  PURPOSES,
  CODE_DIGITS,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS,
  RESEND_WINDOW_MS,
  MAX_SENDS_PER_WINDOW,
  generateCode,
  hashCode,
  hashTicket,
  codeMatches,
  prepareCode,
  checkCode,
};
