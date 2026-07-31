import { useEffect, useState, useCallback } from 'react';
import {
  admin as adminApi, errorMessage, useAuth, Pagination,
  ROLES, STAFF_ROLES, roleLabel, isSuperAdmin, hasPermission, PERMISSIONS,
  PERMISSION_KEYS, PERMISSION_LABELS, defaultPermissionsFor,
} from '@parentix/shared';

const PAGE_SIZE = 50;

const PLAN_COLORS = {
  premium: 'bg-green-100 text-green-700',
  family: 'bg-purple-100 text-purple-700',
  free: 'bg-gray-100 text-gray-600',
  suspended: 'bg-red-100 text-red-600',
};

// Parent plus every department. Editing an existing staff account's role and
// permissions belongs on the Staff Accounts screen; this modal is the way an
// account crosses the customer/staff boundary.
const ASSIGNABLE_ROLES = [ROLES.PARENT, ...STAFF_ROLES];

const isStaffRole = (role) => STAFF_ROLES.includes(role);

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-lg">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionId, setActionId] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
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
      .then((r) => { setUsers(r.data.rows); setCount(r.data.count); })
      .catch((e) => setError(errorMessage(e, 'Failed to load users')))
      .finally(() => setLoading(false));
  }, [appliedSearch, filters, offset]);

  useEffect(() => { load(); }, [load]);

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

  if (loading && users.length === 0) return <div className="text-gray-400">Loading users...</div>;

  return (
    <div className="space-y-4">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl flex justify-between">
          {error}
          <button onClick={() => setError('')} className="font-bold">×</button>
        </div>
      )}

      {revealed && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl">
          <p className="text-sm font-semibold text-amber-900">New password for {revealed.email}</p>
          <p className="text-xs text-amber-800 mt-1">
            Shown once — it is stored hashed. Send it to them over a secure channel and have them change it.
          </p>
          <code className="block mt-2 px-3 py-2 bg-white rounded-lg text-sm font-mono break-all border border-amber-200">
            {revealed.password}
          </code>
          <button onClick={() => setRevealed(null)} className="text-xs text-amber-900 underline mt-2">Dismiss</button>
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="flex flex-wrap gap-2">
          <input
            className="input w-48"
            placeholder="Search name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applySearch()}
          />
          <select className="input w-32" value={filters.role} onChange={(e) => changeFilters({ ...filters, role: e.target.value })}>
            <option value="">All roles</option>
            <option value="admin">Admin</option>
            <option value="support">Support</option>
            <option value="parent">Parent</option>
          </select>
          <select className="input w-32" value={filters.plan} onChange={(e) => changeFilters({ ...filters, plan: e.target.value })}>
            <option value="">All plans</option>
            <option value="free">Free</option>
            <option value="premium">Premium</option>
            <option value="family">Family</option>
          </select>
          <select className="input w-32" value={filters.status} onChange={(e) => changeFilters({ ...filters, status: e.target.value })}>
            <option value="">All status</option>
            <option value="active">Active</option>
            <option value="blocked">Blocked</option>
          </select>
          <button onClick={applySearch} className="btn-ghost text-sm">Search</button>
        </div>
        <button onClick={() => setCreateOpen(true)} className="btn-primary text-sm">+ Create User</button>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800">Users ({users.length})</h2>
        </div>

        {users.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">No users found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-6 py-3 text-left">User</th>
                  <th className="px-6 py-3 text-left">Role</th>
                  <th className="px-6 py-3 text-left">Plan</th>
                  <th className="px-6 py-3 text-left">Status</th>
                  <th className="px-6 py-3 text-left">Last Login</th>
                  <th className="px-6 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-gray-50 transition">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 bg-blue-100 rounded-full flex items-center justify-center font-bold text-blue-600 text-sm">
                          {u.name[0].toUpperCase()}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">{u.name}</p>
                          <p className="text-xs text-gray-400">{u.email}</p>
                          {!u.emailVerified && <span className="text-xs text-yellow-600">Unverified</span>}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">{roleLabel(u.role)}</td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 rounded-lg text-xs font-medium ${PLAN_COLORS[u.plan] || 'bg-gray-100 text-gray-600'}`}>{u.plan}</span>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 rounded-lg text-xs font-medium ${u.isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>
                        {u.isActive ? 'Active' : 'Blocked'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-gray-400 text-xs">
                      {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : 'Never'}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2 justify-end flex-wrap">
                        {!isStaffRole(u.role) && (
                          <button onClick={() => openEdit(u)} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition">Edit</button>
                        )}
                        {/* Only a Super Admin can move an account across the staff boundary. */}
                        {superAdmin && (
                          <button onClick={() => openRole(u)} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-purple-50 text-purple-600 hover:bg-purple-100 transition">Role</button>
                        )}
                        {/* Staff passwords are reset from the Staff Accounts screen. */}
                        {canResetPasswords && !isStaffRole(u.role) && (
                          <button onClick={() => openReset(u)} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-50 text-blue-600 hover:bg-blue-100 transition">Password</button>
                        )}

                        {!u.emailVerified && !isStaffRole(u.role) && (
                          <button disabled={actionId === u.id} onClick={() => runAction(u.id, () => adminApi.approveUser(u.id))}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-yellow-50 text-yellow-700 hover:bg-yellow-100 transition">
                            Approve
                          </button>
                        )}

                        {/* Staff accounts are administered on the Staff Accounts screen. */}
                        {!isStaffRole(u.role) && (
                          <>
                            <button disabled={actionId === u.id} onClick={() => runAction(u.id, () => adminApi.toggleBlock(u.id))}
                              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${u.isActive ? 'bg-red-50 text-red-600 hover:bg-red-100' : 'bg-green-50 text-green-600 hover:bg-green-100'}`}>
                              {u.isActive ? 'Block' : 'Unblock'}
                            </button>

                            {deleteConfirm === u.id ? (
                              <>
                                <button disabled={actionId === u.id} onClick={() => runAction(u.id, () => adminApi.deleteClient(u.id))}
                                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-600 text-white hover:bg-red-700 transition">Confirm</button>
                                <button onClick={() => setDeleteConfirm(null)} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition">Cancel</button>
                              </>
                            ) : (
                              <button onClick={() => setDeleteConfirm(u.id)} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 text-gray-500 hover:bg-red-50 hover:text-red-600 transition">Delete</button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="px-6 pb-4">
          <Pagination
            offset={offset} limit={PAGE_SIZE} count={count}
            onChange={setOffset} disabled={loading} label="users"
          />
        </div>
      </div>

      {resetUser && (
        <Modal title={`Set a password — ${resetUser.name}`} onClose={() => setResetUser(null)}>
          <form onSubmit={handleReset} className="space-y-4">
            <p className="text-sm text-gray-500">
              For <span className="font-medium text-gray-700">{resetUser.email}</span>. Their current password stops
              working immediately and they are signed out everywhere.
            </p>

            <div className="space-y-2">
              <label className={`flex gap-2 items-start p-3 rounded-xl border cursor-pointer transition ${
                resetMode === 'generate' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'
              }`}>
                <input type="radio" name="userResetMode" className="mt-1" checked={resetMode === 'generate'}
                  onChange={() => setResetMode('generate')} />
                <span>
                  <span className="text-sm font-medium block">Generate a strong password</span>
                  <span className="text-xs text-gray-500">Shown once after saving.</span>
                </span>
              </label>
              <label className={`flex gap-2 items-start p-3 rounded-xl border cursor-pointer transition ${
                resetMode === 'manual' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'
              }`}>
                <input type="radio" name="userResetMode" className="mt-1" checked={resetMode === 'manual'}
                  onChange={() => setResetMode('manual')} />
                <span>
                  <span className="text-sm font-medium block">Assign a specific password</span>
                  <span className="text-xs text-gray-500">Choose it yourself and tell them directly.</span>
                </span>
              </label>
            </div>

            {resetMode === 'manual' && (
              <div className="space-y-3">
                <label className="block">
                  <span className="text-sm text-gray-500">New password</span>
                  <input className="input mt-1" type="password" autoComplete="new-password" required
                    value={resetForm.password}
                    onChange={(e) => setResetForm({ ...resetForm, password: e.target.value })} />
                  <span className="text-xs text-gray-400 mt-1 block">
                    At least 10 characters, with a letter and a number.
                  </span>
                </label>
                <label className="block">
                  <span className="text-sm text-gray-500">Confirm password</span>
                  <input className="input mt-1" type="password" autoComplete="new-password" required
                    value={resetForm.confirm}
                    onChange={(e) => setResetForm({ ...resetForm, confirm: e.target.value })} />
                </label>
              </div>
            )}

            <button type="submit" className="btn-primary w-full disabled:opacity-60" disabled={resetting}>
              {resetting ? 'Setting…' : 'Set password'}
            </button>
          </form>
        </Modal>
      )}

      {createOpen && (
        <Modal title="Create User" onClose={() => setCreateOpen(false)}>
          <form onSubmit={handleCreate} className="space-y-3">
            <input className="input" placeholder="Name" required value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} />
            <input className="input" type="email" placeholder="Email" required value={createForm.email} onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })} />
            <input className="input" type="password" placeholder="Password" required value={createForm.password} onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} />
            {/* This screen creates customers. Staff accounts carry privileges, so
                they are created on the Staff Accounts screen by a Super Admin. */}
            <p className="text-xs text-gray-500">
              Creates a parent (customer) account.{superAdmin && ' To add a colleague, use Staff Accounts.'}
            </p>
            <select className="input" value={createForm.plan} onChange={(e) => setCreateForm({ ...createForm, plan: e.target.value })}>
              <option value="free">Free</option>
              <option value="premium">Premium</option>
              <option value="family">Family</option>
            </select>
            <button type="submit" className="btn-primary w-full">Create</button>
          </form>
        </Modal>
      )}

      {editUser && (
        <Modal title={`Edit ${editUser.name}`} onClose={() => setEditUser(null)}>
          <form onSubmit={handleEdit} className="space-y-3">
            <input className="input" placeholder="Name" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
            <input className="input" type="email" placeholder="Email" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
            <select className="input" value={editForm.plan} onChange={(e) => setEditForm({ ...editForm, plan: e.target.value })}>
              <option value="free">Free</option>
              <option value="premium">Premium</option>
              <option value="family">Family</option>
            </select>
            <button type="submit" className="btn-primary w-full">Save</button>
          </form>
        </Modal>
      )}

      {roleUser && (
        <Modal title={`Role & Permissions — ${roleUser.name}`} onClose={() => setRoleUser(null)}>
          <form onSubmit={handleRole} className="space-y-4">
            <select
              className="input"
              value={roleForm.role}
              onChange={(e) => setRoleForm({ role: e.target.value, permissions: defaultPermissionsFor(e.target.value) })}
            >
              {ASSIGNABLE_ROLES.map((role) => (
                <option key={role} value={role}>{roleLabel(role)}</option>
              ))}
            </select>

            {isStaffRole(roleForm.role) && roleForm.role !== ROLES.SUPER_ADMIN && (
              <div>
                <p className="text-sm font-medium mb-2">Permissions</p>
                <div className="space-y-2">
                  {PERMISSION_KEYS.map((key) => (
                    <label key={key} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={roleForm.permissions.includes(key)} onChange={() => togglePermission(key)} />
                      {PERMISSION_LABELS[key]}
                    </label>
                  ))}
                </div>
              </div>
            )}
            {roleForm.role === ROLES.SUPER_ADMIN && (
              <p className="text-sm text-gray-500">A Super Admin holds every permission, including managing staff accounts.</p>
            )}
            {roleForm.role === ROLES.PARENT && (
              <p className="text-sm text-gray-500">A parent is an ordinary customer and holds no staff permissions.</p>
            )}
            <p className="text-xs text-gray-400">Changing a role signs that account out.</p>
            <button type="submit" className="btn-primary w-full">Save Role</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
