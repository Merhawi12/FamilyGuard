const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * Extra minutes a parent handed out for one day, once.
 *
 * The child asks for more time — from the lock screen on a laptop, from Messages
 * on a phone — and until now the only way to say yes was to open Screen Time,
 * raise `dailyLimitMinutes`, and remember to lower it again tomorrow. That is a
 * policy change standing in for a one-off answer, and the half nobody remembers
 * is the second one: the limit a parent widened on a Tuesday evening is still
 * widened in November.
 *
 * So a grant is a row, not an edit. The rule keeps saying what the parent
 * decided in general; a grant sits beside it and expires on its own.
 *
 * **A row rather than a column on `ScreenTimeRule`, for two reasons.** Writing to
 * the rule would mean minting a device exception for any grant narrowed to one
 * device — the exact trap `screenTimeController.getRule` documents, where merely
 * touching a device's scope detaches it from the child-wide rule for good. And
 * grants stack: "another fifteen minutes" said twice is thirty, which a single
 * column would have to read-modify-write from two devices at once.
 *
 * **Nothing here records when the grant expires, and that is deliberate.** A
 * grant is spent against the child's *usage day*, and which day a sample belongs
 * to is a question only the device can answer — `UsageStatsManager` measures from
 * the phone's local midnight, this process runs on Cloud Run in UTC, and the
 * families are in Canada. An `expiresAt` computed here would be right for about
 * four hours a day. So the row carries the instant it was granted, the device is
 * sent that instant, and the device compares it to its own midnight. It is the
 * same division of labour as `usageDayWindow` in deviceController, arrived at the
 * hard way — see the evening double-counting in [[audit-2026-08-12-qa-checklist]].
 */
const ScreenTimeGrant = sequelize.define('ScreenTimeGrant', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  childId: { type: DataTypes.UUID, allowNull: false },

  /**
   * The one device these minutes are for, or NULL for every device the child
   * owns — the same nullable scope the three rule tables carry.
   *
   * Unlike a rule, a device-scoped grant does **not** override the child-wide
   * one: they add up. A rule is a statement about how things are, so two of them
   * at different scopes conflict and the narrower has to win. A grant is a
   * one-off gift of minutes, and two gifts are more minutes — see
   * `resolveScreenTimeGrants` in utils/deviceScope.js, which is where that choice
   * is written down for both the sync and the parent's own listing.
   */
  deviceId: { type: DataTypes.UUID, allowNull: true },

  /** Whole minutes, always positive. Time is never taken away this way. */
  minutes: { type: DataTypes.INTEGER, allowNull: false },

  /** The parent who granted it, kept so the audit log and the child can name them. */
  grantedBy: { type: DataTypes.UUID },
}, {
  underscored: true,
  indexes: [
    // The device sync asks "this child's grants since yesterday" on every poll,
    // and the pruner asks the same question with the inequality reversed.
    //
    // Safe to declare on the model, unlike the `device_id` indexes on the rule
    // tables: this table does not exist on any deployed database, so `sync()`
    // creates it with every column already present. The rule that bit before —
    // sync() will not add a column to a table that already exists — only applies
    // to an index over a column a migration introduces.
    { fields: ['child_id', 'created_at'] },
  ],
});

module.exports = ScreenTimeGrant;
