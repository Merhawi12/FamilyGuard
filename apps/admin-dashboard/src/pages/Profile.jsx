import { useState } from 'react';
import {
  auth as authApi, useAuth, errorMessage,
  roleLabel, isSuperAdmin, PERMISSION_LABELS, hasPermission, PERMISSION_KEYS,
} from '@parentix/shared';

/**
 * The signed-in staff member's own account: their name, their email, their
 * password, and a read-only summary of what their role lets them do.
 */
export default function Profile() {
  const { user, setUser } = useAuth();

  const [profile, setProfile] = useState({ name: user?.name || '', email: user?.email || '' });
  const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' });
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [profileMessage, setProfileMessage] = useState('');
  const [profileError, setProfileError] = useState('');
  const [passwordMessage, setPasswordMessage] = useState('');
  const [passwordError, setPasswordError] = useState('');

  const saveProfile = async (e) => {
    e.preventDefault();
    setProfileError(''); setProfileMessage('');

    if (!profile.name.trim()) return setProfileError('Name cannot be empty');

    setSavingProfile(true);
    try {
      const res = await authApi.updateProfile({ name: profile.name.trim(), email: profile.email.trim() });
      // Keep the header and the rest of the console in step with the new name.
      setUser(res.data);
      setProfileMessage('Profile updated');
      setTimeout(() => setProfileMessage(''), 3000);
    } catch (err) {
      setProfileError(errorMessage(err, 'Failed to update your profile'));
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async (e) => {
    e.preventDefault();
    setPasswordError(''); setPasswordMessage('');

    if (passwords.next !== passwords.confirm) return setPasswordError('The new passwords do not match');
    if (passwords.next === passwords.current) return setPasswordError('The new password must be different');

    setSavingPassword(true);
    try {
      await authApi.changePassword({ currentPassword: passwords.current, newPassword: passwords.next });
      setPasswords({ current: '', next: '', confirm: '' });
      setPasswordMessage('Password changed');
      setTimeout(() => setPasswordMessage(''), 3000);
    } catch (err) {
      setPasswordError(errorMessage(err, 'Failed to change your password'));
    } finally {
      setSavingPassword(false);
    }
  };

  const granted = PERMISSION_KEYS.filter((key) => hasPermission(user, key));

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl font-bold">My Profile</h1>
        <p className="text-gray-500 text-sm mt-1">Your staff account details and sign-in credentials.</p>
      </div>

      <div className="card">
        <div className="flex items-start justify-between gap-4 mb-4">
          <h2 className="font-semibold">Details</h2>
          <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 shrink-0">
            {roleLabel(user?.role)}
          </span>
        </div>

        {profileError && <div className="p-3 mb-3 bg-red-50 text-red-700 rounded-xl text-sm">{profileError}</div>}
        {profileMessage && <div className="p-3 mb-3 bg-green-50 text-green-700 rounded-xl text-sm">{profileMessage}</div>}

        <form onSubmit={saveProfile} className="space-y-3">
          <label className="block">
            <span className="text-sm text-gray-500">Full name</span>
            <input
              className="input mt-1"
              value={profile.name}
              onChange={(e) => setProfile({ ...profile, name: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="text-sm text-gray-500">Email</span>
            <input
              className="input mt-1"
              type="email"
              value={profile.email}
              onChange={(e) => setProfile({ ...profile, email: e.target.value })}
            />
            <span className="text-xs text-gray-400 mt-1 block">You sign in with this address.</span>
          </label>
          <button type="submit" className="btn-primary disabled:opacity-60" disabled={savingProfile}>
            {savingProfile ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </div>

      <div className="card">
        <h2 className="font-semibold mb-4">Change password</h2>

        {passwordError && <div className="p-3 mb-3 bg-red-50 text-red-700 rounded-xl text-sm">{passwordError}</div>}
        {passwordMessage && <div className="p-3 mb-3 bg-green-50 text-green-700 rounded-xl text-sm">{passwordMessage}</div>}

        <form onSubmit={savePassword} className="space-y-3">
          <label className="block">
            <span className="text-sm text-gray-500">Current password</span>
            <input
              className="input mt-1" type="password" autoComplete="current-password" required
              value={passwords.current}
              onChange={(e) => setPasswords({ ...passwords, current: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="text-sm text-gray-500">New password</span>
            <input
              className="input mt-1" type="password" autoComplete="new-password" required
              value={passwords.next}
              onChange={(e) => setPasswords({ ...passwords, next: e.target.value })}
            />
            <span className="text-xs text-gray-400 mt-1 block">
              At least 10 characters, including a letter and a number.
            </span>
          </label>
          <label className="block">
            <span className="text-sm text-gray-500">Confirm new password</span>
            <input
              className="input mt-1" type="password" autoComplete="new-password" required
              value={passwords.confirm}
              onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })}
            />
          </label>
          <button type="submit" className="btn-primary disabled:opacity-60" disabled={savingPassword}>
            {savingPassword ? 'Changing…' : 'Change password'}
          </button>
        </form>
      </div>

      <div className="card">
        <h2 className="font-semibold mb-1">What this account can do</h2>
        <p className="text-sm text-gray-500 mb-4">
          {isSuperAdmin(user)
            ? 'A Super Admin holds every permission and is the only role that can manage staff accounts.'
            : 'Set by your role. Ask a Super Admin if you need something else.'}
        </p>
        <ul className="space-y-2">
          {granted.map((key) => (
            <li key={key} className="flex items-center gap-2 text-sm text-gray-700">
              <span className="text-green-600">✔</span> {PERMISSION_LABELS[key]}
            </li>
          ))}
          {!granted.length && <li className="text-sm text-gray-400">No permissions granted yet.</li>}
        </ul>
      </div>
    </div>
  );
}
