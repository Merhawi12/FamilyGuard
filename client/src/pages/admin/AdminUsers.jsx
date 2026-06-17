import { useEffect, useState } from 'react';
import { admin as adminApi } from '../../services/api';

const PLAN_COLORS = {
  premium: 'bg-green-100 text-green-700',
  family: 'bg-purple-100 text-purple-700',
  free: 'bg-gray-100 text-gray-600',
  suspended: 'bg-red-100 text-red-600',
};

const PERMISSIONS = [
  { key: 'manage_users', label: 'Manage Users' },
  { key: 'manage_billing', label: 'Manage Billing' },
  { key: 'manage_settings', label: 'Manage Settings' },
  { key: 'send_notifications', label: 'Send Notifications' },
  { key: 'view_audit_logs', label: 'View Audit Logs' },
  { key: 'manage_sessions', label: 'Manage Sessions' },
];

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
  const [filters, setFilters] = useState({ role: '', plan: '', status: '' });
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', email: '', password: '', role: 'parent', plan: 'free' });
  const [editUser, setEditUser] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', email: '', plan: '' });
  const [roleUser, setRoleUser] = useState(null);
  const [roleForm, setRoleForm] = useState({ role: 'parent', permissions: [] });

  const load = () => {
    setLoading(true);
    adminApi.listUsers({ search: search || undefined, ...filters })
      .then((r) => setUsers(r.data.rows))
      .catch((e) => setError(e.response?.data?.error || 'Failed to load users'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [filters.role, filters.plan, filters.status]);

  const runAction = async (id, fn) => {
    setActionId(id);
    setError('');
    try { await fn(); load(); } catch (e) { setError(e.response?.data?.error || 'Action failed'); }
    finally { setActionId(null); }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      await adminApi.createUser(createForm);
      setCreateOpen(false);
      setCreateForm({ name: '', email: '', password: '', role: 'parent', plan: 'free' });
      load();
    } catch (e) { setError(e.response?.data?.error || 'Failed to create user'); }
  };

  const openEdit = (u) => { setEditUser(u); setEditForm({ name: u.name, email: u.email, plan: u.plan }); };
  const handleEdit = async (e) => {
    e.preventDefault();
    try { await adminApi.updateUser(editUser.id, editForm); setEditUser(null); load(); }
    catch (e) { setError(e.response?.data?.error || 'Failed to update user'); }
  };

  const openRole = (u) => { setRoleUser(u); setRoleForm({ role: u.role, permissions: u.permissions || [] }); };
  const handleRole = async (e) => {
    e.preventDefault();
    try { await adminApi.updateRole(roleUser.id, roleForm); setRoleUser(null); load(); }
    catch (e) { setError(e.response?.data?.error || 'Failed to update role'); }
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

      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="flex flex-wrap gap-2">
          <input
            className="input w-48"
            placeholder="Search name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
          />
          <select className="input w-32" value={filters.role} onChange={(e) => setFilters({ ...filters, role: e.target.value })}>
            <option value="">All roles</option>
            <option value="admin">Admin</option>
            <option value="support">Support</option>
            <option value="parent">Parent</option>
          </select>
          <select className="input w-32" value={filters.plan} onChange={(e) => setFilters({ ...filters, plan: e.target.value })}>
            <option value="">All plans</option>
            <option value="free">Free</option>
            <option value="premium">Premium</option>
            <option value="family">Family</option>
          </select>
          <select className="input w-32" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
            <option value="">All status</option>
            <option value="active">Active</option>
            <option value="blocked">Blocked</option>
          </select>
          <button onClick={load} className="btn-ghost text-sm">Search</button>
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
                    <td className="px-6 py-4 capitalize">{u.role}</td>
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
                        <button onClick={() => openEdit(u)} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition">Edit</button>
                        <button onClick={() => openRole(u)} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-purple-50 text-purple-600 hover:bg-purple-100 transition">Role</button>

                        {!u.emailVerified && (
                          <button disabled={actionId === u.id} onClick={() => runAction(u.id, () => adminApi.approveUser(u.id))}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-yellow-50 text-yellow-700 hover:bg-yellow-100 transition">
                            Approve
                          </button>
                        )}

                        {u.role !== 'admin' && (
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
      </div>

      {createOpen && (
        <Modal title="Create User" onClose={() => setCreateOpen(false)}>
          <form onSubmit={handleCreate} className="space-y-3">
            <input className="input" placeholder="Name" required value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} />
            <input className="input" type="email" placeholder="Email" required value={createForm.email} onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })} />
            <input className="input" type="password" placeholder="Password" required value={createForm.password} onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} />
            <select className="input" value={createForm.role} onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })}>
              <option value="parent">Parent</option>
              <option value="support">Support</option>
              <option value="admin">Admin</option>
            </select>
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
            <select className="input" value={roleForm.role} onChange={(e) => setRoleForm({ ...roleForm, role: e.target.value })}>
              <option value="parent">Parent</option>
              <option value="support">Support</option>
              <option value="admin">Admin</option>
            </select>
            {roleForm.role !== 'admin' && (
              <div>
                <p className="text-sm font-medium mb-2">Permissions (admins have full access by default)</p>
                <div className="space-y-2">
                  {PERMISSIONS.map(({ key, label }) => (
                    <label key={key} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={roleForm.permissions.includes(key)} onChange={() => togglePermission(key)} />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <button type="submit" className="btn-primary w-full">Save Role</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
