const jwt = require('jsonwebtoken');
const { User, Session, Device } = require('../models');

const authenticate = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });

  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.sid) {
      const session = await Session.findByPk(decoded.sid);
      if (!session || session.revoked) return res.status(401).json({ error: 'Session expired' });
      session.update({ lastActiveAt: new Date() }).catch(() => {});
      req.sessionId = session.id;
    }

    const user = await User.findByPk(decoded.id);
    if (!user || !user.isActive) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Used by child device — token contains { deviceId, childId } instead of { id }
const authenticateDevice = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });

  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.deviceId || !decoded.childId) return res.status(401).json({ error: 'Invalid device token' });

    const device = await Device.findByPk(decoded.deviceId);
    if (!device || !device.isActive) return res.status(401).json({ error: 'Device revoked' });

    req.deviceId = decoded.deviceId;
    req.childId = decoded.childId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

module.exports = { authenticate, authenticateDevice };
