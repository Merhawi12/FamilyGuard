const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

// Admins always have full access; other roles need the permission explicitly granted.
const requirePermission = (permission) => (req, res, next) => {
  if (req.user.role === 'admin') return next();
  const granted = Array.isArray(req.user.permissions) ? req.user.permissions : [];
  if (!granted.includes(permission)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

module.exports = { requireRole, requirePermission };
