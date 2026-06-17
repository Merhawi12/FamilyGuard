import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { payments, auth as authApi } from '../services/api';

export default function Login() {
  const [tab, setTab] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [code, setCode] = useState(['', '', '', '', '', '']);
  const [pendingEmail, setPendingEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  const { login, register, verifyEmail } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectPlan = new URLSearchParams(location.search).get('redirect');

  const handleAuth = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (tab === 'login') {
        await login(form.email, form.password);
        if (redirectPlan === 'premium' || redirectPlan === 'family') {
          const res = await payments.createCheckoutSession(redirectPlan);
          window.location.href = res.data.url;
          return;
        }
        navigate('/dashboard');
      } else {
        await register(form.name, form.email, form.password);
        setPendingEmail(form.email);
        setTab('verify');
      }
    } catch (err) {
      const data = err.response?.data;
      // Email not verified — switch to verify screen automatically
      if (data?.emailVerificationRequired) {
        setPendingEmail(form.email);
        setTab('verify');
        return;
      }
      const msg = data?.error;
      if (!err.response || (err.response.status >= 500 && !msg)) {
        setError('Backend server is not running. Start it with: cd server && npm run dev');
      } else {
        setError(msg || `Server error (${err.response?.status})`);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCodeInput = (val, idx) => {
    if (!/^\d?$/.test(val)) return;
    const next = [...code];
    next[idx] = val;
    setCode(next);
    if (val && idx < 5) {
      document.getElementById(`code-${idx + 1}`)?.focus();
    }
  };

  const handleCodeKeyDown = (e, idx) => {
    if (e.key === 'Backspace' && !code[idx] && idx > 0) {
      document.getElementById(`code-${idx - 1}`)?.focus();
    }
  };

  const handleCodePaste = (e) => {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pasted.length === 6) {
      setCode(pasted.split(''));
      document.getElementById('code-5')?.focus();
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    const fullCode = code.join('');
    if (fullCode.length < 6) return setError('Enter the 6-digit code');
    setError('');
    setLoading(true);
    try {
      await verifyEmail(pendingEmail, fullCode);
      navigate('/dashboard');
    } catch (err) {
      setError(err.response?.data?.error || 'Invalid or expired code');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (resendCooldown > 0) return;
    try {
      await authApi.resendCode({ email: pendingEmail });
      setCode(['', '', '', '', '', '']);
      setError('');
      setResendCooldown(60);
      const timer = setInterval(() => {
        setResendCooldown(prev => {
          if (prev <= 1) { clearInterval(timer); return 0; }
          return prev - 1;
        });
      }, 1000);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to resend code');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 px-4 py-8">
      <div className="bg-white rounded-3xl shadow-xl p-6 md:p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <a href="http://localhost:3000/"><img src="/logo.png" alt="FamilyGuard" className="h-28 w-auto mx-auto cursor-pointer" /></a>
          <p className="text-gray-500 text-sm mt-2">Parental Control & Digital Safety</p>
        </div>

        {/* Verify Email Step */}
        {tab === 'verify' ? (
          <div>
            <div className="text-center mb-6">
              <div className="w-14 h-14 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <span className="text-2xl">📧</span>
              </div>
              <h2 className="text-xl font-bold text-gray-900">Check your email</h2>
              <p className="text-sm text-gray-500 mt-1">
                We sent a 6-digit code to<br />
                <span className="font-semibold text-gray-700">{pendingEmail}</span>
              </p>
            </div>

            <form onSubmit={handleVerify} className="space-y-5">
              <div className="flex justify-center gap-2" onPaste={handleCodePaste}>
                {code.map((digit, idx) => (
                  <input
                    key={idx}
                    id={`code-${idx}`}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handleCodeInput(e.target.value, idx)}
                    onKeyDown={(e) => handleCodeKeyDown(e, idx)}
                    className="w-12 h-14 text-center text-2xl font-bold border-2 border-gray-200 rounded-xl focus:border-blue-500 focus:outline-none transition"
                  />
                ))}
              </div>

              {error && <p className="text-sm text-red-500 text-center">{error}</p>}

              <button type="submit" disabled={loading} className="btn-primary w-full py-3">
                {loading ? 'Verifying...' : 'Verify Email'}
              </button>
            </form>

            <div className="text-center mt-4">
              <p className="text-sm text-gray-500">
                Didn't receive a code?{' '}
                <button
                  onClick={handleResend}
                  disabled={resendCooldown > 0}
                  className="text-blue-600 font-medium hover:underline disabled:text-gray-400 disabled:no-underline"
                >
                  {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
                </button>
              </p>
              <button
                onClick={() => { setTab('register'); setError(''); }}
                className="text-sm text-gray-400 hover:text-gray-600 mt-2"
              >
                ← Back
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex rounded-xl bg-gray-100 p-1 mb-6">
              {['login', 'register'].map((t) => (
                <button
                  key={t}
                  onClick={() => { setTab(t); setError(''); }}
                  className={`flex-1 py-2 text-sm font-medium rounded-lg transition ${tab === t ? 'bg-white shadow text-gray-900' : 'text-gray-500'}`}
                >
                  {t === 'login' ? 'Sign In' : 'Sign Up'}
                </button>
              ))}
            </div>

            <form onSubmit={handleAuth} className="space-y-4">
              {tab === 'register' && (
                <input
                  className="input"
                  placeholder="Full name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                />
              )}
              <input
                className="input"
                type="email"
                placeholder="Email address"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
              />
              <input
                className="input"
                type="password"
                placeholder="Password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                required
              />

              {error && <p className="text-sm text-red-500">{error}</p>}

              <button type="submit" disabled={loading} className="btn-primary w-full py-3">
                {loading ? 'Please wait...' : tab === 'login' ? 'Sign In' : 'Create Account'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
