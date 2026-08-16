/**
 * The one-time-code engine, and the two limits nothing else can assert.
 *
 * `utils/otp.js` is pure functions over a record and a clock, which is what lets
 * an hour of resend policy be tested in a millisecond — the alternative is a
 * suite that either waits out its own limits or turns them off, and the second
 * of those is how a limit ends up existing only in a comment.
 *
 * The flows that use it are covered where they live: passwordResetFlow.test.js
 * walks the reset end to end, phoneAuth.test.js the SMS path, emailDelivery and
 * authHardening the signup path. What is here is the shared policy underneath
 * all three, plus the integration checks that prove the controllers are actually
 * wired to it rather than to their own old copies.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { User } = require('../src/models');
const { createUser, uniqueEmail, rewindOtpCooldown } = require('./helpers');
const otp = require('../src/utils/otp');

const {
  CODE_TTL_MS, MAX_ATTEMPTS, RESEND_COOLDOWN_MS, RESEND_WINDOW_MS, MAX_SENDS_PER_WINDOW,
} = otp;

/** A record as the model presents one, for the pure functions to work over. */
const record = (fields = {}) => ({ otpState: '{}', ...fields });

/** Apply what `prepareCode`/`checkCode` returned, as a controller would. */
const apply = (base, result) => ({ ...base, ...(result.fields || {}) });

describe('generating a code', () => {
  it('is always six digits, leading zeros included', () => {
    for (let i = 0; i < 200; i += 1) expect(otp.generateCode()).toMatch(/^\d{6}$/);
  });

  it('can produce a code that starts with a zero', () => {
    /*
     * `randomInt(100000, 1000000)` — the shape this replaced — cannot, which
     * quietly threw away a tenth of the keyspace. Six hundred draws miss the
     * leading-zero tenth about once in 10^27 runs, so a failure here is the
     * generator, not the dice.
     */
    const codes = Array.from({ length: 600 }, () => otp.generateCode());
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
  });

  it('does not repeat itself over a short run', () => {
    const seen = new Set(Array.from({ length: 500 }, () => otp.generateCode()));
    // Birthday collisions in 500 draws from a million are ordinary; a generator
    // that is stuck is not.
    expect(seen.size).toBeGreaterThan(400);
  });
});

describe('storing a code', () => {
  it('hashes to something that is not the code, and is stable', () => {
    const hashed = otp.hashCode('123456');

    expect(hashed).toMatch(/^[a-f0-9]{64}$/);
    expect(hashed).not.toContain('123456');
    expect(otp.hashCode('123456')).toBe(hashed);
    expect(otp.hashCode('123457')).not.toBe(hashed);
  });

  it('leaves an absent code absent', () => {
    expect(otp.hashCode(null)).toBeNull();
    expect(otp.hashCode(undefined)).toBeNull();
    expect(otp.hashCode('')).toBeNull();
  });

  it('is idempotent, so a value that has been through it twice still verifies', () => {
    // Sequelize builds rows read from the database raw and so does not re-run
    // setters — but a double application anywhere would silently turn a live
    // code into one that can never match, which is worth being immune to.
    const once = otp.hashCode('424242');
    expect(otp.hashCode(once)).toBe(once);
    expect(otp.codeMatches(otp.hashCode(once), '424242')).toBe(true);
  });

  it('matches the right code and nothing else', () => {
    const stored = otp.hashCode('098765');

    expect(otp.codeMatches(stored, '098765')).toBe(true);
    expect(otp.codeMatches(stored, '098766')).toBe(false);
    expect(otp.codeMatches(stored, '98765')).toBe(false);
    expect(otp.codeMatches(stored, '')).toBe(false);
    expect(otp.codeMatches(null, '098765')).toBe(false);
  });

  it('does not accept the stored hash as the code', () => {
    /*
     * The storage-side hash passes an already-hashed value through untouched so
     * that applying it twice is harmless. If the *check* shared that shortcut,
     * whoever could read the column could present its contents and be let in —
     * which is exactly the position hashing exists to defend against, so the
     * check hashes unconditionally.
     */
    const stored = otp.hashCode('098765');
    expect(otp.codeMatches(stored, stored)).toBe(false);
  });

  it('is stored hashed by the model, on every write path', async () => {
    const user = await createUser({ emailVerificationCode: '111111' });
    expect(user.emailVerificationCode).toBe(otp.hashCode('111111'));

    await user.update({ phoneVerificationCode: '222222', passwordResetCode: '333333' });
    expect(user.phoneVerificationCode).toBe(otp.hashCode('222222'));
    expect(user.passwordResetCode).toBe(otp.hashCode('333333'));

    // And survives a round trip through the database unchanged, which is what
    // would break if reads re-ran the setter.
    const reloaded = await User.findByPk(user.id);
    expect(reloaded.emailVerificationCode).toBe(otp.hashCode('111111'));
    expect(otp.codeMatches(reloaded.emailVerificationCode, '111111')).toBe(true);
  });
});

describe('issuing a code', () => {
  it('gives a fresh account its first code with no history to check', () => {
    const result = otp.prepareCode({}, 'email');

    expect(result.allowed).toBe(true);
    expect(result.code).toMatch(/^\d{6}$/);
    expect(result.fields.emailVerificationCode).toBe(result.code);
    expect(new Date(result.fields.emailVerificationExpires).getTime())
      .toBeGreaterThan(Date.now() + CODE_TTL_MS - 5000);
  });

  it('writes to the columns that belong to the purpose it was asked for', () => {
    expect(Object.keys(otp.prepareCode({}, 'phone').fields)).toEqual(
      expect.arrayContaining(['phoneVerificationCode', 'phoneVerificationExpires', 'otpState'])
    );
    expect(Object.keys(otp.prepareCode({}, 'reset').fields)).toEqual(
      expect.arrayContaining(['passwordResetCode', 'passwordResetCodeExpires', 'otpState'])
    );
  });

  it('refuses a name it does not know, rather than writing to nowhere', () => {
    expect(() => otp.prepareCode({}, 'not-a-purpose')).toThrow(/unknown otp purpose/i);
  });

  it('refuses a second code inside the cooldown, and says how long to wait', () => {
    const now = 1_000_000_000_000;
    const issued = apply(record(), otp.prepareCode(record(), 'email', now));

    const again = otp.prepareCode(issued, 'email', now + 20_000);

    expect(again.allowed).toBe(false);
    expect(again.reason).toBe('cooldown');
    expect(again.retryAfter).toBe(Math.ceil((RESEND_COOLDOWN_MS - 20_000) / 1000));
  });

  it('allows one the moment the cooldown is up', () => {
    const now = 1_000_000_000_000;
    const issued = apply(record(), otp.prepareCode(record(), 'email', now));

    expect(otp.prepareCode(issued, 'email', now + RESEND_COOLDOWN_MS).allowed).toBe(true);
  });

  it('stops at five in an hour however patiently they are spaced', () => {
    let state = record();
    let now = 1_000_000_000_000;

    for (let i = 0; i < MAX_SENDS_PER_WINDOW; i += 1) {
      const result = otp.prepareCode(state, 'email', now);
      expect(result.allowed).toBe(true);
      state = apply(state, result);
      now += RESEND_COOLDOWN_MS;
    }

    const blocked = otp.prepareCode(state, 'email', now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('quota');
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it('starts the allowance again once the window has passed, rather than topping it up', () => {
    let state = record();
    const start = 1_000_000_000_000;
    let now = start;

    for (let i = 0; i < MAX_SENDS_PER_WINDOW; i += 1) {
      state = apply(state, otp.prepareCode(state, 'email', now));
      now += RESEND_COOLDOWN_MS;
    }
    expect(otp.prepareCode(state, 'email', now).allowed).toBe(false);

    const afterWindow = start + RESEND_WINDOW_MS + 1;
    expect(otp.prepareCode(state, 'email', afterWindow).allowed).toBe(true);
  });

  it('counts each purpose separately, so a reset does not consume a signup code', () => {
    const now = 1_000_000_000_000;
    const afterEmail = apply(record(), otp.prepareCode(record(), 'email', now));

    expect(otp.prepareCode(afterEmail, 'email', now + 1000).allowed).toBe(false);
    expect(otp.prepareCode(afterEmail, 'reset', now + 1000).allowed).toBe(true);
  });

  it('treats unreadable bookkeeping as none, rather than refusing to send', () => {
    // Counters are not worth stranding somebody's signup over.
    expect(otp.prepareCode({ otpState: 'not json at all' }, 'email').allowed).toBe(true);
    expect(otp.prepareCode({ otpState: null }, 'email').allowed).toBe(true);
  });
});

describe('checking a code', () => {
  /**
   * A record in the state a controller would have written: the columns
   * `prepareCode` produced, with the code hashed as the model hashes it. Built
   * explicitly rather than through the model because what the setter does on the
   * way in is half of what these are checking.
   */
  const issuedRecord = (purpose, now) => {
    const issued = otp.prepareCode(record(), purpose, now);
    const columns = otp.PURPOSES[purpose];
    return {
      code: issued.code,
      stored: { ...apply(record(), issued), [columns.code]: otp.hashCode(issued.code) },
    };
  };

  it('accepts the right code and destroys it', () => {
    const now = 1_000_000_000_000;
    const { code, stored } = issuedRecord('email', now);

    const checked = otp.checkCode(stored, 'email', code, now + 1000);

    expect(checked.ok).toBe(true);
    expect(checked.fields.emailVerificationCode).toBeNull();
    expect(checked.fields.emailVerificationExpires).toBeNull();
  });

  it('refuses an expired code without spending an attempt', () => {
    // Otherwise anyone could burn a stranger's budget by replaying yesterday's
    // message at them.
    const now = 1_000_000_000_000;
    const { code, stored } = issuedRecord('email', now);

    const checked = otp.checkCode(stored, 'email', code, now + CODE_TTL_MS + 1);

    expect(checked.ok).toBe(false);
    expect(checked.reason).toBe('expired');
    expect(checked.fields).toEqual({});
  });

  it('refuses when there is no code at all', () => {
    const checked = otp.checkCode(record(), 'email', '123456');
    expect(checked.ok).toBe(false);
    expect(checked.reason).toBe('expired');
  });

  it('counts wrong guesses and destroys the code on the fifth', () => {
    const now = 1_000_000_000_000;
    const issued = issuedRecord('email', now);
    let stored = issued.stored;

    for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
      const wrong = otp.checkCode(stored, 'email', '000000', now + i);
      expect(wrong.reason).toBe('invalid');
      expect(wrong.attemptsRemaining).toBe(MAX_ATTEMPTS - i);
      // The code is still live while there is budget left.
      expect(wrong.fields.emailVerificationCode).toBeUndefined();
      stored = apply(stored, wrong);
    }

    const last = otp.checkCode(stored, 'email', '000000', now + MAX_ATTEMPTS);
    expect(last.reason).toBe('too_many');
    expect(last.attemptsRemaining).toBe(0);
    expect(last.fields.emailVerificationCode).toBeNull();

    // And the right code is worth nothing now.
    stored = apply(stored, last);
    expect(otp.checkCode(stored, 'email', issued.code, now + MAX_ATTEMPTS + 1).ok).toBe(false);
  });

  it('does not accept the stored hash in place of the code', async () => {
    // The same pass-the-hash refusal as above, through the endpoint that would
    // hand out a session for it.
    const email = uniqueEmail('passthehash');
    const user = await createUser({ email, emailVerified: false, emailVerificationCode: '515151' });
    await user.update({ emailVerificationExpires: new Date(Date.now() + CODE_TTL_MS) });

    const res = await request(app).post('/api/auth/verify-email')
      .send({ email, code: user.emailVerificationCode });

    expect(res.status).toBe(400);
    expect(res.body.token).toBeUndefined();
  });

  it('clears the send budget on success, so the next flow is not refused', () => {
    /*
     * Verifying is proof the messages reached the person they were for. Signing
     * out and back in within the minute would otherwise be met with a refusal to
     * send the code that signing in needs — a limit aimed at mail-bombing
     * strangers, landing only on the account holder.
     */
    const now = 1_000_000_000_000;
    const { code, stored } = issuedRecord('phone', now);

    const after = apply(stored, otp.checkCode(stored, 'phone', code, now + 1000));

    expect(otp.prepareCode(after, 'phone', now + 2000).allowed).toBe(true);
  });

  it('does not clear it when the code is merely burned', () => {
    // Otherwise five wrong guesses would be a way to buy five more sends.
    const now = 1_000_000_000_000;
    let { stored } = issuedRecord('email', now);

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      stored = apply(stored, otp.checkCode(stored, 'email', '000000', now + i));
    }

    const next = otp.prepareCode(stored, 'email', now + 1000);
    expect(next.allowed).toBe(false);
    expect(next.reason).toBe('cooldown');
  });

  it('gives a new code its own budget', () => {
    const now = 1_000_000_000_000;
    let stored = record();

    const first = otp.prepareCode(stored, 'email', now);
    stored = { ...apply(stored, first), emailVerificationCode: otp.hashCode(first.code) };
    stored = apply(stored, otp.checkCode(stored, 'email', '000000', now + 1));

    const second = otp.prepareCode(stored, 'email', now + RESEND_COOLDOWN_MS);
    stored = { ...apply(stored, second), emailVerificationCode: otp.hashCode(second.code) };

    const checked = otp.checkCode(stored, 'email', '000000', now + RESEND_COOLDOWN_MS + 1);
    expect(checked.attemptsRemaining).toBe(MAX_ATTEMPTS - 1);
  });

  it('does not accept one purpose\'s code for another', () => {
    const now = 1_000_000_000_000;
    const { code, stored } = issuedRecord('reset', now);
    const bothLive = {
      ...stored,
      emailVerificationCode: otp.hashCode('999999'),
      emailVerificationExpires: new Date(now + CODE_TTL_MS),
    };

    expect(otp.checkCode(bothLive, 'email', code, now + 1).ok).toBe(false);
    expect(otp.checkCode(bothLive, 'reset', code, now + 1).ok).toBe(true);
  });
});

describe('the endpoints are wired to it', () => {
  const registerAt = (email) => request(app).post('/api/auth/register')
    .send({ name: 'Otp Wiring', email, password: 'password123' });
  const resend = (email) => request(app).post('/api/auth/resend-code').send({ email });

  it('refuses a resend inside the cooldown and says how long is left', async () => {
    const email = uniqueEmail('cooldown');
    await registerAt(email).expect(201);

    const res = await resend(email);

    expect(res.status).toBe(429);
    expect(res.body.retryAfter).toBeGreaterThan(0);
    expect(res.body.retryAfter).toBeLessThanOrEqual(RESEND_COOLDOWN_MS / 1000);
    expect(res.body.error).toMatch(/wait/i);
  });

  it('leaves the code already in the inbox alone when it refuses', async () => {
    const email = uniqueEmail('cooldown-keeps');
    await registerAt(email).expect(201);
    const issued = (await User.findByEmail(email)).emailVerificationCode;

    await resend(email).expect(429);

    expect((await User.findByEmail(email)).emailVerificationCode).toBe(issued);
  });

  it('allows the resend once the cooldown is up, and rotates the code', async () => {
    const email = uniqueEmail('rotates');
    await registerAt(email).expect(201);
    const first = (await User.findByEmail(email)).emailVerificationCode;

    await rewindOtpCooldown(await User.findByEmail(email));
    await resend(email).expect(200);

    expect((await User.findByEmail(email)).emailVerificationCode).not.toBe(first);
  });

  it('stops resending after five in an hour', async () => {
    const email = uniqueEmail('quota');
    // Registration is the first of the five.
    await registerAt(email).expect(201);

    for (let i = 1; i < MAX_SENDS_PER_WINDOW; i += 1) {
      await rewindOtpCooldown(await User.findByEmail(email));
      await resend(email).expect(200);
    }

    await rewindOtpCooldown(await User.findByEmail(email));
    const res = await resend(email);

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/too many/i);
  });

  it('never puts the code in a response body', async () => {
    const email = uniqueEmail('nobody-sees');
    const created = await registerAt(email).expect(201);
    const stored = await User.findByEmail(email);

    expect(JSON.stringify(created.body)).not.toContain(stored.emailVerificationCode);
    expect(created.body.code).toBeUndefined();
  });
});
