const {
  Session, Child, Device, ActivityLog, Location, AppRule, WebsiteRule, ScreenTimeRule,
  Message, Contact, Alert, SafeZone, Notification, PushToken, Transaction,
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
 * Both doors now call this. It is deliberately a plain function over models
 * rather than an association cascade: the foreign keys here carry no `ON DELETE`
 * rule, so a cascade would have to be a migration on every table at once, and
 * the order below is readable in a way an implicit one is not.
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
