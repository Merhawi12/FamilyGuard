import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth, errorMessage, isStaff } from '@parentix/shared';

export default function Login() {
  const { user, loading, login, completeMfa } = useAuth();
  const [form, setForm] = useState({ email: '', password: '' });
  const [mfa, setMfa] = useState({ required: false, preAuthToken: '', code: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!loading && isStaff(user)) return <Navigate to="/" replace />;

  const submitCredentials = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await login(form.email.trim(), form.password);
      if (result.mfaRequired) setMfa({ required: true, preAuthToken: result.preAuthToken, code: '' });
    } catch (err) {
      setError(errorMessage(err, 'Sign in failed. Check your email and password.'));
    } finally {
      setBusy(false);
    }
  };

  const submitMfa = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await completeMfa(mfa.preAuthToken, mfa.code.trim());
    } catch (err) {
      setError(errorMessage(err, 'That code was not accepted.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="card w-full max-w-md">
        <div className="text-center mb-6">
          <img src="/logo.png" alt="" className="w-12 h-12 rounded-xl mx-auto mb-3" />
          <h1 className="text-xl font-bold text-gray-900">Parentix Admin</h1>
          <p className="text-sm text-gray-500 mt-1">Staff access only</p>
        </div>

        {error && (
          <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
        )}

        {mfa.required ? (
          <form onSubmit={submitMfa} className="space-y-4">
            <div>
              <label htmlFor="code" className="block text-sm font-medium text-gray-700 mb-1">
                Authentication code
              </label>
              <input
                id="code"
                className="input tracking-[0.4em] text-center"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={10}
                value={mfa.code}
                onChange={(e) => setMfa((m) => ({ ...m, code: e.target.value }))}
                required
              />
              <p className="text-xs text-gray-400 mt-1">
                Enter the 6-digit code from your authenticator app, or one of your backup codes.
              </p>
            </div>
            <button type="submit" className="btn-primary w-full" disabled={busy}>
              {busy ? 'Verifying…' : 'Verify'}
            </button>
          </form>
        ) : (
          <form onSubmit={submitCredentials} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                Email
              </label>
              <input
                id="email"
                type="email"
                className="input"
                autoComplete="username"
                autoFocus
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                required
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                Password
              </label>
              <input
                id="password"
                type="password"
                className="input"
                autoComplete="current-password"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                required
              />
            </div>
            <button type="submit" className="btn-primary w-full" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
