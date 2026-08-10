import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { auth as authApi, errorMessage, Icon } from '@parentix/shared';
import AuthShell from '../components/AuthShell';
import PasswordField from '../components/PasswordField';

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) return setError('Those passwords do not match.');
    if (password.length < 10) return setError('Use at least 10 characters.');

    setLoading(true);
    try {
      await authApi.resetPassword({ token, newPassword: password });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err, 'That reset link is invalid or has expired.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell>
      {!token ? (
        <p className="notice-error">
          <Icon name="warning" size={16} className="mt-0.5" />
          <span>This reset link is missing its token. Please use the link from your email.</span>
        </p>
      ) : done ? (
        <div className="text-center">
          <span className="inline-flex w-14 h-14 bg-green-50 text-green-600 rounded-2xl items-center justify-center mb-3">
            <Icon name="check" size={26} strokeWidth={2.4} />
          </span>
          <h2 className="text-xl font-bold text-gray-900 mb-1">Password reset</h2>
          <p className="text-sm text-gray-500 mb-5">You can sign in with your new password now.</p>
          <Link to="/login" className="btn-primary btn-block">Sign in</Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="text-center mb-2">
            <h2 className="text-xl font-bold text-gray-900">Choose a new password</h2>
            <p className="text-sm text-gray-500 mt-1">At least 10 characters, including a letter and a number.</p>
          </div>

          <PasswordField
            label="New password"
            autoComplete="new-password"
            placeholder="New password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <PasswordField
            label="Confirm new password"
            autoComplete="new-password"
            placeholder="Confirm new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />

          {error && <p className="notice-error">{error}</p>}

          <button type="submit" disabled={loading} className="btn-primary btn-block">
            {loading ? 'Resetting…' : 'Reset password'}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
