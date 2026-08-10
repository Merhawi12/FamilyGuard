const { Op } = require('sequelize');
const { User } = require('../models');
const { auditLog } = require('../utils/auditLogger');
const { revokeAllSessions } = require('../utils/session');
const { passwordProblem, generatePassword } = require('../utils/password');
const { normalizeEmail } = require('../utils/normalizeEmail');
const { isUuid } = require('../utils/ids');
const {
  ROLES, PERMISSION_KEYS, ROLE_LABELS, STAFF_ROLES,
  isStaffRole, defaultPermissionsFor,
} = require('../config/roles');

const STAFF_ATTRS = [
  'id', 'name', 'email', 'role', 'permissions', 'isActive',
  'mfaEnabled', 'lastLoginAt', 'createdAt',
];

/**
 * Staff accounts, and only staff accounts. Parent accounts are managed through
 * `/admin/users` — mixing them here would let a Super Admin quietly convert a
 * customer into an employee.
 */
// A malformed id is "not found", not a database error — see utils/ids.js for why
// this has to be checked before the query rather than after it.
const findStaff = (id) =>
  (isUuid(id) ? User.findOne({ where: { id, role: { [Op.in]: STAFF_ROLES } } }) : null);

/** Guards the "don't strand the platform" invariant. */
const otherActiveSuperAdmins = (excludeId) =>
  User.count({
    where: {
      role: ROLES.SUPER_ADMIN,
      isActive: true,
      id: { [Op.ne]: excludeId },
    },
  });

const validateRole = (role) => (isStaffRole(role) ? null : `Role must be one of: ${STAFF_ROLES.join(', ')}`);

/**
 * Permissions default to the role's set. An explicit list overrides it, so a
 * Super Admin can vary one account without inventing a role.
 */
const resolvePermissions = (role, requested) => {
  if (!Array.isArray(requested)) return { permissions: defaultPermissionsFor(role) };

  const unknown = requested.find((p) => !PERMISSION_KEYS.includes(p));
  if (unknown) return { error: `Unknown permission: ${unknown}` };

  return { permissions: [...new Set(requested)] };
};

// GET /admin/staff
const listStaff = async (req, res, next) => {
  try {
    const staff = await User.findAll({
      where: { role: { [Op.in]: STAFF_ROLES } },
      attributes: STAFF_ATTRS,
      order: [['createdAt', 'ASC']],
    });

    res.json({
      staff,
      roles: STAFF_ROLES.map((role) => ({
        value: role,
        label: ROLE_LABELS[role],
        defaultPermissions: defaultPermissionsFor(role),
      })),
      permissions: PERMISSION_KEYS,
    });
  } catch (err) {
    next(err);
  }
};

// POST /admin/staff
const createStaff = async (req, res, next) => {
  try {
    const { name, email, role, permissions, password } = req.body;
    if (!name?.trim() || !email?.trim()) return res.status(400).json({ error: 'Name and email are required' });

    const roleError = validateRole(role);
    if (roleError) return res.status(400).json({ error: roleError });

    const resolved = resolvePermissions(role, permissions);
    if (resolved.error) return res.status(400).json({ error: resolved.error });

    const existing = await User.findByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    // A supplied password still has to satisfy the policy; otherwise generate
    // one and hand it back once so it can be delivered out of band.
    let generated = null;
    if (password) {
      const weak = passwordProblem(password);
      if (weak) return res.status(400).json({ error: weak });
    } else {
      generated = generatePassword();
    }

    const user = await User.create({
      name: name.trim(),
      email,
      passwordHash: password || generated,
      role,
      permissions: resolved.permissions,
      // Staff are provisioned by a Super Admin, so there is no inbox step.
      emailVerified: true,
      isActive: true,
    });

    auditLog(req, {
      userId: req.user.id, action: 'staff.created', entity: 'User', entityId: user.id,
      metadata: { email: user.email, role, permissions: resolved.permissions },
    });

    res.status(201).json({
      staff: {
        id: user.id, name: user.name, email: user.email, role: user.role,
        permissions: user.permissions, isActive: user.isActive, mfaEnabled: false,
        lastLoginAt: null, createdAt: user.createdAt,
      },
      // Shown once — it is hashed from here on.
      generatedPassword: generated,
    });
  } catch (err) {
    next(err);
  }
};

// PUT /admin/staff/:id
const updateStaff = async (req, res, next) => {
  try {
    const user = await findStaff(req.params.id);
    if (!user) return res.status(404).json({ error: 'Staff account not found' });

    const { name, email, role, permissions } = req.body;
    const updates = {};

    if (name?.trim()) updates.name = name.trim();

    if (email?.trim() && normalizeEmail(email) !== user.email) {
      const clash = await User.findByEmail(email);
      if (clash) return res.status(409).json({ error: 'Email already in use' });
      // The model setter normalises on write.
      updates.email = email;
    }

    const roleChanged = role && role !== user.role;
    if (role) {
      const roleError = validateRole(role);
      if (roleError) return res.status(400).json({ error: roleError });

      if (user.role === ROLES.SUPER_ADMIN && role !== ROLES.SUPER_ADMIN) {
        // Self-demotion is the case that actually arises: the caller must be an
        // active Super Admin, so any *other* account is never the last one.
        if (user.id === req.user.id) {
          return res.status(400).json({ error: 'You cannot change your own role — ask another Super Admin' });
        }
        // Defence in depth for the same invariant.
        if ((await otherActiveSuperAdmins(user.id)) === 0) {
          return res.status(400).json({ error: 'This is the last Super Admin — promote another account first' });
        }
      }
      updates.role = role;
    }

    // An explicit list always wins; otherwise a role change re-seeds the defaults.
    if (Array.isArray(permissions)) {
      const resolved = resolvePermissions(role || user.role, permissions);
      if (resolved.error) return res.status(400).json({ error: resolved.error });
      updates.permissions = resolved.permissions;
    } else if (roleChanged) {
      updates.permissions = defaultPermissionsFor(role);
    }

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

    await user.update(updates);

    // A narrowed role must not keep working on an existing session.
    if (updates.role || updates.permissions) await revokeAllSessions(user.id, req.app.get('io'));

    auditLog(req, {
      userId: req.user.id, action: 'staff.updated', entity: 'User', entityId: user.id,
      metadata: updates,
    });

    res.json({
      id: user.id, name: user.name, email: user.email, role: user.role,
      permissions: user.permissions, isActive: user.isActive,
      mfaEnabled: user.mfaEnabled, lastLoginAt: user.lastLoginAt, createdAt: user.createdAt,
    });
  } catch (err) {
    next(err);
  }
};

// PATCH /admin/staff/:id/status  { isActive }
const setStaffStatus = async (req, res, next) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') return res.status(400).json({ error: 'isActive must be true or false' });

    const user = await findStaff(req.params.id);
    if (!user) return res.status(404).json({ error: 'Staff account not found' });

    if (user.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot deactivate your own account' });
    }
    if (!isActive && user.role === ROLES.SUPER_ADMIN && (await otherActiveSuperAdmins(user.id)) === 0) {
      return res.status(400).json({ error: 'This is the last active Super Admin' });
    }

    await user.update({ isActive });
    // `authenticate` rejects an inactive user, but drop the sessions anyway so
    // the revocation is visible in the sessions screen.
    if (!isActive) await revokeAllSessions(user.id, req.app.get('io'));

    auditLog(req, {
      userId: req.user.id, action: isActive ? 'staff.activated' : 'staff.deactivated',
      entity: 'User', entityId: user.id,
    });

    res.json({ id: user.id, isActive: user.isActive });
  } catch (err) {
    next(err);
  }
};

// POST /admin/staff/:id/reset-password  { password? }
const resetStaffPassword = async (req, res, next) => {
  try {
    const user = await findStaff(req.params.id);
    if (!user) return res.status(404).json({ error: 'Staff account not found' });

    const { password } = req.body || {};
    let generated = null;
    if (password) {
      const weak = passwordProblem(password);
      if (weak) return res.status(400).json({ error: weak });
    } else {
      generated = generatePassword();
    }

    await user.update({
      passwordHash: password || generated,
      // A reset is also the way out of a lockout.
      failedLoginAttempts: 0,
      lockedUntil: null,
    });

    // Whoever held the old password must not keep a live session.
    await revokeAllSessions(user.id, req.app.get('io'));

    auditLog(req, {
      userId: req.user.id, action: 'staff.password_reset', entity: 'User', entityId: user.id,
    });

    res.json({ id: user.id, generatedPassword: generated });
  } catch (err) {
    next(err);
  }
};

// DELETE /admin/staff/:id
const deleteStaff = async (req, res, next) => {
  try {
    const user = await findStaff(req.params.id);
    if (!user) return res.status(404).json({ error: 'Staff account not found' });

    if (user.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }
    if (user.role === ROLES.SUPER_ADMIN && (await otherActiveSuperAdmins(user.id)) === 0) {
      return res.status(400).json({ error: 'This is the last Super Admin' });
    }

    const { email, role } = user;
    await revokeAllSessions(user.id, req.app.get('io'));
    await user.destroy();

    auditLog(req, {
      userId: req.user.id, action: 'staff.deleted', entity: 'User', entityId: req.params.id,
      metadata: { email, role },
    });

    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
};

module.exports = { listStaff, createStaff, updateStaff, setStaffStatus, resetStaffPassword, deleteStaff };
