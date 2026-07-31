import { useEffect, useState, useCallback } from 'react';
import {
  admin as adminApi, useAuth, errorMessage,
  ROLES, STAFF_ROLES, roleLabel, PERMISSION_KEYS, PERMISSION_LABELS,
  PERMISSION_DESCRIPTIONS, defaultPermissionsFor,
} from '@parentix/shared';

const ROLE_BLURB = {
  [ROLES.SUPER_ADMIN]: 'Full control, including staff accounts.',
  [ROLES.OPERATIONS]: 'Day-to-day platform running: users, sessions, settings.',
  [ROLES.SUPPORT]: 'Helps customers: user directory and sessions.',
  [ROLES.FINANCE]: 'Billing and transactions. No access to family data.',
  [ROLES.MARKETING]: 'Customer announcements. No access to family data.',
};

const EMPTY_FORM = { name: '', email: '', role: ROLES.SUPPORT, permissions: defaultPermissionsFor(ROLES.SUPPORT) };

const Badge = ({ children, tone = 'gray' }) => {
  const tones = {
    gray: 'bg-gray-100 text-gray-600',
    blue: 'bg-blue-50 text-blue-700',
    green: 'bg-green-50 text-green-700',
    red: 'bg-red-50 text-red-700',
  };
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${tones[tone]}`}>{children}</span>;
};

export default function Staff() {
  const { user } = useAuth();
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Shown once, after create or reset — the API never returns it again.
  const [revealed, setRevealed] = useState(null);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);

  // Resetting a password: either generate one or type the one you want.
  const [resetTarget, setResetTarget] = useState(null);
  const [resetMode, setResetMode] = useState('generate');
  const [resetForm, setResetForm] = useState({ password: '', confirm: '' });
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await adminApi.listStaff();
      setStaff(res.data.staff);
    } catch (err) {
      setError(errorMessage(err, 'Failed to load staff accounts'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const flash = (message) => { setNotice(message); setTimeout(() => setNotice(''), 4000); };

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setRevealed(null);
    setResetTarget(null);
    setError('');
    setShowForm(true);
  };

  const openEdit = (member) => {
    setEditingId(member.id);
    setForm({
      name: member.name,
      email: member.email,
      role: member.role,
      permissions: Array.isArray(member.permissions) ? member.permissions : [],
    });
    setRevealed(null);
    setResetTarget(null);
    setError('');
    setShowForm(true);
  };

  // Changing role re-seeds the defaults, which is what you almost always want;
  // individual boxes can still be adjusted afterwards.
  const changeRole = (role) => setForm((f) => ({ ...f, role, permissions: defaultPermissionsFor(role) }));

  const togglePermission = (key) => setForm((f) => ({
    ...f,
    permissions: f.permissions.includes(key)
      ? f.permissions.filter((p) => p !== key)
      : [...f.permissions, key],
  }));

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setSaving(true);
    try {
      if (editingId) {
        await adminApi.updateStaff(editingId, form);
        flash('Staff account updated. Their sessions were signed out.');
      } else {
        const res = await adminApi.createStaff(form);
        if (res.data.generatedPassword) {
          setRevealed({ email: res.data.staff.email, password: res.data.generatedPassword });
        }
        flash(`Created ${res.data.staff.email}`);
      }
      setShowForm(false);
      setEditingId(null);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Failed to save the staff account'));
    } finally {
      setSaving(false);
    }
  };

  const act = async (id, fn, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setError(''); setBusyId(id);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(errorMessage(err, 'That action could not be completed'));
    } finally {
      setBusyId(null);
    }
  };

  const toggleActive = (member) => act(
    member.id,
    async () => {
      await adminApi.setStaffStatus(member.id, !member.isActive);
      flash(`${member.email} ${member.isActive ? 'deactivated' : 'reactivated'}`);
    },
    member.isActive ? `Deactivate ${member.email}? They will be signed out and cannot sign in again.` : null
  );

  const openReset = (member) => {
    setResetTarget(member);
    setResetMode('generate');
    setResetForm({ password: '', confirm: '' });
    setShowForm(false);
    setRevealed(null);
    setError('');
  };

  const submitReset = async (e) => {
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

    setResetting(true);
    try {
      const res = await adminApi.resetStaffPassword(resetTarget.id, manual ? { password: resetForm.password } : {});
      // Only a generated password needs showing — a chosen one is already known.
      if (res.data.generatedPassword) {
        setRevealed({ email: resetTarget.email, password: res.data.generatedPassword });
      }
      flash(`Password reset for ${resetTarget.email}. They were signed out.`);
      setResetTarget(null);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Failed to reset the password'));
    } finally {
      setResetting(false);
    }
  };

  const remove = (member) => act(
    member.id,
    async () => {
      await adminApi.deleteStaff(member.id);
      flash(`Deleted ${member.email}`);
    },
    `Permanently delete ${member.email}? This cannot be undone.`
  );

  if (loading) return <div className="text-gray-400 text-sm">Loading staff accounts…</div>;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">Staff Accounts</h1>
          <p className="text-gray-500 text-sm mt-1">
            Department accounts and what each one is allowed to do. Only a Super Admin sees this screen.
          </p>
        </div>
        <button onClick={openCreate} className="btn-primary shrink-0">+ New staff account</button>
      </div>

      {error && <div className="p-3 bg-red-50 text-red-700 rounded-xl text-sm">{error}</div>}
      {notice && <div className="p-3 bg-green-50 text-green-700 rounded-xl text-sm">{notice}</div>}

      {revealed && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl">
          <p className="text-sm font-semibold text-amber-900">Password for {revealed.email}</p>
          <p className="text-xs text-amber-800 mt-1">
            Shown once — it is stored hashed. Send it to them over a secure channel and have them change it.
          </p>
          <code className="block mt-2 px-3 py-2 bg-white rounded-lg text-sm font-mono break-all border border-amber-200">
            {revealed.password}
          </code>
          <button onClick={() => setRevealed(null)} className="text-xs text-amber-900 underline mt-2">Dismiss</button>
        </div>
      )}

      {resetTarget && (
        <form onSubmit={submitReset} className="card space-y-4">
          <div>
            <h2 className="font-semibold">Reset password</h2>
            <p className="text-sm text-gray-500 mt-1">
              For <span className="font-medium text-gray-700">{resetTarget.name}</span> ({resetTarget.email}).
              Their current password stops working immediately and they are signed out everywhere.
            </p>
          </div>

          <div className="space-y-2">
            <label className={`flex gap-2 items-start p-3 rounded-xl border cursor-pointer transition ${
              resetMode === 'generate' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'
            }`}>
              <input type="radio" name="resetMode" className="mt-1" checked={resetMode === 'generate'}
                onChange={() => setResetMode('generate')} />
              <span>
                <span className="text-sm font-medium block">Generate a strong password</span>
                <span className="text-xs text-gray-500">Shown once after saving, for you to pass on securely.</span>
              </span>
            </label>

            <label className={`flex gap-2 items-start p-3 rounded-xl border cursor-pointer transition ${
              resetMode === 'manual' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'
            }`}>
              <input type="radio" name="resetMode" className="mt-1" checked={resetMode === 'manual'}
                onChange={() => setResetMode('manual')} />
              <span>
                <span className="text-sm font-medium block">Set a specific password</span>
                <span className="text-xs text-gray-500">Choose it yourself — useful for a temporary hand-over.</span>
              </span>
            </label>
          </div>

          {resetMode === 'manual' && (
            <div className="grid gap-3 sm:grid-cols-2">
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

          <div className="flex gap-2">
            <button type="submit" className="btn-primary disabled:opacity-60" disabled={resetting}>
              {resetting ? 'Resetting…' : 'Reset password'}
            </button>
            <button type="button" onClick={() => setResetTarget(null)}
              className="px-4 py-2 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
              Cancel
            </button>
          </div>
        </form>
      )}

      {showForm && (
        <form onSubmit={submit} className="card space-y-4">
          <h2 className="font-semibold">{editingId ? 'Edit staff account' : 'New staff account'}</h2>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm text-gray-500">Full name</span>
              <input className="input mt-1" required value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="block">
              <span className="text-sm text-gray-500">Email</span>
              <input className="input mt-1" type="email" required value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </label>
          </div>

          <div>
            <span className="text-sm text-gray-500">Department / role</span>
            <div className="grid gap-2 sm:grid-cols-2 mt-2">
              {STAFF_ROLES.map((role) => (
                <label key={role}
                  className={`flex gap-2 items-start p-3 rounded-xl border cursor-pointer transition ${
                    form.role === role ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'
                  }`}>
                  <input type="radio" name="role" className="mt-1" checked={form.role === role}
                    onChange={() => changeRole(role)} />
                  <span>
                    <span className="text-sm font-medium block">{roleLabel(role)}</span>
                    <span className="text-xs text-gray-500">{ROLE_BLURB[role]}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <span className="text-sm text-gray-500">Permissions</span>
            <p className="text-xs text-gray-400 mb-2">
              {form.role === ROLES.SUPER_ADMIN
                ? 'A Super Admin always holds every permission.'
                : 'Starts from the role defaults — adjust for this person only.'}
            </p>
            <div className="space-y-2">
              {PERMISSION_KEYS.map((key) => (
                <label key={key} className="flex gap-2 items-start">
                  <input
                    type="checkbox"
                    className="mt-1"
                    disabled={form.role === ROLES.SUPER_ADMIN}
                    checked={form.role === ROLES.SUPER_ADMIN || form.permissions.includes(key)}
                    onChange={() => togglePermission(key)}
                  />
                  <span>
                    <span className="text-sm block">{PERMISSION_LABELS[key]}</span>
                    <span className="text-xs text-gray-400">{PERMISSION_DESCRIPTIONS[key]}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {!editingId && (
            <p className="text-xs text-gray-500">
              A strong password is generated and shown once after you save.
            </p>
          )}
          {editingId && (
            <p className="text-xs text-gray-500">
              Saving signs this account out, so the new permissions take effect immediately.
            </p>
          )}

          <div className="flex gap-2">
            <button type="submit" className="btn-primary disabled:opacity-60" disabled={saving}>
              {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create account'}
            </button>
            <button type="button" onClick={() => { setShowForm(false); setEditingId(null); }}
              className="px-4 py-2 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead>
            <tr className="text-left text-gray-500 text-xs uppercase">
              <th className="py-2">Name</th>
              <th className="py-2">Role</th>
              <th className="py-2">Permissions</th>
              <th className="py-2">Status</th>
              <th className="py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((member) => {
              const isSelf = member.id === user?.id;
              const busy = busyId === member.id;
              return (
                <tr key={member.id} className="border-t border-gray-100 align-top">
                  <td className="py-3">
                    <p className="font-medium">{member.name} {isSelf && <span className="text-xs text-gray-400">(you)</span>}</p>
                    <p className="text-xs text-gray-400">{member.email}</p>
                  </td>
                  <td className="py-3"><Badge tone="blue">{roleLabel(member.role)}</Badge></td>
                  <td className="py-3">
                    {member.role === ROLES.SUPER_ADMIN ? (
                      <span className="text-xs text-gray-500">All permissions</span>
                    ) : (
                      <div className="flex flex-wrap gap-1 max-w-xs">
                        {(member.permissions || []).length
                          ? member.permissions.map((p) => <Badge key={p}>{PERMISSION_LABELS[p] || p}</Badge>)
                          : <span className="text-xs text-gray-400">None</span>}
                      </div>
                    )}
                  </td>
                  <td className="py-3">
                    <Badge tone={member.isActive ? 'green' : 'red'}>{member.isActive ? 'Active' : 'Deactivated'}</Badge>
                  </td>
                  <td className="py-3">
                    <div className="flex gap-2 justify-end flex-wrap">
                      <button onClick={() => openEdit(member)} disabled={busy}
                        className="text-xs text-blue-600 hover:underline disabled:opacity-40">Edit</button>
                      <button onClick={() => openReset(member)} disabled={busy}
                        className="text-xs text-blue-600 hover:underline disabled:opacity-40">Reset password</button>
                      {/* A Super Admin cannot switch off or delete their own account —
                          that is what guarantees one always remains. */}
                      <button onClick={() => toggleActive(member)} disabled={busy || isSelf}
                        className="text-xs text-amber-700 hover:underline disabled:opacity-40 disabled:no-underline"
                        title={isSelf ? 'You cannot deactivate your own account' : ''}>
                        {member.isActive ? 'Deactivate' : 'Activate'}
                      </button>
                      <button onClick={() => remove(member)} disabled={busy || isSelf}
                        className="text-xs text-red-600 hover:underline disabled:opacity-40 disabled:no-underline"
                        title={isSelf ? 'You cannot delete your own account' : ''}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!staff.length && <p className="text-sm text-gray-400 py-6 text-center">No staff accounts yet.</p>}
      </div>
    </div>
  );
}
