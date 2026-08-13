import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Avatar, Icon, auth as authApi, children as childrenApi, errorMessage, useAuth, planLabel,
} from '@parentix/shared';
import PageIntro from '../components/PageIntro';

/**
 * The signed-in parent's own account.
 *
 * Their name, address and password used to be the first two cards of a
 * 350-line Settings page, above billing, push subscriptions and eleven alert
 * toggles — so "change my email" meant scrolling a wall of unrelated switches.
 * Identity lives here; the things you configure live in Settings, and each
 * links to the other.
 */
export default function Profile() {
  const { user, setUser, logout } = useAuth();

  const [form, setForm] = useState({ name: user?.name || '', email: user?.email || '' });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [family, setFamily] = useState(null);
  // Sticky, unlike `saved` — see `save` below.
  const [notice, setNotice] = useState('');
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    childrenApi.list()
      .then((r) => {
        const list = Array.isArray(r.data) ? r.data : [];
        setFamily({
          children: list.length,
          devices: list.reduce((sum, c) => sum + (c.devices?.length || 0), 0),
        });
      })
      .catch(() => setFamily(null));
  }, []);

  // The header, the drawer and the account menu all read `user`, so a saved
  // name has to go back into the session rather than only into this form.
  const save = async (e) => {
    e.preventDefault();
    setError(''); setSaved('');

    if (!form.name.trim()) return setError('Your name cannot be empty.');

    setSaving(true);
    try {
      const res = await authApi.updateProfile({ name: form.name.trim(), email: form.email.trim() });
      setUser(res.data);

      /**
       * A new address has to prove itself before it can sign in, so this cannot
       * fade away after three seconds like a saved name does — it is the only
       * notice the parent gets that their account is now behind a code, and
       * that the code went to the address they just typed rather than the one
       * they can still read.
       */
      if (res.data.emailVerificationRequired) {
        setSaved('');
        setNotice(
          res.data.emailDelivered
            ? `We sent a 6-digit code to ${res.data.email}. Enter it to confirm your new address — until you do, you will not be able to sign in with it.`
            : `Your address was changed to ${res.data.email}, but we could not send the confirmation code. Use “Resend code” below, or change the address back.`
        );
      } else {
        setNotice('');
        setSaved('Your profile has been updated.');
        setTimeout(() => setSaved(''), 3000);
      }
    } catch (err) {
      setError(errorMessage(err, 'Could not update your profile.'));
    } finally {
      setSaving(false);
    }
  };

  // Confirming the new address, without having to sign out to reach the signup screen.
  const confirmEmail = async (e) => {
    e.preventDefault();
    setError(''); setNotice('');
    setVerifying(true);
    try {
      await authApi.verifyEmail({ email: user.email, code: code.trim() });
      // The token that comes back belongs to a fresh session; the one this tab
      // already holds is still valid, so only the verified flag needs updating.
      setUser({ ...user, emailVerified: true });
      setCode('');
      setSaved('Your email address has been confirmed.');
      setTimeout(() => setSaved(''), 3000);
    } catch (err) {
      setError(errorMessage(err, 'That code was not accepted.'));
    } finally {
      setVerifying(false);
    }
  };

  const resend = async () => {
    setError(''); setNotice('');
    try {
      const res = await authApi.resendCode({ email: user.email });
      setNotice(res.data.emailDelivered === false
        ? 'We still could not send the code. Check the address, or change it back.'
        : `We sent a new code to ${user.email}.`);
    } catch (err) {
      setError(errorMessage(err, 'Could not resend the code.'));
    }
  };

  const dirty = form.name !== (user?.name || '') || form.email !== (user?.email || '');

  const accountLinks = [
    {
      to: '/dashboard/settings?section=security',
      icon: 'lock',
      label: 'Password & two-factor',
      value: user?.mfaEnabled ? 'Two-factor is on' : 'Two-factor is off',
    },
    {
      to: '/dashboard/settings?section=notifications',
      icon: 'bell',
      label: 'Notifications',
      value: 'Email, push and alert types',
    },
    {
      to: '/dashboard/settings?section=plan',
      icon: 'card',
      label: 'Plan & billing',
      value: planLabel(user?.plan),
    },
  ];

  return (
    <div className="space-y-5 max-w-2xl">
      <PageIntro description="Your account details and how you sign in." />

      {/* Identity */}
      <div className="card flex flex-col sm:flex-row items-center sm:items-start gap-4 text-center sm:text-left">
        <Avatar name={user?.name} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-lg font-semibold text-gray-900 truncate">{user?.name}</p>
          <p className="text-sm text-gray-500 truncate">{user?.email}</p>
          <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 mt-2.5">
            <span className="badge-primary">{planLabel(user?.plan)}</span>
            {user?.mfaEnabled && (
              <span className="badge-green inline-flex items-center gap-1">
                <Icon name="shieldCheck" size={12} strokeWidth={2.2} /> Protected
              </span>
            )}
            {user?.plan === 'free' && user?.trialExpired && <span className="badge-red">Trial expired</span>}
          </div>
        </div>
      </div>

      {family && (
        <div className="grid grid-cols-2 gap-3">
          <Link to="/dashboard/children" className="card p-4 hover:border-primary-200 transition">
            <p className="text-2xl font-bold text-gray-900">{family.children}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {family.children === 1 ? 'Child profile' : 'Child profiles'}
            </p>
          </Link>
          <Link to="/dashboard/children" className="card p-4 hover:border-primary-200 transition">
            <p className="text-2xl font-bold text-gray-900">{family.devices}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {family.devices === 1 ? 'Linked device' : 'Linked devices'}
            </p>
          </Link>
        </div>
      )}

      {/* Details */}
      <div className="card">
        <h2 className="section-title mb-4">Personal details</h2>

        {saved && <p className="notice-success mb-3">{saved}</p>}
        {notice && <p className="notice-warning mb-3">{notice}</p>}
        {error && <p className="notice-error mb-3">{error}</p>}

        {/*
          * Shown whenever the account's address is unconfirmed, not only right
          * after a change — a parent who navigates away mid-flow would otherwise
          * have no route back to the code box short of being locked out at the
          * next sign-in.
          */}
        {user?.email && user?.emailVerified === false && (
          <form onSubmit={confirmEmail} className="notice-warning mb-4 space-y-3">
            <p className="text-sm font-medium">Confirm {user.email}</p>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                className="input flex-1"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="6-digit code"
                aria-label="Verification code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
              <button type="submit" className="btn-primary" disabled={verifying || code.trim().length !== 6}>
                {verifying ? 'Confirming…' : 'Confirm'}
              </button>
            </div>
            <button type="button" onClick={resend} className="text-sm font-medium underline">
              Resend code
            </button>
          </form>
        )}

        <form onSubmit={save} className="space-y-4">
          <label className="field">
            <span className="field-label">Full name</span>
            <input
              className="input"
              autoComplete="name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Email address</span>
            <input
              className="input"
              type="email"
              autoComplete="email"
              inputMode="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <span className="field-hint">You sign in with this address.</span>
          </label>
          <button type="submit" className="btn-primary btn-block sm:w-auto" disabled={saving || !dirty}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </div>

      {/* Everything configurable, one tap away */}
      <div className="card-flush divide-y divide-gray-50">
        {accountLinks.map(({ to, icon, label, value }) => (
          <Link key={to} to={to} className="list-row rounded-none px-4 hover:bg-gray-50">
            <span className="w-9 h-9 rounded-xl bg-gray-50 text-gray-500 flex items-center justify-center shrink-0">
              <Icon name={icon} size={18} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-medium text-gray-900">{label}</span>
              <span className="block text-xs text-gray-500 truncate">{value}</span>
            </span>
            <Icon name="chevronRight" size={16} className="text-gray-300" />
          </Link>
        ))}
      </div>

      <button onClick={logout} className="btn-secondary btn-block text-danger">
        <Icon name="logout" size={18} />
        Sign out
      </button>
    </div>
  );
}
