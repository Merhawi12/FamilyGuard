import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth, errorMessage, isStaff, BrandLogo } from '@parentix/shared';

export default function Login() {
  const { user, loading, login, completeMfa, completeLoginCode, resendLoginCode } = useAuth();
  const [form, setForm] = useState({ email: '', password: '' });
  const [mfa, setMfa] = useState({ required: false, preAuthToken: '', code: '' });
  /**
   * The emailed second factor, which staff get exactly like parents do — the API
   * applies it to every password sign-in, so a console that only knew about
   * authenticator codes would answer the challenge by doing nothing at all.
   */
  const [emailCode, setEmailCode] = useState({
    required: false, preAuthToken: '', address: '', code: '', remember: false,
  });
  const [notice, setNotice] = useState('');
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
      else if (result.loginCodeRequired) {
        setEmailCode({
          required: true,
          preAuthToken: result.preAuthToken,
          address: result.email || '',
          code: '',
          remember: false,
        });
      }
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

  const submitEmailCode = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await completeLoginCode(emailCode.preAuthToken, emailCode.code.trim(), emailCode.remember);
    } catch (err) {
      // An expired ticket cannot be retyped past — say so rather than letting a
      // correct code be entered until the account locks.
      if (err.response?.status === 401 && /pre-auth/i.test(err.response.data?.error || '')) {
        setEmailCode({ required: false, preAuthToken: '', address: '', code: '', remember: false });
        setError('That sign-in attempt timed out. Enter your password again for a new code.');
        return;
      }
      setError(errorMessage(err, 'That code was not accepted.'));
    } finally {
      setBusy(false);
    }
  };

  const resendEmailCode = async () => {
    setError('');
    setNotice('');
    try {
      const data = await resendLoginCode(emailCode.preAuthToken);
      setNotice(data?.emailDelivered === false
        ? 'We could not send that code. Check the mail relay for this deployment.'
        : 'A new code is on its way.');
    } catch (err) {
      setError(errorMessage(err, 'Could not resend the code.'));
    }
  };

  return (
    <div className="min-h-dvh flex items-center justify-center bg-navy-900 px-4 py-8
                    bg-[radial-gradient(ellipse_at_top,#163b7d_0%,#0b2451_55%,#071835_100%)]">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          {/*
            The real Parentix mark, not the generic shield from the icon set.
            This is the same /logo.png the Family App signs in under, so a parent
            and a staff member arrive at the same brand.

            It is navy ink on transparency, which is why the rail and this page
            both used to substitute an icon — at #103C69 on a #0b2451 background
            it is very nearly invisible. `brightness(0) invert(1)` collapses every
            opaque pixel to white and leaves the alpha channel alone; the artwork
            is a single flat colour, so the result is the same lockup in white
            rather than a washed-out approximation of it.

            The image carries the wordmark, so there is no separate <h1> text
            beside it — that would set "Parentix" twice. The heading level is kept
            (it is the page's only h1) and its accessible name comes from the alt.
          */}
          <h1>
            <BrandLogo
              width="500"
              height="500"
              className="h-28 w-auto mx-auto [filter:brightness(0)_invert(1)]"
            />
          </h1>
          {/*
            No margin between the two: the artwork is a 500×500 canvas whose ink
            only spans y=99..380, so a 112px box already carries ~22px of empty
            space above the shield and ~27px below the wordmark. Adding a margin
            on top of that reads as a gap nobody chose. The height is picked for
            the *ink* rather than the box — 56% of 112px is a ~63px mark, which is
            what the old 64px icon tile occupied.
          */}
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-navy-300">
            Admin console
          </p>
        </div>

        <div className="card">
        <p className="text-sm text-gray-500 mb-5">Staff access only. Sign in to continue.</p>

        {error && <p className="notice-error mb-4">{error}</p>}
        {notice && <p className="notice-success mb-4">{notice}</p>}

        {emailCode.required ? (
          <form onSubmit={submitEmailCode} className="space-y-4">
            <div>
              <label htmlFor="login-code" className="block text-sm font-medium text-gray-700 mb-1">
                Sign-in code
              </label>
              <input
                id="login-code"
                className="input tracking-[0.4em] text-center"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={6}
                value={emailCode.code}
                onChange={(e) => setEmailCode((c) => ({ ...c, code: e.target.value }))}
                required
              />
              <p className="text-xs text-gray-400 mt-1">
                We emailed a 6-digit code to {emailCode.address || 'your address'}.
              </p>
            </div>
            <label className="flex items-start gap-2 text-sm text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={emailCode.remember}
                onChange={(e) => setEmailCode((c) => ({ ...c, remember: e.target.checked }))}
                className="mt-0.5 w-4 h-4 shrink-0 rounded border-gray-300 text-navy-700"
              />
              <span>Trust this device for 30 days</span>
            </label>
            <button type="submit" className="btn-primary btn-block" disabled={busy}>
              {busy ? 'Verifying…' : 'Verify'}
            </button>
            <button
              type="button"
              onClick={resendEmailCode}
              className="btn-ghost btn-sm btn-block"
              disabled={busy}
            >
              Resend code
            </button>
          </form>
        ) : mfa.required ? (
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
            <button type="submit" className="btn-primary btn-block" disabled={busy}>
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
            <button type="submit" className="btn-primary btn-block" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
        </div>

        <p className="text-center text-xs text-navy-400 mt-5">
          Parentix — parental controls platform
        </p>
      </div>
    </div>
  );
}
