/**
 * The credentials this database is not allowed to hold in the clear.
 *
 * Passwords have been bcrypt since the beginning, one-time codes became a keyed
 * HMAC in the OTP work, push tokens and browsing URLs are AES-GCM. Two were
 * still plaintext, and both are worth more to a reader of a backup than anything
 * already covered:
 *
 *   `mfa_secret`            a TOTP seed does not expire and does not rotate, so
 *                           whoever reads one can mint that account's second
 *                           factor for as long as MFA stays on. Staff are the
 *                           accounts told to turn MFA on, which made the readable
 *                           seeds exactly the ones that open the customer
 *                           directory.
 *
 *   `password_reset_token`  the ticket `verify-reset-code` mints. It authorises a
 *                           password change outright — no code, no session, no
 *                           second step — so a row read is a takeover of every
 *                           account with a reset in flight.
 *
 * These tests read the columns *raw*, underneath the model hooks, because that
 * is the position being defended against: what a `pg_dump` or a stray SELECT
 * would show. Asserting through the ORM would prove nothing — it decrypts.
 */
const request = require('supertest');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/db');
const { User } = require('../src/models');
const { createUser, uniqueEmail, tokenFor, seedResetCode } = require('./helpers');
const { hashTicket } = require('../src/utils/otp');
const { decrypt } = require('../src/utils/crypto');

/** The stored bytes, with every model hook bypassed. */
const rawColumn = async (userId, column) => {
  const [rows] = await sequelize.query(
    `SELECT ${column} AS value FROM users WHERE id = :id`,
    { replacements: { id: userId } },
  );
  return rows[0]?.value ?? null;
};

describe('the TOTP seed is encrypted at rest', () => {
  /** What `/mfa/setup` writes, driven through the real endpoint. */
  const enrol = async () => {
    const user = await createUser({ email: uniqueEmail('mfa-rest') });
    const res = await request(app)
      .post('/api/auth/mfa/setup')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .expect(200);
    return { user, secret: res.body.secret };
  };

  it('never writes the seed the authenticator app was given', async () => {
    const { user, secret } = await enrol();

    const stored = await rawColumn(user.id, 'mfa_secret');
    expect(stored).toBeTruthy();
    expect(stored).not.toBe(secret);
    // The iv:tag:ciphertext form. A base32 seed can never contain a colon, so
    // this is also what makes the conversion in migration 0017 idempotent.
    expect(stored).toContain(':');
    expect(decrypt(stored)).toBe(secret);
  });

  it('hands the seed back to the code that has to verify against it', async () => {
    const { user, secret } = await enrol();

    // The round trip that matters: a later request re-reads the row, and MFA is
    // only usable if what comes back is the seed and not the ciphertext.
    const reloaded = await User.findByPk(user.id);
    expect(reloaded.mfaSecret).toBe(secret);
  });

  /**
   * The double-encryption trap `models/PushToken.js` documents, which cost that
   * feature a silent outage.
   *
   * `afterFind` assigns the decrypted seed, which marks the attribute changed —
   * so an unrelated save on a loaded instance runs the encrypt hook again. Left
   * unguarded it would encrypt the ciphertext, and the seed would be gone for
   * good with MFA the only way into the account.
   */
  it('survives an unrelated save on a loaded row', async () => {
    const { user, secret } = await enrol();

    const loaded = await User.findByPk(user.id);
    await loaded.update({ lastLoginAt: new Date() });
    await loaded.update({ name: 'Renamed' });

    expect((await User.findByPk(user.id)).mfaSecret).toBe(secret);
    expect(decrypt(await rawColumn(user.id, 'mfa_secret'))).toBe(secret);
  });

  /**
   * A row written before this existed still has to work. `decrypt` passes a
   * value carrying no `:` through untouched, which is what lets the code deploy
   * ahead of the migration rather than in lockstep with it.
   */
  it('still reads a seed left in plain base32 by an older build', async () => {
    const user = await createUser({ email: uniqueEmail('mfa-legacy') });
    await sequelize.query(
      'UPDATE users SET mfa_secret = :secret WHERE id = :id',
      { replacements: { secret: 'JBSWY3DPEHPK3PXP', id: user.id } },
    );

    expect((await User.findByPk(user.id)).mfaSecret).toBe('JBSWY3DPEHPK3PXP');
  });

  /**
   * Clearing has to reach the column, not be swallowed by the encrypt hook.
   *
   * Reloaded first, deliberately. `enrol()` writes through the instance the auth
   * middleware built for its request, so the handle this test is holding never
   * learned the secret — and `update({ mfaSecret: null })` on it is null-to-null,
   * which Sequelize elides into no UPDATE at all. That made the first version of
   * this test assert nothing while passing on SQLite, where the read happened to
   * come back empty for an unrelated reason. Postgres said so plainly.
   */
  it('clears the column when MFA is switched off', async () => {
    const { user } = await enrol();
    expect(await rawColumn(user.id, 'mfa_secret')).toBeTruthy();

    const loaded = await User.findByPk(user.id);
    await loaded.update({ mfaEnabled: false, mfaSecret: null, mfaBackupCodes: null });

    expect(await rawColumn(user.id, 'mfa_secret')).toBeNull();
  });
});

describe('the password-reset ticket is never stored as issued', () => {
  const requestTicket = async () => {
    const email = uniqueEmail('reset-rest');
    const user = await createUser({ email });
    const code = await seedResetCode(user);

    const res = await request(app)
      .post('/api/auth/verify-reset-code')
      .send({ email, code })
      .expect(200);

    return { user, email, ticket: res.body.resetToken };
  };

  it('stores a digest, not the ticket it handed the caller', async () => {
    const { user, ticket } = await requestTicket();

    expect(ticket).toMatch(/^[0-9a-f]{64}$/);
    const stored = await rawColumn(user.id, 'password_reset_token');
    expect(stored).toBeTruthy();
    expect(stored).not.toBe(ticket);
    expect(stored).toBe(hashTicket(ticket));
  });

  it('still redeems the ticket it issued', async () => {
    const { user, ticket } = await requestTicket();

    await request(app)
      .post('/api/auth/reset-password')
      .send({ token: ticket, newPassword: 'brand-new-pw9' })
      .expect(200);

    const after = await User.findByPk(user.id);
    expect(after.passwordResetToken).toBeNull();
    expect(await after.comparePassword('brand-new-pw9')).toBe(true);
  });

  /**
   * The attack the hashing exists to stop, stated as a test: someone who has
   * read the column presents what they read.
   *
   * Before this, the stored value *was* the ticket and this request succeeded.
   */
  it('refuses the stored value when it is replayed as the ticket', async () => {
    const { user } = await requestTicket();
    const stored = await rawColumn(user.id, 'password_reset_token');

    await request(app)
      .post('/api/auth/reset-password')
      .send({ token: stored, newPassword: 'stolen-pw9' })
      .expect(400);

    const after = await User.findByPk(user.id);
    expect(await after.comparePassword('stolen-pw9')).toBe(false);
  });

  it('answers a non-string ticket without reaching the database', async () => {
    await request(app)
      .post('/api/auth/reset-password')
      .send({ token: { not: 'a string' }, newPassword: 'brand-new-pw9' })
      .expect(400);
  });
});
