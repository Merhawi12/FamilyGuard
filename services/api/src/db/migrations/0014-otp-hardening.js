/**
 * One-time codes: a reset code, and the bookkeeping every code flow now shares.
 *
 *   password_reset_code            the six digits sent to a forgotten-password
 *   password_reset_code_expires    address. `password_reset_token` stays what it
 *                                  was — the ticket minted once those digits
 *                                  come back — so the "choose a new password"
 *                                  endpoint and everything that tests it are
 *                                  unchanged. What went away is the emailed
 *                                  link that used to be the only way to get one.
 *
 *   otp_state                      per-purpose counters: sends, the window they
 *                                  are counted in, when the last one went out,
 *                                  and how many wrong guesses the live code has
 *                                  taken. TEXT holding JSON — see utils/otp.js.
 *
 * **The stored codes change shape.** From here a verification code is a keyed
 * HMAC, not the digits, and there is no migrating the old rows: a hash cannot be
 * derived from a column that no longer holds the plaintext… except that it can,
 * because the plaintext is exactly what is in there today. It is deliberately
 * *not* converted. These codes live fifteen minutes, every one of them will have
 * expired long before a deployment finishes, and rewriting a credential column
 * in place to save somebody one click on "Resend code" is a bad trade. They are
 * cleared instead, so that no plaintext code survives this migration anywhere —
 * which is the whole point of it.
 *
 * `sequelize.sync()` creates tables but never alters one that exists, so on any
 * database with a `users` table this is what runs.
 */
const { DataTypes } = require('sequelize');

module.exports = {
  async up(queryInterface) {
    const users = await queryInterface.describeTable('users');

    if (!users.password_reset_code) {
      await queryInterface.addColumn('users', 'password_reset_code', {
        type: DataTypes.STRING,
        allowNull: true,
      });
    }

    if (!users.password_reset_code_expires) {
      await queryInterface.addColumn('users', 'password_reset_code_expires', {
        type: DataTypes.DATE,
        allowNull: true,
      });
    }

    if (!users.otp_state) {
      await queryInterface.addColumn('users', 'otp_state', {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: '{}',
      });
    }

    /**
     * Every code in flight is dropped, for the reason in the header: they are
     * plaintext, they are worth minutes, and the code that verifies them now
     * compares hashes — so leaving them would not make them work, it would only
     * leave them readable.
     *
     * Reset links go the same way. Nothing mints one from an email any more, and
     * one still sitting in an inbox is a live key to an account that its owner
     * can no longer see a reason for.
     */
    await queryInterface.sequelize.query(`
      UPDATE users SET
        email_verification_code = NULL,
        email_verification_expires = NULL,
        phone_verification_code = NULL,
        phone_verification_expires = NULL,
        password_reset_token = NULL,
        password_reset_expires = NULL
    `);
  },

  async down(queryInterface) {
    for (const column of ['password_reset_code', 'password_reset_code_expires', 'otp_state']) {
      try {
        await queryInterface.removeColumn('users', column);
      } catch { /* not present */ }
    }
    // The cleared codes are not restored, and could not be: they were destroyed
    // on the way up on purpose. Anyone mid-flow asks for a new one.
  },
};
