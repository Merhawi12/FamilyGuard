import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  admin as adminApi, errorMessage, useAuth, Avatar, EmptyState, Icon, Modal,
  ROLES, STAFF_ROLES, roleLabel, isSuperAdmin, hasPermission, PERMISSIONS,
  PERMISSION_KEYS, PERMISSION_LABELS, defaultPermissionsFor,
} from '@parentix/shared';
import DataTable from '../components/DataTable';
import StatTile from '../components/StatTile';
import { Sparkline, DayBars, Meter } from '../components/MiniChart';

const PAGE_SIZE = 50;

/**
 * How a plan reads in the table: its badge tone and the mark beside it. Premium
 * is the paid tier, suspended is the off switch rather than a tier.
 */
const PLAN_STYLE = {
  premium: { badge: 'badge-green', icon: 'sparkle', label: 'Premium' },
  free: { badge: 'badge-gray', icon: 'shield', label: 'Free' },
  suspended: { badge: 'badge-red', icon: 'block', label: 'Suspended' },
};

const planStyle = (plan) => PLAN_STYLE[plan] || { badge: 'badge-gray', icon: 'shield', label: plan };

/** Percentage change between two periods, or null when there is no baseline. */
const changeBetween = (now, before) => (before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null);

/**
 * One action on a row.
 *
 * Labelled on a phone card, icon-only in the desktop table: six labelled buttons
 * plus five columns is more than a table has room for, and an icon that carries
 * an `aria-label` and a tooltip is still one click and still announced properly.
 * `shortLabel` is for actions whose full name is a sentence ("Set a password") —
 * the card shows the short form, assistive tech gets the whole thing.
 */
function RowAction({ label, shortLabel, icon, tone, onClick, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      // Square from `lg` up, where the label is hidden: a 39px pill around a 15px
      // icon is padding the directory's action column cannot spare.
      className={`btn btn-sm ${tone} lg:w-9 lg:px-0`}
    >
      <Icon name={icon} size={15} />
      <span className="lg:hidden">{shortLabel || label}</span>
    </button>
  );
}

// Parent plus every department. Editing an existing staff account's role and
// permissions belongs on the Staff Accounts screen; this dialog is the way an
// account crosses the customer/staff boundary.
const ASSIGNABLE_ROLES = [ROLES.PARENT, ...STAFF_ROLES];

const isStaffRole = (role) => STAFF_ROLES.includes(role);

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionId, setActionId] = useState(null);
  const [summary, setSummary] = useState(null);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [filters, setFilters] = useState({ role: '', plan: '', status: '' });
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', email: '', password: '', role: 'parent', plan: 'free' });
  const [editUser, setEditUser] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', email: '', plan: '' });
  const [roleUser, setRoleUser] = useState(null);
  const [roleForm, setRoleForm] = useState({ role: ROLES.PARENT, permissions: [] });
  const [count, setCount] = useState(0);
  const [offset, setOffset] = useState(0);
  // Resetting a customer's password is gated separately from editing them.
  const [resetUser, setResetUser] = useState(null);
  const [resetMode, setResetMode] = useState('generate');
  const [resetForm, setResetForm] = useState({ password: '', confirm: '' });
  const [resetting, setResetting] = useState(false);
  const [revealed, setRevealed] = useState(null);
  const { user: me } = useAuth();
  const superAdmin = isSuperAdmin(me);
  const canResetPasswords = hasPermission(me, PERMISSIONS.RESET_PASSWORDS);

  /**
   * `search` is what is typed; `appliedSearch` is what the last submit asked
   * for. Keeping them apart means the request depends only on committed state —
   * so the fetch cannot run a stale term, and typing does not refetch per key.
   */
  const load = useCallback(() => {
    setLoading(true);
    return adminApi.listUsers({ search: appliedSearch || undefined, ...filters, limit: PAGE_SIZE, offset })
      .then((r) => { setUsers(r.data.rows); setCount(r.data.count); setSummary(r.data.summary); })
      .catch((e) => setError(errorMessage(e, 'Failed to load users')))
      .finally(() => setLoading(false));
  }, [appliedSearch, filters, offset]);

  useEffect(() => { load(); }, [load]);

  /**
   * The account base across the last 30 days, running forward from where it stood
   * a month ago. Deleted accounts leave no row behind, so this is the shape of
   * growth rather than an exact history — which is all a 40px line can claim.
   */
  const cumulativeSignups = useMemo(() => {
    if (!summary) return [];
    let running = Math.max(0, summary.customers - summary.signups.month);
    return summary.signups.byDay.map((day) => { running += day.count; return running; });
  }, [summary]);

  // A narrower filter or search can leave the offset past the end of the results.
  const changeFilters = (next) => { setFilters(next); setOffset(0); };
  const applySearch = () => { setAppliedSearch(search); setOffset(0); };

  const runAction = async (id, fn) => {
    setActionId(id);
    setError('');
    try { await fn(); await load(); } catch (e) { setError(errorMessage(e, 'Action failed')); }
    finally { setActionId(null); }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      await adminApi.createUser(createForm);
      setCreateOpen(false);
      setCreateForm({ name: '', email: '', password: '', role: 'parent', plan: 'free' });
      if (offset === 0) await load(); else setOffset(0);
    } catch (e) { setError(errorMessage(e, 'Failed to create user')); }
  };

  const openEdit = (u) => { setEditUser(u); setEditForm({ name: u.name, email: u.email, plan: u.plan }); };
  const handleEdit = async (e) => {
    e.preventDefault();
    // Changing the email changes the address they sign in with.
    if (editForm.email !== editUser.email && !window.confirm(
      `Change the sign-in email from ${editUser.email} to ${editForm.email}?`
    )) return;
    try { await adminApi.updateUser(editUser.id, editForm); setEditUser(null); await load(); }
    catch (e) { setError(errorMessage(e, 'Failed to update user')); }
  };

  const openRole = (u) => { setRoleUser(u); setRoleForm({ role: u.role, permissions: u.permissions || [] }); };
  const handleRole = async (e) => {
    e.preventDefault();
    if (!window.confirm(
      `Change ${roleUser.email} to ${roleLabel(roleForm.role)}? They will be signed out of every device.`
    )) return;
    try { await adminApi.updateRole(roleUser.id, roleForm); setRoleUser(null); await load(); }
    catch (e) { setError(errorMessage(e, 'Failed to update role')); }
  };

  const openReset = (u) => {
    setResetUser(u);
    setResetMode('generate');
    setResetForm({ password: '', confirm: '' });
    setRevealed(null);
    setError('');
  };

  const handleReset = async (e) => {
    e.preventDefault();
    setError('');

    const manual = resetMode === 'manual';
    if (manual) {
      if (resetForm.password !== resetForm.confirm) return setError('The passwords do not match');
      if (resetForm.password.length < 10) return setError('Password must be at least 10 characters');
      if (!/[a-zA-Z]/.test(resetForm.password) || !/[0-9]/.test(resetForm.password)) {
        return setError('Password must contain at least one letter and one number');
      }
    }

    if (!window.confirm(
      `Set a new password for ${resetUser.email}? Their current password stops working immediately `
      + 'and they are signed out everywhere.'
    )) return;

    setResetting(true);
    try {
      const res = await adminApi.resetUserPassword(resetUser.id, manual ? { password: resetForm.password } : {});
      // Only a generated password needs showing — a chosen one is already known.
      if (res.data.generatedPassword) {
        setRevealed({ email: resetUser.email, password: res.data.generatedPassword });
      }
      setResetUser(null);
      await load();
    } catch (e) {
      setError(errorMessage(e, 'Failed to reset the password'));
    } finally {
      setResetting(false);
    }
  };

  const togglePermission = (key) => {
    setRoleForm((f) => ({
      ...f,
      permissions: f.permissions.includes(key) ? f.permissions.filter((p) => p !== key) : [...f.permissions, key],
    }));
  };

  const columns = [
    {
      key: 'user',
      header: 'User details',
      primary: true,
      cell: (u) => (
        <div className="flex items-center gap-3 min-w-0">
          <Avatar name={u.name} size="sm" />
          {/* Capped rather than merely truncating: an auto-layout table takes its
              width from its content, so a long email would widen this column and
              push the actions into a scroller instead of shortening itself. */}
          <div className="min-w-0 lg:max-w-[11rem] 2xl:max-w-[18rem]">
            <p className="font-semibold text-gray-900 truncate">{u.name}</p>
            <p className="text-xs text-gray-400 truncate">{u.email}</p>
            <span className="flex flex-wrap items-center gap-1 mt-1 empty:hidden">
              {/* A colleague in the customer directory is worth calling out —
                  most of their row's actions do not apply to them. */}
              {isStaffRole(u.role) && <span className="badge-blue">{roleLabel(u.role)}</span>}
              {!u.emailVerified && <span className="badge-amber">Unverified</span>}
            </span>
          </div>
        </div>
      ),
    },
    {
      key: 'plan',
      header: 'Plan type',
      cell: (u) => {
        const plan = planStyle(u.plan);
        return (
          <span className={`${plan.badge} gap-1`}>
            <Icon name={plan.icon} size={12} strokeWidth={2.2} />
            {plan.label}
          </span>
        );
      },
    },
    {
      key: 'devices',
      header: 'Devices',
      align: 'center',
      cell: (u) => (
        <span className={`text-sm font-semibold tabular-nums ${u.deviceCount ? 'text-gray-900' : 'text-gray-300'}`}>
          {u.deviceCount ?? 0}
        </span>
      ),
    },
    {
      key: 'children',
      header: 'Children',
      align: 'center',
      cell: (u) => (
        <span className={`text-sm font-semibold tabular-nums ${u.childCount ? 'text-gray-900' : 'text-gray-300'}`}>
          {u.childCount ?? 0}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (u) => (
        <span className="block min-w-0">
          <span className={`${u.isActive ? 'badge-green' : 'badge-red'} gap-1.5`}>
            <span className={`w-1.5 h-1.5 rounded-full ${u.isActive ? 'bg-success' : 'bg-danger'}`} />
            {u.isActive ? 'Active' : 'Blocked'}
          </span>
          <span className="block text-xs text-gray-400 mt-1 whitespace-nowrap">
            {u.lastLoginAt ? `Seen ${new Date(u.lastLoginAt).toLocaleDateString()}` : 'Never signed in'}
          </span>
        </span>
      ),
    },
  ];

  /**
   * Deleting used to be a two-click affair in the row itself, which left a
   * "Confirm / Cancel" pair sitting where five other buttons already were. Every
   * other irreversible action on this screen confirms in a dialog; this one now
   * does too, and says what goes with the account.
   */
  const confirmDelete = (u) => {
    if (!window.confirm(
      `Delete ${u.email}? Their children, devices and history are deleted with the account. `
      + 'This cannot be undone.'
    )) return;
    runAction(u.id, () => adminApi.deleteClient(u.id));
  };

  const actions = (u) => {
    const staff = isStaffRole(u.role);

    return (
      <>
        {/* Staff accounts are administered on the Staff Accounts screen, so most
            of these do not apply to a colleague who appears in the directory. */}
        {!staff && <RowAction label="Edit" icon="edit" tone="bg-gray-100 text-gray-700 hover:bg-gray-200" onClick={() => openEdit(u)} />}

        {/* Only a Super Admin can move an account across the staff boundary. */}
        {superAdmin && (
          <RowAction
            label="Role and permissions" shortLabel="Role" icon="shield"
            tone="bg-purple-50 text-purple-700 hover:bg-purple-100"
            onClick={() => openRole(u)}
          />
        )}

        {canResetPasswords && !staff && (
          <RowAction
            label="Set a password" shortLabel="Password" icon="lock"
            tone="bg-blue-50 text-blue-700 hover:bg-blue-100"
            onClick={() => openReset(u)}
          />
        )}

        {!u.emailVerified && !staff && (
          <RowAction
            label="Approve" icon="mail" tone="bg-amber-50 text-amber-700 hover:bg-amber-100"
            disabled={actionId === u.id}
            onClick={() => runAction(u.id, () => adminApi.approveUser(u.id))}
          />
        )}

        {!staff && (
          <>
            <RowAction
              label={u.isActive ? 'Block' : 'Unblock'}
              icon={u.isActive ? 'block' : 'check'}
              tone={u.isActive
                ? 'bg-red-50 text-red-600 hover:bg-red-100'
                : 'bg-green-50 text-green-700 hover:bg-green-100'}
              disabled={actionId === u.id}
              onClick={() => runAction(u.id, () => adminApi.toggleBlock(u.id))}
            />
            <RowAction
              label="Delete" icon="trash"
              tone="bg-gray-100 text-gray-500 hover:bg-red-50 hover:text-red-600"
              disabled={actionId === u.id}
              onClick={() => confirmDelete(u)}
            />
          </>
        )}
      </>
    );
  };

  return (
    <div className="space-y-4">
      {error && (
        <p className="notice-error">
          <Icon name="warning" size={16} className="mt-0.5" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')} aria-label="Dismiss" className="shrink-0">
            <Icon name="close" size={16} />
          </button>
        </p>
      )}

      {revealed && (
        <div className="notice-warning block">
          <p className="text-sm font-semibold text-amber-900">New password for {revealed.email}</p>
          <p className="text-xs text-amber-800 mt-1">
            Shown once — it is stored hashed. Send it over a secure channel and have them change it.
          </p>
          <code className="block mt-2 px-3 py-2 bg-white rounded-lg text-sm font-mono break-all border border-amber-200">
            {revealed.password}
          </code>
          <button onClick={() => setRevealed(null)} className="btn-ghost btn-sm mt-2 text-amber-900">
            Dismiss
          </button>
        </div>
      )}

      {/* What the screen is, and the three controls the reference puts beside the
          title: find someone, narrow by plan, add an account. The heading itself
          belongs to the console header, which titles every screen the same way. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-500 max-w-md">
          Manage parent accounts, their subscriptions and how many devices each family has linked.
        </p>

        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <form
            onSubmit={(e) => { e.preventDefault(); applySearch(); }}
            className="relative flex-1 min-w-[11rem] sm:w-64 sm:flex-none"
          >
            <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="search"
              className="input pl-9 sm:min-h-[38px] sm:py-1.5 sm:text-xs"
              placeholder="Search users by name or email…"
              aria-label="Search users"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </form>

          <select
            className="input w-auto sm:min-h-[38px] sm:py-1.5 sm:text-xs"
            value={filters.plan} aria-label="Filter by plan"
            onChange={(e) => changeFilters({ ...filters, plan: e.target.value })}
          >
            <option value="">All plans</option>
            <option value="free">Free</option>
            <option value="premium">Premium</option>
            <option value="suspended">Suspended</option>
          </select>

          <button onClick={() => setCreateOpen(true)} className="btn-primary btn-sm shrink-0">
            <Icon name="plus" size={16} strokeWidth={2.4} />
            Add new user
          </button>
        </div>
      </div>

      {/* The directory at a glance. Customers only — counting ourselves would
          inflate every number here — and unaffected by the filters below. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <StatTile
          label="Total active users"
          value={summary ? summary.active.toLocaleString() : '—'}
          unit="parent accounts"
          icon="children"
          delta={summary ? summary.growth : null}
          deltaLabel="Signups over the previous account base, last 30 days"
        >
          {summary && <Sparkline values={cumulativeSignups} />}
        </StatTile>

        <StatTile
          label="New signups (30 days)"
          value={summary ? summary.signups.month.toLocaleString() : '—'}
          unit="this month"
          icon="sparkle"
          delta={summary ? changeBetween(summary.signups.month, summary.signups.previousMonth) : null}
          deltaLabel="Against the 30 days before that"
        >
          {summary && <DayBars values={summary.signups.byDay.map((d) => d.count)} />}
        </StatTile>

        {/* Renewal rate would need Stripe's subscription history, which nothing
            here aggregates. Paid share is the same question this data can answer
            honestly: how much of the directory is on Premium today. */}
        <StatTile
          label="Premium share"
          value={summary ? `${summary.premiumShare}%` : '—'}
          unit={summary ? `${summary.premium.toLocaleString()} of ${summary.customers.toLocaleString()}` : ''}
          icon="card"
        >
          {summary && <Meter percent={summary.premiumShare} />}
        </StatTile>
      </div>

      <DataTable
        dense
        title={`Users (${count.toLocaleString()})`}
        toolbar={(
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="input w-auto sm:min-h-[38px] sm:py-1.5 sm:text-xs"
              value={filters.role} aria-label="Filter by role"
              onChange={(e) => changeFilters({ ...filters, role: e.target.value })}
            >
              <option value="">All roles</option>
              {ASSIGNABLE_ROLES.map((role) => (
                <option key={role} value={role}>{roleLabel(role)}</option>
              ))}
            </select>
            <select
              className="input w-auto sm:min-h-[38px] sm:py-1.5 sm:text-xs"
              value={filters.status} aria-label="Filter by status"
              onChange={(e) => changeFilters({ ...filters, status: e.target.value })}
            >
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="blocked">Blocked</option>
            </select>
          </div>
        )}
        columns={columns}
        rows={users}
        rowKey={(u) => u.id}
        actions={actions}
        loading={loading}
        loadingLabel="Loading users…"
        empty={
          <EmptyState
            icon="children"
            title="No users found"
            description={appliedSearch ? 'Nothing matches that search.' : 'Customers appear here once they sign up.'}
          />
        }
        pagination={{ offset, limit: PAGE_SIZE, count, onChange: setOffset, disabled: loading, label: 'users' }}
      />

      {/* ── Set a password ─────────────────────────────────────────────────── */}
      <Modal
        open={!!resetUser}
        onClose={() => setResetUser(null)}
        title={resetUser ? `Set a password — ${resetUser.name}` : ''}
        description={resetUser
          ? `For ${resetUser.email}. Their current password stops working immediately and they are signed out everywhere.`
          : undefined}
      >
        <form onSubmit={handleReset} className="space-y-4">
          <div className="space-y-2">
            {[
              { mode: 'generate', label: 'Generate a strong password', hint: 'Shown once after saving.' },
              { mode: 'manual', label: 'Assign a specific password', hint: 'Choose it yourself and tell them directly.' },
            ].map(({ mode, label, hint }) => (
              <label
                key={mode}
                className={`flex gap-3 items-start p-3 rounded-xl border cursor-pointer transition ${
                  resetMode === mode ? 'border-primary-500 bg-primary-50' : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <input
                  type="radio" name="userResetMode" className="mt-1"
                  checked={resetMode === mode} onChange={() => setResetMode(mode)}
                />
                <span>
                  <span className="text-sm font-medium block">{label}</span>
                  <span className="text-xs text-gray-500">{hint}</span>
                </span>
              </label>
            ))}
          </div>

          {resetMode === 'manual' && (
            <div className="space-y-3">
              <label className="field">
                <span className="field-label">New password</span>
                <input
                  className="input" type="password" autoComplete="new-password" required
                  value={resetForm.password}
                  onChange={(e) => setResetForm({ ...resetForm, password: e.target.value })}
                />
                <span className="field-hint">At least 10 characters, with a letter and a number.</span>
              </label>
              <label className="field">
                <span className="field-label">Confirm password</span>
                <input
                  className="input" type="password" autoComplete="new-password" required
                  value={resetForm.confirm}
                  onChange={(e) => setResetForm({ ...resetForm, confirm: e.target.value })}
                />
              </label>
            </div>
          )}

          <button type="submit" className="btn-primary btn-block" disabled={resetting}>
            {resetting ? 'Setting…' : 'Set password'}
          </button>
        </form>
      </Modal>

      {/* ── Create ─────────────────────────────────────────────────────────── */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create a user"
        description={`Creates a parent (customer) account.${superAdmin ? ' To add a colleague, use Staff Accounts.' : ''}`}
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <label className="field">
            <span className="field-label">Name</span>
            <input
              className="input" required value={createForm.name}
              onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Email</span>
            <input
              className="input" type="email" required value={createForm.email}
              onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Password</span>
            <input
              className="input" type="password" autoComplete="new-password" required value={createForm.password}
              onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Plan</span>
            <select
              className="input" value={createForm.plan}
              onChange={(e) => setCreateForm({ ...createForm, plan: e.target.value })}
            >
              <option value="free">Free</option>
              <option value="premium">Premium</option>
            </select>
          </label>
          <button type="submit" className="btn-primary btn-block">Create user</button>
        </form>
      </Modal>

      {/* ── Edit ───────────────────────────────────────────────────────────── */}
      <Modal
        open={!!editUser}
        onClose={() => setEditUser(null)}
        title={editUser ? `Edit ${editUser.name}` : ''}
      >
        <form onSubmit={handleEdit} className="space-y-4">
          <label className="field">
            <span className="field-label">Name</span>
            <input
              className="input" value={editForm.name}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Email</span>
            <input
              className="input" type="email" value={editForm.email}
              onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
            />
            <span className="field-hint">This is the address they sign in with.</span>
          </label>
          <label className="field">
            <span className="field-label">Plan</span>
            <select
              className="input" value={editForm.plan}
              onChange={(e) => setEditForm({ ...editForm, plan: e.target.value })}
            >
              <option value="free">Free</option>
              <option value="premium">Premium</option>
            </select>
          </label>
          <button type="submit" className="btn-primary btn-block">Save changes</button>
        </form>
      </Modal>

      {/* ── Role & permissions ─────────────────────────────────────────────── */}
      <Modal
        open={!!roleUser}
        onClose={() => setRoleUser(null)}
        title={roleUser ? `Role & permissions — ${roleUser.name}` : ''}
        description="Changing a role signs that account out of every device."
      >
        <form onSubmit={handleRole} className="space-y-4">
          <label className="field">
            <span className="field-label">Role</span>
            <select
              className="input"
              value={roleForm.role}
              onChange={(e) => setRoleForm({ role: e.target.value, permissions: defaultPermissionsFor(e.target.value) })}
            >
              {ASSIGNABLE_ROLES.map((role) => (
                <option key={role} value={role}>{roleLabel(role)}</option>
              ))}
            </select>
          </label>

          {isStaffRole(roleForm.role) && roleForm.role !== ROLES.SUPER_ADMIN && (
            <div>
              <p className="field-label mb-2">Permissions</p>
              <div className="space-y-1">
                {PERMISSION_KEYS.map((key) => (
                  <label key={key} className="flex items-center gap-3 min-h-[44px] text-sm cursor-pointer">
                    <input
                      type="checkbox" className="w-4 h-4"
                      checked={roleForm.permissions.includes(key)}
                      onChange={() => togglePermission(key)}
                    />
                    {PERMISSION_LABELS[key]}
                  </label>
                ))}
              </div>
            </div>
          )}
          {roleForm.role === ROLES.SUPER_ADMIN && (
            <p className="text-sm text-gray-500">
              A Super Admin holds every permission, including managing staff accounts.
            </p>
          )}
          {roleForm.role === ROLES.PARENT && (
            <p className="text-sm text-gray-500">A parent is an ordinary customer and holds no staff permissions.</p>
          )}

          <button type="submit" className="btn-primary btn-block">Save role</button>
        </form>
      </Modal>
    </div>
  );
}
