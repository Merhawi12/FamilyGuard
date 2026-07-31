const { User } = require('../models');
const { Op } = require('sequelize');
const { auditLog } = require('../utils/auditLogger');
const { revokeAllSessions } = require('../utils/session');
const { passwordProblem, generatePassword } = require('../utils/password');
const {
  PARENT_ROLE, ROLES, PERMISSION_KEYS, STAFF_ROLES, defaultPermissionsFor,
} = require('../config/roles');

const USER_ATTRS = ['id', 'name', 'email', 'plan', 'role', 'permissions', 'isActive', 'emailVerified', 'mfaEnabled', 'trialEndsAt', 'lastLoginAt', 'createdAt'];

const listClients = async (req, res, next) => {
  try {
    const clients = await User.findAll({
      where: { role: { [Op.notIn]: STAFF_ROLES } },
      attributes: ['id', 'name', 'email', 'plan', 'role', 'isActive', 'trialEndsAt', 'createdAt'],
      order: [['createdAt', 'DESC']],
    });
    res.json(clients);
  } catch (err) {
    next(err);
  }
};

// GET /admin/users — full directory, including admins, with search/filter/pagination
const listUsers = async (req, res, next) => {
  try {
    const { search, role, plan, status, limit = 50, offset = 0 } = req.query;
    const where = {};
    if (search) {
      where[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } },
      ];
    }
    if (role) where.role = role;
    if (plan) where.plan = plan;
    if (status === 'active') where.isActive = true;
    if (status === 'blocked') where.isActive = false;

    const { rows, count } = await User.findAndCountAll({
      where,
      attributes: USER_ATTRS,
      order: [['createdAt', 'DESC']],
      limit: Math.min(parseInt(limit), 200),
      offset: parseInt(offset),
    });

    res.json({ rows, count });
  } catch (err) {
    next(err);
  }
};

// POST /admin/users — admin-created account
const createUser = async (req, res, next) => {
  try {
    const { name, email, password, role = PARENT_ROLE, plan = 'free', verified = true } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });

    // This endpoint creates customers. A staff account carries privileges, so it
    // has to come from /admin/staff, which only a Super Admin can reach.
    if (role !== PARENT_ROLE) {
      return res.status(400).json({ error: 'Staff accounts are created at /admin/staff' });
    }

    const existing = await User.findOne({ where: { email } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const user = await User.create({
      name, email, passwordHash: password, role, plan,
      emailVerified: !!verified,
    });

    auditLog(req, { userId: req.user.id, action: 'admin.user_created', entity: 'User', entityId: user.id, metadata: { email, role, plan } });

    res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role, plan: user.plan });
  } catch (err) {
    next(err);
  }
};

// PUT /admin/users/:id — edit profile fields
const updateUser = async (req, res, next) => {
  try {
    const { name, email, plan } = req.body;
    // Staff profiles are edited at /admin/staff.
    const user = await User.findOne({ where: { id: req.params.id, role: { [Op.notIn]: STAFF_ROLES } } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (email && email !== user.email) {
      const existing = await User.findOne({ where: { email } });
      if (existing) return res.status(409).json({ error: 'Email already in use' });
    }

    const updates = {};
    if (name) updates.name = name;
    if (email) updates.email = email;
    if (plan) updates.plan = plan;
    await user.update(updates);

    auditLog(req, { userId: req.user.id, action: 'admin.user_updated', entity: 'User', entityId: user.id, metadata: updates });

    res.json({ id: user.id, name: user.name, email: user.email, plan: user.plan });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /admin/users/:id/role — move an account across the staff boundary.
 *
 * Any role change is a privilege change, so this is Super Admin only (enforced
 * on the route). Editing an existing staff account's role and permissions is
 * `/admin/staff/:id`; this is the endpoint that promotes a parent to staff or
 * returns a staff account to being an ordinary parent.
 */
const updateRole = async (req, res, next) => {
  try {
    const { role, permissions } = req.body;
    const allowedRoles = [...STAFF_ROLES, PARENT_ROLE];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${allowedRoles.join(', ')}` });
    }

    if (Array.isArray(permissions)) {
      const invalidPerm = permissions.find((p) => !PERMISSION_KEYS.includes(p));
      if (invalidPerm) return res.status(400).json({ error: `Unknown permission: ${invalidPerm}` });
    }

    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot change your own role' });
    }

    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Never leave the platform without someone who can manage staff.
    if (user.role === ROLES.SUPER_ADMIN && role !== ROLES.SUPER_ADMIN) {
      const remaining = await User.count({
        where: { role: ROLES.SUPER_ADMIN, isActive: true, id: { [Op.ne]: user.id } },
      });
      if (remaining === 0) {
        return res.status(400).json({ error: 'This is the last Super Admin — promote another account first' });
      }
    }

    const previousRole = user.role;
    // A parent holds no permissions; a staff role falls back to its defaults.
    const nextPermissions = Array.isArray(permissions)
      ? [...new Set(permissions)]
      : (role === PARENT_ROLE ? [] : defaultPermissionsFor(role));

    await user.update({ role, permissions: nextPermissions });

    // The old token carries the old authority — force a fresh sign-in.
    await revokeAllSessions(user.id);

    auditLog(req, {
      userId: req.user.id, action: 'admin.role_changed', entity: 'User', entityId: user.id,
      metadata: { previousRole, role, permissions: nextPermissions },
    });

    res.json({ id: user.id, role: user.role, permissions: user.permissions });
  } catch (err) {
    next(err);
  }
};

// PATCH /admin/users/:id/approve — manually verify + activate an account
/**
 * POST /admin/users/:id/reset-password — set a customer's password.
 *
 * `{ password }` assigns that exact value; omitting it generates a strong one
 * and returns it once. Staff accounts are excluded: those are reset from
 * `/admin/staff/:id/reset-password`, which only a Super Admin can reach.
 *
 * Whoever knew the old password loses the account, so every live session is
 * revoked and the action is written to the audit log.
 */
const resetUserPassword = async (req, res, next) => {
  try {
    const user = await User.findOne({ where: { id: req.params.id, role: { [Op.notIn]: STAFF_ROLES } } });
    if (!user) return res.status(404).json({ error: 'User not found' });

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
      // A reset is also the way out of a failed-login lockout.
      failedLoginAttempts: 0,
      lockedUntil: null,
    });

    await revokeAllSessions(user.id);

    auditLog(req, {
      userId: req.user.id,
      action: 'admin.user_password_reset',
      entity: 'User',
      entityId: user.id,
      metadata: { email: user.email, generated: !password },
    });

    res.json({ id: user.id, email: user.email, generatedPassword: generated });
  } catch (err) {
    next(err);
  }
};

const approveUser = async (req, res, next) => {
  try {
    // Not a route back into a deactivated staff account — approving one would
    // otherwise re-activate a colleague a Super Admin had just switched off.
    const user = await User.findOne({ where: { id: req.params.id, role: { [Op.notIn]: STAFF_ROLES } } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    await user.update({ emailVerified: true, isActive: true });

    auditLog(req, { userId: req.user.id, action: 'admin.user_approved', entity: 'User', entityId: user.id });

    res.json({ id: user.id, emailVerified: user.emailVerified, isActive: user.isActive });
  } catch (err) {
    next(err);
  }
};

const toggleBlock = async (req, res, next) => {
  try {
    // Staff accounts are off-limits here — they are managed at /admin/staff by a
    // Super Admin. Otherwise `manage_users` would reach every colleague's account.
    const client = await User.findOne({ where: { id: req.params.id, role: { [Op.notIn]: STAFF_ROLES } } });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    client.isActive = !client.isActive;
    await client.save();

    if (!client.isActive) await revokeAllSessions(client.id);

    auditLog(req, {
      userId: req.user.id,
      action: client.isActive ? 'admin.user_unblocked' : 'admin.user_blocked',
      entity: 'User',
      entityId: client.id,
    });

    res.json({ id: client.id, isActive: client.isActive });
  } catch (err) {
    next(err);
  }
};

const updatePlan = async (req, res, next) => {
  try {
    const { plan } = req.body;
    const allowed = ['free', 'premium', 'suspended'];
    if (!allowed.includes(plan)) return res.status(400).json({ error: 'Invalid plan' });

    // Staff accounts are off-limits here — they are managed at /admin/staff by a
    // Super Admin. Otherwise `manage_users` would reach every colleague's account.
    const client = await User.findOne({ where: { id: req.params.id, role: { [Op.notIn]: STAFF_ROLES } } });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const previousPlan = client.plan;
    client.plan = plan;
    if (plan === 'suspended') client.isActive = false;
    if (plan === 'premium') client.isActive = true;
    await client.save();

    auditLog(req, {
      userId: req.user.id,
      action: 'admin.plan_changed',
      entity: 'User',
      entityId: client.id,
      metadata: { previousPlan, newPlan: plan },
    });

    res.json({ id: client.id, plan: client.plan, isActive: client.isActive });
  } catch (err) {
    next(err);
  }
};

const deleteClient = async (req, res, next) => {
  try {
    // Staff accounts are off-limits here — they are managed at /admin/staff by a
    // Super Admin. Otherwise `manage_users` would reach every colleague's account.
    const client = await User.findOne({ where: { id: req.params.id, role: { [Op.notIn]: STAFF_ROLES } } });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    auditLog(req, {
      userId: req.user.id,
      action: 'admin.user_deleted',
      entity: 'User',
      entityId: client.id,
      metadata: { email: client.email },
    });

    await client.destroy();
    res.json({ message: 'Client deleted' });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listClients, toggleBlock, updatePlan, deleteClient,
  listUsers, createUser, updateUser, updateRole, approveUser, resetUserPassword,
  PERMISSION_KEYS,
};
