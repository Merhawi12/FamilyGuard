import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { auth as authApi } from '../services/api';

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
    if (password !== confirm) return setError('Passwords do not match');
    if (password.length < 6) return setError('Password must be at least 6 characters');

    setLoading(true);
    try {
      await authApi.resetPassword({ token, newPassword: password });
      setDone(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 px-4 py-8">
      <div className="bg-white rounded-3xl shadow-xl p-6 md:p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <a href="/"><img src="/logo.png" alt="FamilyGuard" className="h-28 w-auto mx-auto cursor-pointer" /></a>
          <p className="text-gray-500 text-sm mt-2">Parental Control & Digital Safety</p>
        </div>

        {!token ? (
          <p className="text-sm text-red-500 text-center">
            This reset link is missing its token. Please use the link from your email.
          </p>
        ) : done ? (
          <div className="text-center">
            <p className="text-sm text-green-600 mb-4">Your password has been reset successfully.</p>
            <Link to="/login" className="btn-primary w-full py-3 inline-block">Sign In</Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <h2 className="text-xl font-bold text-gray-900 text-center mb-2">Choose a new password</h2>
            <input
              className="input"
              type="password"
              placeholder="New password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <input
              className="input"
              type="password"
              placeholder="Confirm new password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
            {error && <p className="text-sm text-red-500">{error}</p>}
            <button type="submit" disabled={loading} className="btn-primary w-full py-3">
              {loading ? 'Resetting...' : 'Reset Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
