import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api, { payments } from '../services/api';

const PLANS = [
  {
    plan: 'free',
    label: 'Free Plan',
    price: '$0',
    period: '/ 7 days',
    badge: '7 days only',
    features: ['Basic screen time monitoring', 'Daily activity reports', '1 child device', 'Basic parental controls', 'Email support'],
    warning: 'Trial expires after 7 days',
  },
  {
    plan: 'premium',
    label: 'Premium Plan',
    price: '$9.99',
    period: '/mo',
    popular: true,
    features: ['Everything in Free', 'Real-time GPS tracking', 'Geofencing alerts', 'App usage monitoring', 'Website filtering & blocking', 'Screen time scheduling', 'Up to 5 child devices', 'Priority support'],
  },
  {
    plan: 'family',
    label: 'Family Plus',
    price: '$14.99',
    period: '/mo',
    features: ['Everything in Premium', 'Unlimited child devices', 'AI-powered safety alerts', 'Social media monitoring', 'Cyberbullying detection', 'Advanced family reports', 'Instant emergency notifications', 'Premium support'],
  },
];

export default function Settings() {
  const { user } = useAuth();
  const location = useLocation();
  const [profile, setProfile] = useState({ name: user?.name || '', email: user?.email || '' });
  const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' });
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [loadingPlan, setLoadingPlan] = useState(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [subscription, setSubscription] = useState(null);

  useEffect(() => {
    payments.getSubscription().then(r => setSubscription(r.data)).catch(() => {});
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('payment') === 'success') setSaved('Payment successful! Your plan has been upgraded.');
    if (params.get('payment') === 'cancelled') setError('Payment was cancelled.');
  }, [location.search]);

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

  const handleUpgrade = async (plan) => {
    setLoadingPlan(plan);
    setError('');
    try {
      const res = await payments.createCheckoutSession(plan);
      window.location.href = res.data.url;
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to start checkout. Check your Stripe keys.');
      setLoadingPlan(null);
    }
  };

  const handlePortal = async () => {
    setPortalLoading(true);
    setError('');
    try {
      const res = await payments.customerPortal();
      window.location.href = res.data.url;
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to open billing portal.');
      setPortalLoading(false);
    }
  };

  const isPaid = user?.plan === 'premium' || user?.plan === 'family';

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

      {/* Subscription */}
      <div className="card">
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-semibold">Subscription</h2>
          {isPaid && (
            <button
              onClick={handlePortal}
              disabled={portalLoading}
              className="text-sm text-blue-600 hover:underline disabled:opacity-50"
            >
              {portalLoading ? 'Opening...' : 'Manage Billing'}
            </button>
          )}
        </div>

        <p className="text-sm text-gray-500 mb-1">
          Current plan:{' '}
          <span className="font-semibold capitalize text-blue-600">
            {user?.plan === 'free' ? 'Free Plan' : user?.plan === 'premium' ? 'Premium Plan' : 'Family Plus'}
          </span>
        </p>

        {subscription?.currentPeriodEnd && (
          <p className="text-xs text-gray-400 mb-1">
            Renews: {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
            {subscription.cancelAtPeriodEnd && ' (cancels at period end)'}
          </p>
        )}

        {user?.plan === 'free' && user?.trialEndsAt && (
          <p className={`text-sm mb-4 font-medium ${user.trialExpired ? 'text-red-600' : 'text-orange-500'}`}>
            {user.trialExpired
              ? '⚠️ Your free trial has expired. Upgrade to continue.'
              : `⏳ Trial ends: ${new Date(user.trialEndsAt).toLocaleDateString()} (${Math.max(0, Math.ceil((new Date(user.trialEndsAt) - Date.now()) / 86400000))} days left)`}
          </p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
          {PLANS.map(({ plan, label, price, period, badge, popular, features, warning }) => {
            const isCurrent = user?.plan === plan;
            return (
              <div
                key={plan}
                className={`relative p-4 rounded-xl border-2 flex flex-col ${isCurrent ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white'}`}
              >
                {popular && !isCurrent && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-xs font-bold px-3 py-0.5 rounded-full">
                    Most Popular
                  </span>
                )}
                <div className="flex items-center gap-2 mb-1">
                  <p className="font-semibold text-sm">{label}</p>
                  {badge && <span className="text-xs bg-yellow-100 text-yellow-700 font-medium px-2 py-0.5 rounded-full">{badge}</span>}
                  {isCurrent && <span className="text-xs bg-blue-100 text-blue-700 font-medium px-2 py-0.5 rounded-full ml-auto">Active</span>}
                </div>
                <p className="text-xl font-bold text-blue-600 mb-3">
                  {price}<span className="text-xs text-gray-400 font-normal">{period}</span>
                </p>
                <ul className="text-xs text-gray-500 space-y-1.5 flex-1 mb-4">
                  {features.map(f => (
                    <li key={f} className="flex items-start gap-1.5">
                      <span className="text-blue-500 font-bold mt-0.5">✔</span> {f}
                    </li>
                  ))}
                  {warning && (
                    <li className="flex items-center gap-1.5 text-orange-500 font-medium">
                      <span>⚠️</span> {warning}
                    </li>
                  )}
                </ul>
                {!isCurrent && plan !== 'free' && (
                  <button
                    onClick={() => handleUpgrade(plan)}
                    disabled={loadingPlan === plan}
                    className="btn-primary w-full text-sm py-2 disabled:opacity-60"
                  >
                    {loadingPlan === plan ? 'Redirecting...' : `Upgrade to ${label}`}
                  </button>
                )}
                {isCurrent && isPaid && (
                  <button
                    onClick={handlePortal}
                    disabled={portalLoading}
                    className="w-full text-sm py-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition disabled:opacity-50"
                  >
                    {portalLoading ? 'Opening...' : 'Manage / Cancel'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
