/**
 * Sign in with Google.
 *
 * Two changes, and the second is the one that bites:
 *
 *   google_id     the `sub` claim from Google's ID token. Stable for the life of
 *                 the Google account and, unlike the address, not something its
 *                 owner can change — so it is what a linked account is looked up
 *                 by. Unique, because two Parentix accounts must never claim the
 *                 same Google identity.
 *
 *   password_hash becomes nullable. An account created through Google has no
 *                 password and never will unless its owner sets one. The column
 *                 was NOT NULL, so without this the insert fails outright.
 *
 * `sequelize.sync()` creates tables but never alters an existing one, so on any
 * database that already has a `users` table — every deployed environment — the
 * nullability change only happens here.
 */
const { DataTypes } = require('sequelize');

module.exports = {
  async up(queryInterface) {
    const users = await queryInterface.describeTable('users');

    if (!users.google_id) {
      await queryInterface.addColumn('users', 'google_id', {
        type: DataTypes.STRING,
        allowNull: true,
      });

      // Every Google sign-in reads this, so it is a hot path from the first
      // request. Unique for the same reason the column exists.
      try {
        await queryInterface.addIndex('users', ['google_id'], {
          name: 'users_google_id_idx',
          unique: true,
        });
      } catch (err) {
        if (!/already exists|duplicate/i.test(err.message)) throw err;
      }
    }

    // SQLite has no ALTER COLUMN: changeColumn rebuilds the table, which is
    // expensive and — on a table with rows — worth doing only when it is
    // actually needed. `allowNull` is already true on a freshly synced database,
    // because the model now declares it that way.
    if (users.password_hash && users.password_hash.allowNull === false) {
      await queryInterface.changeColumn('users', 'password_hash', {
        type: DataTypes.STRING,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    // password_hash is deliberately left nullable. Any Google-only account
    // created while this was applied has no password to put back, so restoring
    // NOT NULL would fail partway and leave the table half-migrated.
    try {
      await queryInterface.removeIndex('users', 'users_google_id_idx');
    } catch { /* not present */ }
    try {
      await queryInterface.removeColumn('users', 'google_id');
    } catch { /* not present */ }
  },
};
