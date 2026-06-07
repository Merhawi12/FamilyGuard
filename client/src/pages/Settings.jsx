import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

export default function Settings() {
  const { user } = useAuth();
  const [profile, setProfile] = useState({ name: user?.name || '', email: user?.email || '' });
  const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' });
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');

  const saveProfile = async (e) => {
    e.preventDefault();
    setError(''); setSaved('');
    try {
      await api.put('/auth/profile', profile);
      setSaved('Profile updated');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update');
    }
  };

  const changePassword = async (e) => {
    e.preventDefault();
    setError(''); setSaved('');
    if (passwords.next !== passwords.confirm) return setError('Passwords do not match');
    try {
      await api.put('/auth/password', { currentPassword: passwords.current, newPassword: passwords.next });
      setSaved('Password changed');
      setPasswords({ current: '', next: '', confirm: '' });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to change password');
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-gray-500 text-sm mt-1">Manage your account preferences</p>
      </div>

      {saved && <div className="p-3 bg-green-50 text-green-700 rounded-xl text-sm">{saved}</div>}
      {error && <div className="p-3 bg-red-50 text-red-700 rounded-xl text-sm">{error}</div>}

      <div className="card">
        <h2 className="font-semibold mb-4">Profile</h2>
        <form onSubmit={saveProfile} className="space-y-3">
          <label className="block">
            <span className="text-sm text-gray-500">Full name</span>
            <input className="input mt-1" value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-sm text-gray-500">Email</span>
            <input className="input mt-1" type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} />
          </label>
          <button type="submit" className="btn-primary">Save Profile</button>
        </form>
      </div>

      <div className="card">
        <h2 className="font-semibold mb-4">Change Password</h2>
        <form onSubmit={changePassword} className="space-y-3">
          <label className="block">
            <span className="text-sm text-gray-500">Current password</span>
            <input className="input mt-1" type="password" value={passwords.current} onChange={(e) => setPasswords({ ...passwords, current: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-sm text-gray-500">New password</span>
            <input className="input mt-1" type="password" value={passwords.next} onChange={(e) => setPasswords({ ...passwords, next: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-sm text-gray-500">Confirm new password</span>
            <input className="input mt-1" type="password" value={passwords.confirm} onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })} />
          </label>
          <button type="submit" className="btn-primary">Change Password</button>
        </form>
      </div>

      <div className="card">
        <h2 className="font-semibold mb-2">Subscription</h2>
        <p className="text-sm text-gray-500 mb-3">Current plan: <span className="font-semibold capitalize text-blue-600">{user?.plan}</span></p>
        <div className="grid grid-cols-3 gap-3">
          {[{ plan: 'free', label: 'Free', price: '$0', features: ['3 children', '1 device each', 'Basic monitoring'] },
            { plan: 'premium', label: 'Premium', price: '$9.99/mo', features: ['10 children', '5 devices each', 'Full monitoring + AI'] },
            { plan: 'family', label: 'Family', price: '$14.99/mo', features: ['Unlimited children', 'Unlimited devices', 'AI + GPS tracking'] }].map(({ plan, label, price, features }) => (
            <div key={plan} className={`p-4 rounded-xl border-2 ${user?.plan === plan ? 'border-blue-500 bg-blue-50' : 'border-gray-200'}`}>
              <p className="font-semibold">{label}</p>
              <p className="text-lg font-bold text-blue-600">{price}</p>
              <ul className="text-xs text-gray-500 mt-2 space-y-1">
                {features.map((f) => <li key={f}>✓ {f}</li>)}
              </ul>
              {user?.plan !== plan && <button className="btn-primary w-full mt-3 text-sm py-1.5">Upgrade</button>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
