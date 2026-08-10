import { useEffect, useState, useCallback } from 'react';
import {
  admin as adminApi, useAuth, errorMessage, EmptyState, Icon, Modal,
  ROLES, STAFF_ROLES, roleLabel, PERMISSION_KEYS, PERMISSION_LABELS,
  PERMISSION_DESCRIPTIONS, defaultPermissionsFor,
} from '@parentix/shared';
import DataTable from '../components/DataTable';

const ROLE_BLURB = {
  [ROLES.SUPER_ADMIN]: 'Full control, including staff accounts.',
  [ROLES.OPERATIONS]: 'Day-to-day platform running: users, sessions, settings.',
  [ROLES.SUPPORT]: 'Helps customers: user directory and sessions.',
  [ROLES.FINANCE]: 'Billing and transactions. No access to family data.',
  [ROLES.MARKETING]: 'Customer announcements. No access to family data.',
};

const EMPTY_FORM = { name: '', email: '', role: ROLES.SUPPORT, permissions: defaultPermissionsFor(ROLES.SUPPORT) };

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

  const columns = [
    {
      key: 'member',
      header: 'Name',
      primary: true,
      cell: (member) => (
        <>
          <p className="font-medium text-gray-900 truncate">
            {member.name}
            {member.id === user?.id && <span className="text-xs text-gray-400 font-normal"> (you)</span>}
          </p>
          <p className="text-xs text-gray-400 truncate">{member.email}</p>
        </>
      ),
    },
    { key: 'role', header: 'Role', cell: (member) => <span className="badge-blue">{roleLabel(member.role)}</span> },
    {
      key: 'permissions',
      header: 'Permissions',
      cell: (member) => (member.role === ROLES.SUPER_ADMIN ? (
        <span className="text-xs text-gray-500">All permissions</span>
      ) : (
        <div className="flex flex-wrap gap-1 justify-end lg:justify-start lg:max-w-xs">
          {(member.permissions || []).length
            ? member.permissions.map((p) => <span key={p} className="badge-gray">{PERMISSION_LABELS[p] || p}</span>)
            : <span className="text-xs text-gray-400">None</span>}
        </div>
      )),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (member) => (
        <span className={member.isActive ? 'badge-green' : 'badge-red'}>
          {member.isActive ? 'Active' : 'Deactivated'}
        </span>
      ),
    },
  ];

  const actions = (member) => {
    const isSelf = member.id === user?.id;
    const busy = busyId === member.id;
    return (
      <>
        <button onClick={() => openEdit(member)} disabled={busy} className="btn btn-sm bg-gray-100 text-gray-700 hover:bg-gray-200">
          Edit
        </button>
        <button onClick={() => openReset(member)} disabled={busy} className="btn btn-sm bg-blue-50 text-blue-700 hover:bg-blue-100">
          Reset password
        </button>
        {/* A Super Admin cannot switch off or delete their own account — that is
            what guarantees one always remains. */}
        <button
          onClick={() => toggleActive(member)}
          disabled={busy || isSelf}
          title={isSelf ? 'You cannot deactivate your own account' : ''}
          className="btn btn-sm bg-amber-50 text-amber-700 hover:bg-amber-100"
        >
          {member.isActive ? 'Deactivate' : 'Activate'}
        </button>
        <button
          onClick={() => remove(member)}
          disabled={busy || isSelf}
          title={isSelf ? 'You cannot delete your own account' : ''}
          className="btn btn-sm bg-red-50 text-red-600 hover:bg-red-100"
        >
          Delete
        </button>
      </>
    );
  };

  const passwordModeChoices = [
    { mode: 'generate', label: 'Generate a strong password', hint: 'Shown once after saving, for you to pass on securely.' },
    { mode: 'manual', label: 'Set a specific password', hint: 'Choose it yourself — useful for a temporary hand-over.' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-500 flex-1 min-w-0">
          Department accounts and what each one is allowed to do. Only a Super Admin sees this screen.
        </p>
        <button onClick={openCreate} className="btn-primary btn-sm shrink-0">
          <Icon name="plus" size={16} strokeWidth={2.4} />
          New staff account
        </button>
      </div>

      {error && <p className="notice-error">{error}</p>}
      {notice && <p className="notice-success">{notice}</p>}

      {revealed && (
        <div className="notice-warning block">
          <p className="text-sm font-semibold text-amber-900">Password for {revealed.email}</p>
          <p className="text-xs text-amber-800 mt-1">
            Shown once — it is stored hashed. Send it over a secure channel and have them change it.
          </p>
          <code className="block mt-2 px-3 py-2 bg-white rounded-lg text-sm font-mono break-all border border-amber-200">
            {revealed.password}
          </code>
          <button onClick={() => setRevealed(null)} className="btn-ghost btn-sm mt-2 text-amber-900">Dismiss</button>
        </div>
      )}

      <DataTable
        title={`Staff accounts (${staff.length})`}
        columns={columns}
        rows={staff}
        rowKey={(member) => member.id}
        actions={actions}
        loading={loading}
        loadingLabel="Loading staff accounts…"
        empty={
          <EmptyState
            icon="shield"
            title="No staff accounts yet"
            description="Create one to give a colleague access to this console."
            action={<button onClick={openCreate} className="btn-primary">New staff account</button>}
          />
        }
      />

      {/* ── Create / edit ──────────────────────────────────────────────────── */}
      <Modal
        open={showForm}
        onClose={() => { setShowForm(false); setEditingId(null); }}
        size="lg"
        title={editingId ? 'Edit staff account' : 'New staff account'}
        description={editingId
          ? 'Saving signs this account out, so the new permissions take effect immediately.'
          : 'A strong password is generated and shown once after you save.'}
      >
        <form onSubmit={submit} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="field">
              <span className="field-label">Full name</span>
              <input
                className="input" required value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">Email</span>
              <input
                className="input" type="email" required value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </label>
          </div>

          <div>
            <p className="field-label mb-2">Department</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {STAFF_ROLES.map((role) => (
                <label
                  key={role}
                  className={`flex gap-3 items-start p-3 rounded-xl border cursor-pointer transition ${
                    form.role === role ? 'border-primary-500 bg-primary-50' : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <input
                    type="radio" name="role" className="mt-1"
                    checked={form.role === role} onChange={() => changeRole(role)}
                  />
                  <span>
                    <span className="text-sm font-medium block">{roleLabel(role)}</span>
                    <span className="text-xs text-gray-500">{ROLE_BLURB[role]}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <p className="field-label">Permissions</p>
            <p className="text-xs text-gray-400 mb-2">
              {form.role === ROLES.SUPER_ADMIN
                ? 'A Super Admin always holds every permission.'
                : 'Starts from the role defaults — adjust for this person only.'}
            </p>
            <div className="space-y-1">
              {PERMISSION_KEYS.map((key) => (
                <label key={key} className="flex gap-3 items-start py-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1 w-4 h-4"
                    disabled={form.role === ROLES.SUPER_ADMIN}
                    checked={form.role === ROLES.SUPER_ADMIN || form.permissions.includes(key)}
                    onChange={() => togglePermission(key)}
                  />
                  <span>
                    <span className="text-sm block text-gray-900">{PERMISSION_LABELS[key]}</span>
                    <span className="text-xs text-gray-400">{PERMISSION_DESCRIPTIONS[key]}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex flex-col-reverse sm:flex-row gap-2">
            <button
              type="button"
              onClick={() => { setShowForm(false); setEditingId(null); }}
              className="btn-secondary sm:w-auto btn-block"
            >
              Cancel
            </button>
            <button type="submit" className="btn-primary btn-block sm:w-auto" disabled={saving}>
              {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create account'}
            </button>
          </div>
        </form>
      </Modal>

      {/* ── Reset password ─────────────────────────────────────────────────── */}
      <Modal
        open={!!resetTarget}
        onClose={() => setResetTarget(null)}
        title="Reset password"
        description={resetTarget
          ? `For ${resetTarget.name} (${resetTarget.email}). Their current password stops working immediately and they are signed out everywhere.`
          : undefined}
      >
        <form onSubmit={submitReset} className="space-y-4">
          <div className="space-y-2">
            {passwordModeChoices.map(({ mode, label, hint }) => (
              <label
                key={mode}
                className={`flex gap-3 items-start p-3 rounded-xl border cursor-pointer transition ${
                  resetMode === mode ? 'border-primary-500 bg-primary-50' : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <input
                  type="radio" name="resetMode" className="mt-1"
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

          {error && <p className="notice-error">{error}</p>}

          <button type="submit" className="btn-primary btn-block" disabled={resetting}>
            {resetting ? 'Resetting…' : 'Reset password'}
          </button>
        </form>
      </Modal>
    </div>
  );
}
