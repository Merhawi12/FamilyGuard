const { User, Child, Device } = require('../models');
const { Op } = require('sequelize');
const { auditLog } = require('../utils/auditLogger');
const { revokeAllSessions, disconnectFamilySockets } = require('../utils/session');
const { eraseAccount } = require('../utils/accountErasure');
const { passwordProblem, generatePassword } = require('../utils/password');
const { parsePagination } = require('../utils/pagination');
const { likeOperator } = require('../utils/queryOperators');
const { normalizeEmail } = require('../utils/normalizeEmail');
const { isUuid } = require('../utils/ids');
const { ASSIGNABLE_PLANS, SUSPENDED_PLAN } = require('../config/plans');
const {
  PARENT_ROLE, ROLES, PERMISSION_KEYS, STAFF_ROLES, defaultPermissionsFor,
} = require('../config/roles');

/**
 * A customer account by id — never a staff one, and never a database error.
 *
 * The role filter is what keeps `/admin/users/:id` from reaching an employee
 * record; the id check is what keeps a mistyped id in the console's address bar
 * from becoming a 500, since Postgres rejects a malformed UUID outright. See
 * utils/ids.js.
 */
const findParentAccount = (id) =>
  (isUuid(id) ? User.findOne({ where: { id, role: { [Op.notIn]: STAFF_ROLES } } }) : null);

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

/** Everything that is not staff — the customers the directory tiles describe. */
const CUSTOMERS = { role: { [Op.notIn]: STAFF_ROLES } };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Children and linked devices per account, for the rows on one page only.
 *
 * Two small selects counted in JS rather than two correlated sub-queries: a page
 * is at most 200 accounts, and this keeps the row shape out of the dialect's
 * hands. Only active rows count — a removed child or device is a soft delete and
 * must not still show against the family.
 */
const householdsFor = async (userIds) => {
  const households = new Map(userIds.map((id) => [id, { childCount: 0, deviceCount: 0 }]));
  if (userIds.length === 0) return households;

  const children = await Child.findAll({
    where: { parentId: userIds, isActive: true },
    attributes: ['id', 'parentId'],
  });
  const devices = children.length === 0 ? [] : await Device.findAll({
    where: { childId: children.map((c) => c.id), isActive: true },
    attributes: ['childId'],
  });

  const parentOfChild = new Map(children.map((c) => [c.id, c.parentId]));
  children.forEach((c) => { households.get(c.parentId).childCount += 1; });
  devices.forEach((d) => {
    const household = households.get(parentOfChild.get(d.childId));
    if (household) household.deviceCount += 1;
  });

  return households;
};

/**
 * The directory at a glance: how many customers there are, how many joined, and
 * how many pay.
 *
 * Unfiltered on purpose — the tiles describe the platform, so they must not move
 * when the table below them is narrowed to one plan. Staff are excluded: an
 * operator asking "how many users do we have" means customers, and counting
 * ourselves would inflate every number on the screen.
 */
const directorySummary = async () => {
  const now = Date.now();
  const monthAgo = new Date(now - 30 * DAY_MS);
  const twoMonthsAgo = new Date(now - 60 * DAY_MS);

  const [customers, active, premium, recent] = await Promise.all([
    User.count({ where: CUSTOMERS }),
    User.count({ where: { ...CUSTOMERS, isActive: true } }),
    User.count({ where: { ...CUSTOMERS, plan: 'premium' } }),
    User.findAll({
      where: { ...CUSTOMERS, createdAt: { [Op.gte]: twoMonthsAgo } },
      attributes: ['createdAt'],
    }),
  ]);

  // Zero-filled, so the sparkline on the screen has a continuous 30-day axis
  // rather than joining whichever days happened to have a signup.
  const byDay = [];
  for (let back = 29; back >= 0; back -= 1) {
    const date = new Date(now - back * DAY_MS).toISOString().slice(0, 10);
    byDay.push({ date, count: 0 });
  }
  const dayIndex = new Map(byDay.map((entry, i) => [entry.date, i]));

  let month = 0;
  recent.forEach((user) => {
    // Re-wrapped and checked rather than trusted: the two engines hand a `DATE`
    // column back differently, and a row whose timestamp will not parse must be
    // left out of a bucket — not turned into a 500 for the whole directory.
    const created = new Date(user.createdAt);
    if (Number.isNaN(created.getTime()) || created < monthAgo) return;
    month += 1;
    const slot = dayIndex.get(created.toISOString().slice(0, 10));
    if (slot !== undefined) byDay[slot].count += 1;
  });

  const percent = (part, whole) => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);
  const base = customers - month;

  return {
    customers,
    active,
    blocked: customers - active,
    premium,
    premiumShare: percent(premium, customers),
    signups: { month, previousMonth: recent.length - month, byDay },
    // How much bigger the directory is than it was 30 days ago. Deleted accounts
    // leave no row behind, so this is signups measured against the prior base —
    // null when there is no prior base to compare against.
    growth: base > 0 ? percent(month, base) : null,
  };
};

// GET /admin/users — full directory, including admins, with search/filter/pagination
const listUsers = async (req, res, next) => {
  try {
    const { limit, offset } = parsePagination(req.query, { max: 200, defaultLimit: 50 });
    const { search, role, plan, status } = req.query;
    const where = {};
    if (search) {
      // SQLite's LIKE ignores ASCII case but Postgres' does not, so a plain
      // Op.like search works in the test suite and then fails to find
      // "Wilhelmina" for a staff member who typed "wilhelmina" in production.
      const contains = { [likeOperator()]: `%${search}%` };
      where[Op.or] = [{ name: contains }, { email: contains }];
    }
    if (role) where.role = role;
    if (plan) where.plan = plan;
    if (status === 'active') where.isActive = true;
    if (status === 'blocked') where.isActive = false;

    const { rows, count } = await User.findAndCountAll({
      where,
      attributes: USER_ATTRS,
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });

    const [households, summary] = await Promise.all([
      householdsFor(rows.map((u) => u.id)),
      directorySummary(),
    ]);

    res.json({
      // `rows` keeps its shape and gains the two counts the directory shows per
      // account, so nothing that already reads this endpoint has to change.
      rows: rows.map((user) => ({ ...user.toJSON(), ...households.get(user.id) })),
      count,
      summary,
    });
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

    if (!ASSIGNABLE_PLANS.includes(plan)) {
      return res.status(400).json({ error: `Invalid plan. Expected one of: ${ASSIGNABLE_PLANS.join(', ')}` });
    }

    const existing = await User.findByEmail(email);
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
    const user = await findParentAccount(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Compare in the stored (normalised) form, otherwise re-submitting the same
    // address with different capitalisation looks like a clash with itself.
    if (email && normalizeEmail(email) !== user.email) {
      const existing = await User.findByEmail(email);
      if (existing) return res.status(409).json({ error: 'Email already in use' });
    }

    // The dedicated plan endpoint below validates against the catalogue; this
    // one used to take any string, so a typo or a retired tier could be written
    // straight onto an account and leave it entitled to nothing.
    if (plan && !ASSIGNABLE_PLANS.includes(plan)) {
      return res.status(400).json({ error: `Invalid plan. Expected one of: ${ASSIGNABLE_PLANS.join(', ')}` });
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

    // `findByPk` rather than `findParentAccount`: this route deliberately
    // reaches staff records too, since crossing the parent/staff boundary is
    // exactly what it is for. The id still has to be well-formed — see utils/ids.js.
    const user = isUuid(req.params.id) ? await User.findByPk(req.params.id) : null;
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
    await revokeAllSessions(user.id, req.app.get('io'));

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
    const user = await findParentAccount(req.params.id);
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

    await revokeAllSessions(user.id, req.app.get('io'));

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
    const user = await findParentAccount(req.params.id);
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
    const client = await findParentAccount(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    client.isActive = !client.isActive;
    await client.save();

    // Sessions and sockets both — the parent's own, and every child device's.
    // Their tokens are refused from here by the device auth chain, but an
    // already-open socket only closes when someone closes it.
    if (!client.isActive) {
      await revokeAllSessions(client.id, req.app.get('io'));
      await disconnectFamilySockets(req.app.get('io'), client.id);
    }

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
    // Derived from the plan catalogue rather than hard-coded, so a plan that
    // Stripe sells is never one the console refuses to assign.
    if (!ASSIGNABLE_PLANS.includes(plan)) {
      return res.status(400).json({ error: `Plan must be one of: ${ASSIGNABLE_PLANS.join(', ')}` });
    }

    // Staff accounts are off-limits here — they are managed at /admin/staff by a
    // Super Admin. Otherwise `manage_users` would reach every colleague's account.
    const client = await findParentAccount(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const previousPlan = client.plan;
    client.plan = plan;

    // Suspending switches the account off, and lifting a suspension switches it
    // back on. Both directions are keyed off the suspension itself: testing for
    // `premium` by name left a suspended customer locked out when they were
    // moved to `family`, and reactivating on *any* plan change would quietly
    // undo a block applied through toggle-block.
    if (plan === SUSPENDED_PLAN) client.isActive = false;
    else if (previousPlan === SUSPENDED_PLAN) client.isActive = true;

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
    const client = await findParentAccount(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    /**
     * The same erasure the account holder gets, not just the `users` row.
     *
     * This was `client.destroy()` on its own, which left every child profile,
     * every linked device, and all of their location history, messages,
     * contacts and browsing sitting in the database with no account above them
     * to reach it from — indefinitely, and for a minor. Removing a customer is
     * the moment that data is meant to stop existing.
     *
     * Their subscription is deliberately *not* cancelled here. Staff deleting a
     * client is an administrative action, not a billing one, and Stripe holds
     * the customer independently of this row — cancelling silently from the
     * console would hide a refund decision inside a delete button. Blocking the
     * account is the reversible lever for that, and the audit row below is what
     * points billing at the ones that need attention.
     */
    auditLog(req, {
      userId: req.user.id,
      action: 'admin.user_deleted',
      entity: 'User',
      entityId: client.id,
      metadata: { email: client.email, hadSubscription: !!client.stripeSubscriptionId },
    });

    const removed = await eraseAccount(client, { io: req.app.get('io') });
    res.json({ message: 'Client deleted', ...removed });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listClients, toggleBlock, updatePlan, deleteClient,
  listUsers, createUser, updateUser, updateRole, approveUser, resetUserPassword,
  PERMISSION_KEYS,
};
