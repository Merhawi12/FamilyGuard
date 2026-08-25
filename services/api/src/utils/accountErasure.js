const {
  Session, Child, Device, ActivityLog, Location, AppRule, WebsiteRule, ScreenTimeRule,
  ScreenTimeGrant, Message, Contact, Alert, SafeZone, Notification, PushToken, Transaction,
  AuditLog, ContactMessage,
} = require('../models');
const { sequelize } = require('../config/db');
const { disconnectUserSockets, disconnectDeviceSockets } = require('./session');

/**
 * Everything one account owns, removed together.
 *
 * There are two doors to deleting a customer — the parent closing their own
 * account, and staff removing it from the console — and they did not agree. The
 * console's `deleteClient` destroyed the `User` row and nothing else, which left
 * behind every child profile, every linked device, and all of their location
 * history, messages, contacts and browsing, with no account above them to reach
 * it from. Deleting a customer is precisely the moment that data is supposed to
 * stop existing, so the one door that was reachable by staff did the opposite of
 * what it said.
 *
 * (The devices themselves do stop: `authenticateDevice` walks device → child →
 * parent and refuses when the parent is gone. What was left was the data, not a
 * live feed.)
 *
 * Both doors now call this, as an explicit list rather than as an association
 * cascade.
 *
 * **The child-scoped deletes below are belt-and-braces, and it is worth knowing
 * that rather than believing what this comment used to say.** It claimed these
 * foreign keys carry no `ON DELETE` rule. They do: every `childId` here is an
 * association Sequelize knows about, so `sync()` emits the column as
 * `REFERENCES children(id) ON DELETE CASCADE`, and destroying the `Child` rows
 * near the end of the transaction would take all of them on its own. Read the
 * DDL before relying on either statement.
 *
 * The list stays, because it is worth more than the cascade is: it is the
 * readable inventory of what an erasure actually covers, it does not depend on
 * which engine created the table or on FK enforcement being switched on, and the
 * rows keyed on something other than `childId` — `contact_messages` matched by
 * email, the audit-log anonymisation, everything under `deviceIds` — have no
 * cascade to fall back on and have to be written out regardless.
 *
 * A table added later belongs here too. Nothing fails if you forget, which is
 * the hazard worth naming: `accountLifecycle.test.js` enumerates the tables by
 * hand as well, so it only covers the ones somebody remembered to name.
 *
 * @param {User} user            the account to erase, already loaded
 * @param {object} [options]
 * @param {object} [options.io]  socket server, so live connections are cut too
 * @returns {{children: number, devices: number}} what was removed
 */
const eraseAccount = async (user, { io } = {}) => {
  const children = await Child.findAll({ where: { parentId: user.id }, attributes: ['id'] });
  const childIds = children.map((c) => c.id);
  const devices = childIds.length
    ? await Device.findAll({ where: { childId: childIds }, attributes: ['id'] })
    : [];
  const deviceIds = devices.map((d) => d.id);

  await sequelize.transaction(async (transaction) => {
    if (childIds.length) {
      const byChild = { where: { childId: childIds }, transaction };
      await ActivityLog.destroy(byChild);
      await Location.destroy(byChild);
      await AppRule.destroy(byChild);
      await WebsiteRule.destroy(byChild);
      await ScreenTimeRule.destroy(byChild);
      // Grants are the newest child-scoped table and the one whose absence from
      // this list would have been least visible: nothing ever reads them again,
      // and their own age-based sweep only runs on the next write for this child,
      // which after an erasure never comes. See models/ScreenTimeGrant.js.
      await ScreenTimeGrant.destroy(byChild);
      await Message.destroy(byChild);
      await Contact.destroy(byChild);
    }
    if (deviceIds.length) {
      await PushToken.destroy({ where: { deviceId: deviceIds }, transaction });
      await Device.destroy({ where: { id: deviceIds }, transaction });
    }

    const byUser = { where: { userId: user.id }, transaction };
    await PushToken.destroy(byUser);
    await Notification.destroy(byUser);
    await Session.destroy(byUser);
    await Transaction.destroy(byUser);
    await Alert.destroy({ where: { parentId: user.id }, transaction });
    await SafeZone.destroy({ where: { parentId: user.id }, transaction });
    // Contacts added before any child existed carry a parentId and no childId.
    await Contact.destroy({ where: { parentId: user.id }, transaction });

    /**
     * Messages this person sent through the public contact form.
     *
     * Matched on the address rather than on a user id, because the form does not
     * require an account — someone writes in, and only later signs up with the
     * same address. Those submissions carry their name, their message and a hash
     * of their IP, and nothing else in this function would ever reach them.
     */
    await ContactMessage.destroy({ where: { email: user.email }, transaction });

    /**
     * The audit trail is anonymised, not deleted — the one place this function
     * keeps a row on purpose.
     *
     * Destroying it would be the wrong trade in both directions. It would erase
     * the record that the deletion itself happened, and it would let anyone
     * remove the history of their own actions by closing their account, which is
     * exactly the sequence an audit log exists to survive. Staff actions taken
     * *against* this account live here too, and they belong to the operator.
     *
     * So what goes is the identifying content, and what stays is the shape:
     * `action`, `entity` and `createdAt` still describe what happened and when.
     * `metadata` is the field that actually matters here — nineteen call sites
     * write an `email` into it, and others a `name` or a `phone` — and it is
     * dropped wholesale rather than filtered, because a deny-list over
     * free-form JSON written by twenty controllers is a guarantee nobody can
     * keep. `ipAddress` and `userAgent` go with it.
     *
     * `userId` is nulled last, which is what makes the remaining row unlinkable:
     * the account it pointed at is destroyed on the next line, so the id would
     * dangle in any case.
     */
    await AuditLog.update(
      { metadata: null, ipAddress: null, userAgent: null, userId: null },
      { where: { userId: user.id }, transaction }
    );

    if (childIds.length) await Child.destroy({ where: { id: childIds }, transaction });
    await user.destroy({ transaction });
  });

  // After the transaction: a socket cut inside it would be undone by a rollback
  // in the connection table and not in the socket server.
  disconnectUserSockets(io, user.id);
  for (const deviceId of deviceIds) disconnectDeviceSockets(io, deviceId);

  return { children: childIds.length, devices: deviceIds.length };
};

module.exports = { eraseAccount };
