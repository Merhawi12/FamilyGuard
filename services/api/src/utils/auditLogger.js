const { AuditLog } = require('../models');
const logger = require('./logger');

const auditLog = (req, { userId, action, entity, entityId, metadata } = {}) => {
  const ipAddress = req.ip || req.socket?.remoteAddress;
  const userAgent = req.headers['user-agent'];
  AuditLog.create({ userId, action, entity, entityId, metadata, ipAddress, userAgent }).catch(
    (err) => logger.error('Failed to write audit log', { error: err.message })
  );
};

module.exports = { auditLog };
