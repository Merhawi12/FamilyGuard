const { ROLES, isStaffRole, isSuperAdmin, hasPermission } = require('../config/roles');

const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

/** Any department account — the gate on the console as a whole. */
const requireStaff = (req, res, next) => {
  if (!isStaffRole(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  next();
};

/**
 * Managing other staff accounts is reserved for Super Admins rather than being
 * a grantable permission — otherwise a department account could be given the
 * means to promote itself.
 */
const requireSuperAdmin = (req, res, next) => {
  if (!isSuperAdmin(req.user)) {
    return res.status(403).json({ error: 'Only a Super Admin can manage staff accounts' });
  }
  next();
};

// Super Admins hold every permission; other roles need it explicitly granted.
const requirePermission = (permission) => (req, res, next) => {
  if (!hasPermission(req.user, permission)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

module.exports = { requireRole, requireStaff, requireSuperAdmin, requirePermission, ROLES };
