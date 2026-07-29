const jwt = require('jsonwebtoken');
const { User, Child, Device } = require('../src/models');

let counter = 0;
const uniqueEmail = (prefix = 'user') => `${prefix}_${counter++}@test.dev`;

const DEFAULT_PASSWORD = 'password123';

// Creates a verified parent by default. passwordHash is hashed by the model hook.
async function createUser(overrides = {}) {
  return User.create({
    name: 'Test User',
    email: overrides.email || uniqueEmail(),
    passwordHash: DEFAULT_PASSWORD,
    emailVerified: true,
    ...overrides,
  });
}

// Parent session token (no sid → auth middleware skips the Session lookup).
function tokenFor(user) {
  return jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function createChild(parentId, overrides = {}) {
  return Child.create({ parentId, name: 'Kid', age: 10, ...overrides });
}

async function createDevice(childId, overrides = {}) {
  return Device.create({ childId, name: 'Kid Phone', isLinked: true, isActive: true, ...overrides });
}

// Device token shaped exactly like the one deviceController issues on link.
function deviceToken(device) {
  return jwt.sign(
    { deviceId: device.id, childId: device.childId },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

module.exports = {
  DEFAULT_PASSWORD,
  uniqueEmail,
  createUser,
  tokenFor,
  createChild,
  createDevice,
  deviceToken,
};
