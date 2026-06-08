const { AuditLog } = require('../models');

const auditLog = (req, { userId, action, entity, entityId, metadata } = {}) => {
  const ipAddress = req.ip || req.socket?.remoteAddress;
  const userAgent = req.headers['user-agent'];
  AuditLog.create({ userId, action, entity, entityId, metadata, ipAddress, userAgent }).catch(
    (err) => console.error('[audit] failed to write log:', err.message)
  );
};

module.exports = { auditLog };
