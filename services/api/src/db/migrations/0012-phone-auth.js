/**
 * Sign in with a phone number.
 *
 * Four new columns, and one change to an old one that is the whole reason this
 * migration is delicate:
 *
 *   phone                       E.164, e.g. +14155550123. Unique, because two
 *                               accounts must never claim the same number — that
 *                               is the entire basis on which an SMS code proves
 *                               who someone is.
 *   phone_verified              a number is only an identity once a code sent to
 *                               it has come back. Until then it is a claim.
 *   phone_verification_code     the six digits, and when they stop being valid.
 *   phone_verification_expires
 *
 *   email                       becomes nullable. An account created from a phone
 *                               number has no address, and the column was NOT
 *                               NULL, so without this the insert fails outright.
 *                               This mirrors what 0011 did to password_hash for
 *                               Google accounts, and for the same reason: a new
 *                               way in means an old "everyone has one of these"
 *                               assumption stops being true.
 *
 * The nullability change is what makes this hard to reverse — see `down`.
 *
 * `sequelize.sync()` creates tables but never alters an existing one, so on any
 * database that already has a `users` table this is the only thing that runs.
 */
const { DataTypes } = require('sequelize');

module.exports = {
  async up(queryInterface) {
    const users = await queryInterface.describeTable('users');

    if (!users.phone) {
      await queryInterface.addColumn('users', 'phone', {
        type: DataTypes.STRING,
        allowNull: true,
      });

      // Every phone sign-in looks an account up by this, so it is a hot path
      // from the first request. Unique for the reason given above.
      //
      // Both engines allow repeated NULLs in a unique index, which is what makes
      // this safe to add to a table full of existing email-only accounts: they
      // all have a null phone and none of them collide.
      try {
        await queryInterface.addIndex('users', ['phone'], {
          name: 'users_phone_idx',
          unique: true,
        });
      } catch (err) {
        if (!/already exists|duplicate/i.test(err.message)) throw err;
      }
    }

    if (!users.phone_verified) {
      await queryInterface.addColumn('users', 'phone_verified', {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }

    if (!users.phone_verification_code) {
      await queryInterface.addColumn('users', 'phone_verification_code', {
        type: DataTypes.STRING,
        allowNull: true,
      });
    }

    if (!users.phone_verification_expires) {
      await queryInterface.addColumn('users', 'phone_verification_expires', {
        type: DataTypes.DATE,
        allowNull: true,
      });
    }

    // SQLite has no ALTER COLUMN: changeColumn rebuilds the table, which is
    // expensive enough to be worth doing only when it is actually needed. On a
    // freshly synced database the model already declares it nullable.
    if (users.email && users.email.allowNull === false) {
      await queryInterface.changeColumn('users', 'email', {
        type: DataTypes.STRING,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    // email is deliberately left nullable. Any phone-only account created while
    // this was applied has no address to put back, so restoring NOT NULL would
    // fail partway through and leave the table half-migrated — the same reason
    // 0011 leaves password_hash alone on the way down.
    try {
      await queryInterface.removeIndex('users', 'users_phone_idx');
    } catch { /* not present */ }

    for (const column of ['phone', 'phone_verified', 'phone_verification_code', 'phone_verification_expires']) {
      try {
        await queryInterface.removeColumn('users', column);
      } catch { /* not present */ }
    }
  },
};
