/**
 * A second factor for everybody: the code emailed on every password sign-in.
 *
 *   login_code                  the six digits, stored as the same keyed HMAC
 *   login_code_expires          every other code column holds — see utils/otp.js
 *
 *   trusted_devices_revoked_at  when this account's remembered browsers stopped
 *                               being remembered. A trusted-device token is a
 *                               stateless 30-day claim, so there is no row to
 *                               delete; this instant is what invalidates them,
 *                               all at once.
 *
 * Its own column pair rather than reusing `email_verification_code`, matching the
 * separation utils/otp.js already keeps between the three existing purposes: an
 * address confirmation and a sign-in challenge can be outstanding at the same
 * moment — a parent who never finished verifying and then tries to sign in is
 * exactly that — and one column would let either silently clear the other.
 *
 * `sequelize.sync()` creates tables but never alters one that exists, so on every
 * database that already has a `users` table this migration is the only thing that
 * adds these. That is also why no index is declared on the model for them: an
 * index over a column a migration introduces makes sync fail on every existing
 * database, which is the trap 0016 documents. Nothing here needs one — all three
 * are read by primary key, on a row the caller already has in hand.
 */
const { DataTypes } = require('sequelize');

const COLUMNS = [
  ['login_code', { type: DataTypes.STRING, allowNull: true }],
  ['login_code_expires', { type: DataTypes.DATE, allowNull: true }],
  ['trusted_devices_revoked_at', { type: DataTypes.DATE, allowNull: true }],
];

module.exports = {
  async up(queryInterface) {
    const users = await queryInterface.describeTable('users');

    for (const [name, spec] of COLUMNS) {
      if (!users[name]) await queryInterface.addColumn('users', name, spec);
    }
  },

  /**
   * Reversible, unlike 0017.
   *
   * Rolling back drops the columns and with them any challenge in flight, which
   * costs whoever is mid-sign-in one more attempt against an image that no longer
   * asks for a code. Nothing is left unreadable by the older build — the reason
   * that migration is one-way — because the older build simply does not look here.
   */
  async down(queryInterface) {
    for (const [name] of COLUMNS) {
      try {
        await queryInterface.removeColumn('users', name);
      } catch { /* not present */ }
    }
  },
};
