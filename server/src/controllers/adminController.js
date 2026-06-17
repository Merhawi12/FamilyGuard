const { User } = require('../models');
const { Op } = require('sequelize');
const { auditLog } = require('../utils/auditLogger');
const { revokeAllSessions } = require('../utils/session');

const PERMISSION_KEYS = ['manage_users', 'manage_billing', 'manage_settings', 'send_notifications', 'view_audit_logs', 'manage_sessions'];

const USER_ATTRS = ['id', 'name', 'email', 'plan', 'role', 'permissions', 'isActive', 'emailVerified', 'mfaEnabled', 'trialEndsAt', 'lastLoginAt', 'createdAt'];

const listClients = async (req, res) => {
  try {
    const clients = await User.findAll({
      where: { role: { [Op.ne]: 'admin' } },
      attributes: ['id', 'name', 'email', 'plan', 'role', 'isActive', 'trialEndsAt', 'createdAt'],
      order: [['createdAt', 'DESC']],
    });
    res.json(clients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /admin/users — full directory, including admins, with search/filter/pagination
const listUsers = async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
};

// POST /admin/users — admin-created account
const createUser = async (req, res) => {
  try {
    const { name, email, password, role = 'parent', plan = 'free', verified = true } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });

    const existing = await User.findOne({ where: { email } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const user = await User.create({
      name, email, passwordHash: password, role, plan,
      emailVerified: !!verified,
    });

    auditLog(req, { userId: req.user.id, action: 'admin.user_created', entity: 'User', entityId: user.id, metadata: { email, role, plan } });

    res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role, plan: user.plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// PUT /admin/users/:id — edit profile fields
const updateUser = async (req, res) => {
  try {
    const { name, email, plan } = req.body;
    const user = await User.findByPk(req.params.id);
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
    res.status(500).json({ error: err.message });
  }
};

// PATCH /admin/users/:id/role — set role + granular permissions
const updateRole = async (req, res) => {
  try {
    const { role, permissions = [] } = req.body;
    const allowedRoles = ['admin', 'parent', 'support'];
    if (!allowedRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const invalidPerm = permissions.find((p) => !PERMISSION_KEYS.includes(p));
    if (invalidPerm) return res.status(400).json({ error: `Unknown permission: ${invalidPerm}` });

    if (req.params.id === req.user.id && role !== 'admin') {
      return res.status(400).json({ error: 'You cannot remove your own admin role' });
    }

    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const previousRole = user.role;
    await user.update({ role, permissions });

    auditLog(req, { userId: req.user.id, action: 'admin.role_changed', entity: 'User', entityId: user.id, metadata: { previousRole, role, permissions } });

    res.json({ id: user.id, role: user.role, permissions: user.permissions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// PATCH /admin/users/:id/approve — manually verify + activate an account
const approveUser = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    await user.update({ emailVerified: true, isActive: true });

    auditLog(req, { userId: req.user.id, action: 'admin.user_approved', entity: 'User', entityId: user.id });

    res.json({ id: user.id, emailVerified: user.emailVerified, isActive: user.isActive });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const toggleBlock = async (req, res) => {
  try {
    const client = await User.findOne({ where: { id: req.params.id, role: { [Op.ne]: 'admin' } } });
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
    res.status(500).json({ error: err.message });
  }
};

const updatePlan = async (req, res) => {
  try {
    const { plan } = req.body;
    const allowed = ['free', 'premium', 'suspended'];
    if (!allowed.includes(plan)) return res.status(400).json({ error: 'Invalid plan' });

    const client = await User.findOne({ where: { id: req.params.id, role: { [Op.ne]: 'admin' } } });
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
    res.status(500).json({ error: err.message });
  }
};

const deleteClient = async (req, res) => {
  try {
    const client = await User.findOne({ where: { id: req.params.id, role: { [Op.ne]: 'admin' } } });
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
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  listClients, toggleBlock, updatePlan, deleteClient,
  listUsers, createUser, updateUser, updateRole, approveUser,
  PERMISSION_KEYS,
};
