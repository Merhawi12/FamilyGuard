import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  useAuth, payments, auth as authApi, errorMessage, Icon, PAID_PLAN_KEYS, GoogleSignInButton,
} from '@parentix/shared';
import AuthShell from '../components/AuthShell';
import PasswordField from '../components/PasswordField';
import PhoneField, { joinPhone } from '../components/PhoneField';
import { DEFAULT_COUNTRY } from '../countries';

/**
 * Sign in and sign up, over two identifiers.
 *
 * `tab` is the step, not the identifier: 'login' and 'register' are the two
 * entry screens and everything else ('verify', 'code', 'mfa', 'forgot') is a
 * step reached from one of them. `method` is the identifier — 'email' or
 * 'phone' — and is what the segmented control switches. Keeping them separate is
 * what lets the phone path reuse the code screen, the MFA challenge and the
 * post-sign-in redirect rather than growing parallel copies of each.
 */
export default function Login() {
  const [tab, setTab] = useState('login');
  const [method, setMethod] = useState('email');
  /**
   * Whether this deployment can actually send an SMS.
   *
   * Starts false and is revealed by the server, the same way the Google button
   * decides whether to draw itself. Offering the tab first and withdrawing it
   * would flicker, and worse, would let someone start typing a number into a
   * control that is about to vanish.
   *
   * A failed or 404 lookup keeps it hidden, and that is the important case
   * rather than a defensive one: an API old enough to lack `/auth/providers`
   * is the same API that lacks `/auth/phone/request`, so the tab it would have
   * drawn leads only to a dead endpoint.
   */
  const [phoneAvailable, setPhoneAvailable] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [agreed, setAgreed] = useState(false);
  const [code, setCode] = useState(['', '', '', '', '', '']);
  const [pendingEmail, setPendingEmail] = useState('');
  // The API reports whether the code actually left the building. It used to
  // always answer "sent", so a deployment with broken mail credentials stranded
  // every new account on a screen waiting for an email that was never going out.
  // The SMS path answers the same way, for the same reason.
  const [deliveryProblem, setDeliveryProblem] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotSent, setForgotSent] = useState(false);
  const [mfa, setMfa] = useState({ preAuthToken: '', code: '' });
  const [country, setCountry] = useState(DEFAULT_COUNTRY);
  const [national, setNational] = useState('');
  // Masked by the API — the whole number is never echoed back to be displayed.
  const [pendingPhone, setPendingPhone] = useState({ e164: '', masked: '' });
  /**
   * The code itself, when the API had nowhere to send it.
   *
   * Only ever populated outside production, where the server returns `devCode`
   * instead of paying a provider to deliver it — see `sms.echoCode`. Without
   * this the phone flow could be started locally but not finished, which is the
   * state it was in.
   */
  const [devCode, setDevCode] = useState('');

  // Ticking here rather than inside the resend handler means the interval is
  // always torn down with the component — navigating away mid-countdown used to
  // leave a timer running against unmounted state.
  useEffect(() => {
    if (resendCooldown <= 0) return undefined;
    const timer = setInterval(() => setResendCooldown((prev) => Math.max(prev - 1, 0)), 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  // Ask the server which identifiers it can actually prove. See `phoneAvailable`.
  useEffect(() => {
    let cancelled = false;
    authApi.providers()
      .then((res) => {
        if (cancelled) return;
        const enabled = !!res.data?.phone;
        setPhoneAvailable(enabled);
        // Nothing routes here today — 'email' is the initial method and the tab
        // is what changes it — but an identifier the deployment cannot prove
        // must not survive as the selected one.
        if (!enabled) setMethod('email');
      })
      .catch(() => { /* offline, or an API without the phone routes — stay hidden */ });
    return () => { cancelled = true; };
  }, []);

  const {
    login, loginWithGoogle, completeMfa, register, verifyEmail, requestPhoneCode, loginWithPhone,
  } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectPlan = new URLSearchParams(location.search).get('redirect');

  const isRegister = tab === 'register';

  /** Shared tail of a successful sign-in, whatever proved it. */
  const finishSignIn = async () => {
    // Checked against the catalogue rather than a hard-coded pair, so a
    // `?redirect=` for a retired tier lands on the dashboard instead of a
    // checkout the API refuses.
    if (PAID_PLAN_KEYS.includes(redirectPlan)) {
      const res = await payments.createCheckoutSession(redirectPlan);
      window.location.href = res.data.url;
      return;
    }
    navigate('/dashboard');
  };

  /** Every flow that ends in a session funnels through here, MFA included. */
  const settle = async (result) => {
    if (result?.mfaRequired) {
      setMfa({ preAuthToken: result.preAuthToken, code: '' });
      setTab('mfa');
      return;
    }
    await finishSignIn();
  };

  /**
   * Google hands back an ID token; the API decides what it means.
   *
   * There is no verification step afterwards, and that is not an omission:
   * Google has already proved the address, the API refuses a token that says
   * otherwise, and the account it creates is verified on arrival.
   */
  const handleGoogle = async (credential) => {
    setError('');
    setLoading(true);
    try {
      await settle(await loginWithGoogle(credential));
    } catch (err) {
      setError(errorMessage(err, 'Google sign-in failed. Please try again.'));
    } finally {
      setLoading(false);
    }
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    setError('');

    if (isRegister && !agreed) {
      return setError('Please accept the Terms & Conditions to continue.');
    }

    setLoading(true);
    try {
      if (method === 'phone') {
        const e164 = joinPhone(country, national);
        const data = await requestPhoneCode(e164, {
          mode: isRegister ? 'register' : 'login',
          name: form.name,
        });
        setPendingPhone({ e164, masked: data.phone });
        // A returned code is not a delivery problem — it is the code. Showing
        // both would tell the parent something went wrong while handing them
        // the thing they need.
        setDevCode(data.devCode || '');
        setDeliveryProblem(data.smsDelivered === false && !data.devCode ? data.message : '');
        setCode(['', '', '', '', '', '']);
        setResendCooldown(60);
        setTab('code');
        return;
      }

      if (isRegister) {
        const result = await register(form.name, form.email, form.password);
        setPendingEmail(form.email);
        setDeliveryProblem(result?.emailDelivered === false ? result.message : '');
        setTab('verify');
        return;
      }

      await settle(await login(form.email, form.password));
    } catch (err) {
      const data = err.response?.data;
      // Email not verified — switch to the verification step automatically.
      if (data?.emailVerificationRequired) {
        setPendingEmail(form.email);
        setTab('verify');
        return;
      }
      setError(
        err.response
          ? errorMessage(err, `Server error (${err.response.status})`)
          : 'Could not reach the Parentix service. Check your connection and try again.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleMfa = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await completeMfa(mfa.preAuthToken, mfa.code.trim());
      await finishSignIn();
    } catch (err) {
      setError(errorMessage(err, 'That code was not accepted.'));
    } finally {
      setLoading(false);
    }
  };

  const handleCodeInput = (val, idx) => {
    if (!/^\d?$/.test(val)) return;
    const next = [...code];
    next[idx] = val;
    setCode(next);
    if (val && idx < 5) document.getElementById(`code-${idx + 1}`)?.focus();
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

  /** The email code screen. Verifies an address and signs in. */
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
      setError(errorMessage(err, 'That code is invalid or has expired.'));
    } finally {
      setLoading(false);
    }
  };

  /** The SMS code screen. Same six boxes, and the same MFA tail as a password. */
  const handlePhoneCode = async (e) => {
    e.preventDefault();
    const fullCode = code.join('');
    if (fullCode.length < 6) return setError('Enter the 6-digit code');
    setError('');
    setLoading(true);
    try {
      await settle(await loginWithPhone(pendingPhone.e164, fullCode));
    } catch (err) {
      setError(errorMessage(err, 'That code is invalid or has expired.'));
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await authApi.forgotPassword({ email: forgotEmail });
      setForgotSent(true);
    } catch (err) {
      setError(errorMessage(err, 'Could not send a reset link.'));
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (resendCooldown > 0) return;
    try {
      if (tab === 'code') {
        const data = await requestPhoneCode(pendingPhone.e164, {
          mode: isRegister ? 'register' : 'login',
          name: form.name,
        });
        setDevCode(data.devCode || '');
        setDeliveryProblem(data.smsDelivered === false && !data.devCode ? data.message : '');
      } else {
        const res = await authApi.resendCode({ email: pendingEmail });
        setDeliveryProblem(res.data?.emailDelivered === false ? res.data.message : '');
      }
      setCode(['', '', '', '', '', '']);
      setError('');
      setResendCooldown(60);
    } catch (err) {
      setError(errorMessage(err, 'Could not resend the code.'));
    }
  };

  const backButton = (onClick, label = 'Back to sign in') => (
    <button onClick={onClick} className="btn-ghost btn-sm mx-auto mt-4 flex">
      <Icon name="arrowLeft" size={15} />
      {label}
    </button>
  );

  /** The six-box code entry, shared by the email and SMS screens. */
  const codeBoxes = (
    <div className="flex justify-center gap-1.5 sm:gap-2" onPaste={handleCodePaste}>
      {code.map((digit, idx) => (
        <input
          key={idx}
          id={`code-${idx}`}
          type="text"
          inputMode="numeric"
          // An id alone gives no accessible name — without this a screen
          // reader announces six unlabelled edit fields.
          aria-label={`Verification code, digit ${idx + 1} of ${code.length}`}
          autoComplete={idx === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          value={digit}
          onChange={(e) => handleCodeInput(e.target.value, idx)}
          onKeyDown={(e) => handleCodeKeyDown(e, idx)}
          className="w-11 h-14 sm:w-12 min-w-0 text-center text-2xl font-bold text-gray-900
                     border-2 border-gray-200 rounded-xl focus:border-primary-500 focus:outline-none transition"
        />
      ))}
    </div>
  );

  const resendRow = (
    <p className="text-sm text-gray-500 text-center mt-4">
      Didn&apos;t get it?{' '}
      <button
        onClick={handleResend}
        disabled={resendCooldown > 0}
        className="inline-flex items-center min-h-[36px] px-1 text-primary-600 font-medium hover:underline disabled:text-gray-400 disabled:no-underline"
      >
        {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
      </button>
    </p>
  );

  return (
    <AuthShell>
      {/* ── Two-factor challenge ─────────────────────────────────────────── */}
      {tab === 'mfa' ? (
        <>
          <div className="text-center mb-6">
            <span className="inline-flex w-14 h-14 bg-primary-50 text-primary-600 rounded-2xl items-center justify-center mb-3">
              <Icon name="lock" size={26} />
            </span>
            <h2 className="text-xl font-bold text-gray-900">Two-factor authentication</h2>
            <p className="text-sm text-gray-500 mt-1">
              Enter the 6-digit code from your authenticator app, or one of your backup codes.
            </p>
          </div>

          <form onSubmit={handleMfa} className="space-y-4">
            <input
              className="input text-center text-2xl tracking-[0.4em] py-3"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="Authentication code"
              autoFocus
              maxLength={10}
              value={mfa.code}
              onChange={(e) => setMfa((m) => ({ ...m, code: e.target.value }))}
              required
            />
            {error && <p className="notice-error">{error}</p>}
            <button type="submit" disabled={loading} className="btn-primary btn-block">
              {loading ? 'Verifying…' : 'Verify'}
            </button>
          </form>

          {backButton(() => { setTab('login'); setError(''); setMfa({ preAuthToken: '', code: '' }); })}
        </>
      ) : tab === 'code' ? (
        /* ── SMS verification ───────────────────────────────────────────── */
        <>
          <div className="text-center mb-6">
            <span className="inline-flex w-14 h-14 bg-primary-50 text-primary-600 rounded-2xl items-center justify-center mb-3">
              <Icon name="phone" size={26} />
            </span>
            <h2 className="text-xl font-bold text-gray-900">Enter the code we sent</h2>
            <p className="text-sm text-gray-500 mt-1">
              We texted a 6-digit code to<br />
              <span className="font-semibold text-gray-700">{pendingPhone.masked}</span>
            </p>
          </div>

          {deliveryProblem && (
            <p className="notice-warning mb-4 text-left">
              <Icon name="warning" size={16} className="mt-0.5" />
              <span>
                {deliveryProblem} Check the SMS settings for this deployment, then use Resend code.
              </span>
            </p>
          )}

          {/* Development only — the API returns the code when it has no provider
              to send it with, so the flow can be finished locally. It cannot
              reach production: see `sms.echoCode`. */}
          {devCode && (
            <div className="notice-warning mb-4 text-left">
              <Icon name="warning" size={16} className="mt-0.5" />
              <span>
                SMS is not configured for this deployment, so the code is shown here
                instead of being texted.{' '}
                <strong className="font-mono tracking-[0.25em] text-base">{devCode}</strong>
              </span>
            </div>
          )}

          <form onSubmit={handlePhoneCode} className="space-y-4">
            {codeBoxes}
            {error && <p className="notice-error">{error}</p>}
            <button type="submit" disabled={loading} className="btn-primary btn-block">
              {loading ? 'Verifying…' : 'Verify & continue'}
            </button>
          </form>

          {resendRow}
          {backButton(() => { setTab(isRegister ? 'register' : 'login'); setError(''); }, 'Use a different number')}
        </>
      ) : tab === 'verify' ? (
        /* ── Email verification ─────────────────────────────────────────── */
        <>
          <div className="text-center mb-6">
            <span className="inline-flex w-14 h-14 bg-primary-50 text-primary-600 rounded-2xl items-center justify-center mb-3">
              <Icon name="mail" size={26} />
            </span>
            <h2 className="text-xl font-bold text-gray-900">Check your email</h2>
            <p className="text-sm text-gray-500 mt-1">
              We sent a 6-digit code to<br />
              <span className="font-semibold text-gray-700 break-all">{pendingEmail}</span>
            </p>
          </div>

          {deliveryProblem && (
            <p className="notice-warning mb-4 text-left">
              <Icon name="warning" size={16} className="mt-0.5" />
              <span>
                {deliveryProblem} Your account was created — the code just could not be emailed.
                Check the mail settings for this deployment, then use Resend code.
              </span>
            </p>
          )}

          <form onSubmit={handleVerify} className="space-y-4">
            {/* `gap-1.5` and a flexible width keep all six boxes on one row at
                320px; fixed 48px boxes with a 8px gap did not fit. */}
            {codeBoxes}
            {error && <p className="notice-error">{error}</p>}
            <button type="submit" disabled={loading} className="btn-primary btn-block">
              {loading ? 'Verifying…' : 'Verify email'}
            </button>
          </form>

          {resendRow}
          {backButton(() => { setTab('register'); setError(''); }, 'Back')}
        </>
      ) : tab === 'forgot' ? (
        /* ── Forgotten password ─────────────────────────────────────────── */
        <>
          <div className="text-center mb-6">
            <h2 className="text-xl font-bold text-gray-900">Reset your password</h2>
            <p className="text-sm text-gray-500 mt-1">
              Enter your account email and we&apos;ll send you a reset link.
            </p>
          </div>

          {forgotSent ? (
            <p className="notice-success justify-center text-center">
              If an account exists for that address, a reset link is on its way.
            </p>
          ) : (
            <form onSubmit={handleForgotPassword} className="space-y-4">
              <label className="field">
                <span className="field-label">Email Address</span>
                <input
                  className="input"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  placeholder="name@company.com"
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  required
                />
              </label>
              {error && <p className="notice-error">{error}</p>}
              <button type="submit" disabled={loading} className="btn-primary btn-block">
                {loading ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
          )}

          {backButton(() => { setTab('login'); setError(''); setForgotSent(false); })}
        </>
      ) : (
        /* ── Sign in / sign up ──────────────────────────────────────────── */
        <>
          {/* No name or tagline here — AuthShell shows the mark above the card,
              and repeating it inside was the whole of what made this screen top
              heavy on a phone.

              Identifier, not step: switching this keeps you on the same screen
              and changes only which field proves who you are. */}
          {/* Hidden entirely when the deployment cannot send an SMS — see
              `phoneAvailable`. One method left is not a choice, so the control
              that offers the choice goes with it. */}
          {phoneAvailable && (
          <div role="tablist" aria-label="Sign-in method" className="flex rounded-xl bg-primary-50 p-1 mb-6">
            {[['email', 'Email'], ['phone', 'Phone']].map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={method === key}
                onClick={() => { setMethod(key); setError(''); }}
                className={`flex-1 min-h-[40px] text-sm font-semibold rounded-lg transition
                            focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                  method === key ? 'bg-white shadow-sm text-gray-900' : 'text-primary-700/70 hover:text-primary-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          )}

          <form onSubmit={handleAuth} className="space-y-4">
            {isRegister && (
              <label className="field">
                <span className="field-label">Full Name</span>
                <input
                  className="input"
                  autoComplete="name"
                  placeholder="John Doe"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                />
              </label>
            )}

            {method === 'email' ? (
              <>
                <label className="field">
                  <span className="field-label">Email Address</span>
                  <input
                    className="input"
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    placeholder={isRegister ? 'john@example.com' : 'name@company.com'}
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    required
                  />
                </label>

                {/* autoComplete tells a password manager which field it is
                    looking at, and differs between signing in and signing up. */}
                <label className="field">
                  <span className="field-label">Password</span>
                  <PasswordField
                    label="Password"
                    autoComplete={isRegister ? 'new-password' : 'current-password'}
                    placeholder="••••••••"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    required
                  />
                </label>
              </>
            ) : (
              <PhoneField
                country={country}
                onCountryChange={setCountry}
                value={national}
                onChange={setNational}
                required
                hint={isRegister
                  ? 'We’ll text you a code to confirm this number. No password needed.'
                  : 'We’ll text you a 6-digit code to sign in.'}
              />
            )}

            {!isRegister && method === 'email' && (
              <div className="text-right -mt-1">
                <button
                  type="button"
                  onClick={() => { setTab('forgot'); setError(''); }}
                  className="inline-flex items-center min-h-[36px] px-1 text-sm font-medium text-primary-600 hover:underline"
                >
                  Forgot Password?
                </button>
              </div>
            )}

            {isRegister && (
              <label className="flex items-start gap-3 text-sm text-gray-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  className="mt-0.5 w-5 h-5 shrink-0 rounded border-gray-300 text-primary-600
                             focus:ring-2 focus:ring-primary-500 focus:ring-offset-0 cursor-pointer"
                />
                <span>
                  I agree to the{' '}
                  <a href="/terms" className="text-primary-600 font-medium hover:underline">Terms &amp; Conditions</a>
                  {' '}and{' '}
                  <a href="/privacy-policy" className="text-primary-600 font-medium hover:underline">Privacy Policy</a>.
                </span>
              </label>
            )}

            {error && <p className="notice-error">{error}</p>}

            <button type="submit" disabled={loading} className="btn-primary btn-block">
              {loading
                ? 'Please wait…'
                : (
                  <>
                    {isRegister ? 'Create Account' : 'Sign In'}
                    <Icon name="arrowRight" size={18} />
                  </>
                )}
            </button>
          </form>

          {/* The "or continue with" divider belongs to the button and renders
              with it — see GoogleSignInButton. A copy here would be a heading
              over nothing wherever Google is not configured.

              One button for both tabs: the API registers on the first Google
              sign-in and signs in on every one after, so there is no separate
              "sign up with Google" for a parent to pick wrongly. It renders
              nothing at all unless this deployment has an OAuth client. */}
          <GoogleSignInButton
            text={isRegister ? 'signup_with' : 'signin_with'}
            onCredential={handleGoogle}
            onError={(err) => setError(errorMessage(err, 'Could not reach Google to sign in.'))}
          />

          <p className="text-sm text-gray-600 text-center mt-6">
            {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
            <button
              type="button"
              onClick={() => {
                setTab(isRegister ? 'login' : 'register');
                setError('');
              }}
              className="text-primary-600 font-semibold hover:underline"
            >
              {isRegister ? 'Log In' : 'Sign Up'}
            </button>
          </p>
        </>
      )}
    </AuthShell>
  );
}
