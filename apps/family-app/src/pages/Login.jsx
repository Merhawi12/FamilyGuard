import { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
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
 * entry screens and everything else ('verify', 'code', 'mfa', and the three-step
 * 'forgot' → 'reset-code' → 'reset-new') is a step reached from one of them.
 * `method` is the identifier — 'email' or 'phone' — and is what the segmented
 * control switches. Keeping them separate is what lets the phone path reuse the
 * code screen, the MFA challenge and the post-sign-in redirect rather than
 * growing parallel copies of each.
 *
 * Password reset lives here rather than on its own route because it is now three
 * screens rather than one: since the email carries a code instead of a link,
 * nothing arrives at a URL, and the whole flow can finish where it started —
 * which also means it works inside the Capacitor shell, where bouncing out to a
 * browser and back was never going to.
 */
export default function Login() {
  const location = useLocation();
  const query = new URLSearchParams(location.search);

  /**
   * Which entry screen to open on.
   *
   * Only the two entry screens may be named in a URL. The other steps — 'mfa',
   * 'verify', 'login-code', the reset trio — are reached by completing the one
   * before them and carry state a query string cannot supply, so honouring
   * `?tab=verify` would render a code box for a code nobody sent.
   *
   * `?tab=register` exists for the landing page's "Get Premium", which pairs it
   * with `?redirect=premium`: somebody buying a subscription is almost always
   * new, and putting them on Sign In first is a step backwards on the one
   * journey the product most wants to be smooth.
   */
  const [tab, setTab] = useState(query.get('tab') === 'register' ? 'register' : 'login');
  /**
   * Which entry screen the current step came from.
   *
   * `tab` is the step, so it stops being 'register' the moment the code screen
   * opens — and `isRegister` is derived from it. Everything the code screen still
   * has to do with the original intent was therefore reading 'login': resending
   * an SMS during *signup* asked for `mode: 'login'`, which for a number with no
   * verified account is the one case the API refuses, so the parent who tapped
   * "Resend code" on the screen the signup had just put them on was told "No
   * account found for that number. Create one instead." — about the account they
   * were in the middle of creating. "Use a different number" landed them on Sign
   * In for the same reason.
   */
  const [entry, setEntry] = useState('login');
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
  /**
   * Whether the code failed to leave the building — a flag, not the API's words.
   *
   * The API reports delivery honestly (it used to always answer "sent", which
   * stranded every new account on a screen waiting for a message that was never
   * going out), and this screen used to render `data.message` and then append its
   * own advice to it. The two said the same thing, so the parent read the same
   * sentence twice: "Your code could not be sent. Check the SMS settings for this
   * deployment. Check the SMS settings for this deployment, then use Resend code."
   *
   * Holding a boolean rather than the string is what makes that unrepeatable
   * instead of merely fixed — there is no longer a server sentence here to
   * concatenate. It also settles the more important half: `message` is written
   * for an operator reading logs, and "check the SMS settings for this
   * deployment" is not something a parent trying to sign in can act on. The
   * server keeps its wording for the API contract and the logs; the screen says
   * what the person in front of it needs to hear. Same rule as the 404 in
   * `errorMessage` and the linking-code 404 in the child app.
   */
  const [deliveryProblem, setDeliveryProblem] = useState(false);
  const [error, setError] = useState('');
  /** Good news, where `error` is bad. Survives the step change that shows it. */
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [forgotEmail, setForgotEmail] = useState('');
  /**
   * The reset ticket, held for exactly one screen.
   *
   * `verify-reset-code` mints it once the six digits come back and
   * `reset-password` spends it. It is never emailed and never stored — a reload
   * on the "choose a new password" step means starting the flow again, which is
   * the correct outcome for a fifteen-minute credential.
   */
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState({ value: '', confirm: '' });
  const [mfa, setMfa] = useState({ preAuthToken: '', code: '' });
  /**
   * The outstanding emailed sign-in code: the five-minute ticket that proves the
   * password was right, and the masked address the API sent the digits to.
   *
   * Held in state and nowhere else. A reload during the challenge means signing
   * in again, which is correct — the ticket outlives the page by design only for
   * as long as the page is open.
   */
  const [loginChallenge, setLoginChallenge] = useState({ preAuthToken: '', email: '' });
  const [rememberDevice, setRememberDevice] = useState(false);
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
    login, loginWithGoogle, completeMfa, completeLoginCode, resendLoginCode,
    register, verifyEmail, requestPhoneCode, loginWithPhone,
  } = useAuth();
  const navigate = useNavigate();
  const redirectPlan = query.get('redirect');

  const isRegister = tab === 'register';

  /**
   * Shared tail of a successful sign-in, whatever proved it.
   *
   * ## A failed checkout must not cost someone their session
   *
   * This used to `await createCheckoutSession()` bare. The sign-in had already
   * succeeded and the token was already stored — but the rejection propagated
   * out of here, through `settle`, into the submit handler's `catch`, and became
   * an error message *on the login form*. So someone who chose Premium signed up
   * correctly, was told "Payments are not configured", and was never navigated
   * anywhere: authenticated, and still looking at the sign-in screen.
   *
   * That is not a hypothetical. `/auth/providers` reports `billing:false`
   * whenever `STRIPE_SECRET_KEY` is unset or unreadable — which production has
   * been for stretches — and every one of those minutes turned "Get Premium"
   * into a door that locked behind you.
   *
   * Checkout is the *bonus* half of this function. Signing in is the part that
   * has already worked, so the failure path keeps it and explains itself on the
   * plan screen instead.
   */
  const finishSignIn = async () => {
    // Checked against the catalogue rather than a hard-coded pair, so a
    // `?redirect=` for a retired tier lands on the dashboard instead of a
    // checkout the API refuses.
    if (PAID_PLAN_KEYS.includes(redirectPlan)) {
      try {
        const res = await payments.createCheckoutSession(redirectPlan);
        // A 200 with no URL is as unusable as a 503, and silently doing nothing
        // here would leave the browser sitting on the sign-in form.
        if (res?.data?.url) {
          window.location.href = res.data.url;
          return;
        }
      } catch {
        // Deliberately swallowed: the reason belongs on the plan screen, where
        // there is a button to try again, not on a form the account no longer
        // needs. `checkout=unavailable` is what puts it there.
      }
      navigate(`/dashboard/settings?section=plan&checkout=unavailable&plan=${redirectPlan}`);
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
    /**
     * The emailed second factor. Below the authenticator branch because the API
     * puts it there too: an account with an authenticator is never sent one.
     *
     * `email` arrives masked, and the screen shows exactly what it was given —
     * re-deriving it from what was typed would print the whole address on a
     * screen reached with a password alone.
     */
    if (result?.loginCodeRequired) {
      setLoginChallenge({
        preAuthToken: result.preAuthToken,
        email: result.email || '',
        // True when the server reused a code sent moments ago instead of sending
        // another. The screen has to say which, or somebody who came back for a
        // second try sits waiting for an email that is not coming — it is
        // already in their inbox.
        already: !!result.codeAlreadySent,
      });
      setRememberDevice(false);
      setCode(['', '', '', '', '', '']);
      setDeliveryProblem(false);
      // The server's own figure when it reused a code rather than sending one,
      // so "Resend in Ns" counts down to the moment a resend is actually allowed
      // instead of to a guess that is refused when it arrives.
      setResendCooldown(result.retryAfter || 60);
      setTab('login-code');
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
    // Remembered before the step changes, so a resend still knows what it is
    // resending for. See `entry`.
    setEntry(tab);
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
        setDeliveryProblem(data.smsDelivered === false && !data.devCode);
        setCode(['', '', '', '', '', '']);
        setResendCooldown(60);
        setTab('code');
        return;
      }

      if (isRegister) {
        const result = await register(form.name, form.email, form.password);
        setPendingEmail(form.email);
        setDeliveryProblem(result?.emailDelivered === false);
        setTab('verify');
        return;
      }

      await settle(await login(form.email, form.password));
    } catch (err) {
      const data = err.response?.data;
      /**
       * Email not verified — switch to the verification step, and send a code,
       * because the screen we are about to show says we did.
       *
       * It used to only switch. The screen it switches to reads "We sent a
       * 6-digit code to …", and on this path nothing had been sent: the only
       * code in existence was the one `register` issued, which expires after
       * fifteen minutes. So anybody returning to an account they had not
       * finished verifying — the next morning, or at all during the weeks
       * outbound mail was down — was shown a sentence that was false, and then
       * waited for a message that was never coming.
       *
       * The visible half of that is what it drives people to do next: the only
       * other button offering to email them anything is Forgot Password, so
       * they end up holding a *password reset* code on the *email verification*
       * screen, where it does not work. Two codes, two purposes, and the one
       * they were told to expect was the one nobody sent.
       *
       * Deliberately after `setTab`, so the screen appears immediately and the
       * request settles under it rather than delaying it behind a round trip.
       */
      if (data?.emailVerificationRequired) {
        setPendingEmail(form.email);
        setDeliveryProblem(false);
        setCode(['', '', '', '', '', '']);
        setTab('verify');

        try {
          const res = await authApi.resendCode({ email: form.email });
          setDeliveryProblem(res.data?.emailDelivered === false);
          setResendCooldown(60);
        } catch (resendErr) {
          /**
           * A 429 is the account's own cooldown, and it means a code went out
           * recently and is still live — so the screen's sentence is true and
           * there is nothing to report. Anything else is a real failure to
           * send, and the banner says so rather than leaving them waiting.
           */
          if (resendErr.response?.status === 429) {
            setResendCooldown(resendErr.response.data?.retryAfter || 60);
          } else {
            setDeliveryProblem(true);
          }
        }
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

  /**
   * The emailed sign-in code. Ends in a session, so it runs the same tail as a
   * password that needed no second factor.
   */
  const handleLoginCode = async (e) => {
    e.preventDefault();
    const fullCode = code.join('');
    if (fullCode.length < 6) return setError('Enter the 6-digit code');
    setError('');
    setLoading(true);
    try {
      await completeLoginCode(loginChallenge.preAuthToken, fullCode, rememberDevice);
      await finishSignIn();
    } catch (err) {
      /**
       * A 401 here has two meanings and they need different sentences. A wrong
       * code is worth retyping; an expired five-minute ticket is not — those
       * digits will never be accepted now, and without saying so the parent
       * types the same correct code from the same email until the account locks.
       */
      if (err.response?.status === 401 && /pre-auth/i.test(err.response.data?.error || '')) {
        setLoginChallenge({ preAuthToken: '', email: '' });
        setTab('login');
        setError('That sign-in attempt timed out. Enter your password again for a new code.');
        return;
      }
      setError(errorMessage(err, 'That code is invalid or has expired.'));
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

  /**
   * Step one of three. Moves to the code screen whatever the answer was.
   *
   * The API deliberately gives the same 200 for an address with an account and
   * one without, so waiting on the response to decide would be inventing an
   * answer it refused to give. Someone who mistyped their address types a code
   * that never arrives and gets "That code is invalid" — which is the cost of an
   * endpoint that will not confirm who has an account, and the right price.
   */
  const handleForgotPassword = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await authApi.forgotPassword({ email: forgotEmail });
      setCode(['', '', '', '', '', '']);
      setResendCooldown(60);
      setTab('reset-code');
    } catch (err) {
      setError(errorMessage(err, 'Could not send a reset code.'));
    } finally {
      setLoading(false);
    }
  };

  /** Step two. Six digits in, a single-use ticket out. */
  const handleVerifyResetCode = async (e) => {
    e.preventDefault();
    const fullCode = code.join('');
    if (fullCode.length < 6) return setError('Enter the 6-digit code');
    setError('');
    setLoading(true);
    try {
      const res = await authApi.verifyResetCode({ email: forgotEmail, code: fullCode });
      setResetToken(res.data.resetToken);
      setNewPassword({ value: '', confirm: '' });
      setTab('reset-new');
    } catch (err) {
      setError(errorMessage(err, 'That code is invalid or has expired.'));
    } finally {
      setLoading(false);
    }
  };

  /**
   * Step three. Ends at the sign-in screen rather than in the app: a reset is
   * what somebody does when they think their account is compromised, and it
   * revokes every session — including any this browser was holding.
   */
  const handleSetNewPassword = async (e) => {
    e.preventDefault();
    setError('');
    if (newPassword.value !== newPassword.confirm) return setError('Those passwords do not match.');
    if (newPassword.value.length < 10) return setError('Use at least 10 characters.');

    setLoading(true);
    try {
      await authApi.resetPassword({ token: resetToken, newPassword: newPassword.value });
      setResetToken('');
      setNewPassword({ value: '', confirm: '' });
      setForm((f) => ({ ...f, email: forgotEmail, password: '' }));
      setNotice('Your password has been reset. Sign in with your new one.');
      setTab('login');
    } catch (err) {
      setError(errorMessage(err, 'We could not reset your password. Ask for a new code and try again.'));
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (resendCooldown > 0) return;
    try {
      if (tab === 'code') {
        const data = await requestPhoneCode(pendingPhone.e164, {
          mode: entry === 'register' ? 'register' : 'login',
          name: form.name,
        });
        setDevCode(data.devCode || '');
        setDeliveryProblem(data.smsDelivered === false && !data.devCode);
      } else if (tab === 'login-code') {
        // Takes the ticket, not the address: the password is already proved, so
        // there is nothing here that could aim a message at somebody else.
        const data = await resendLoginCode(loginChallenge.preAuthToken);
        setDeliveryProblem(data?.emailDelivered === false);
      } else if (tab === 'reset-code') {
        // The same call that started the flow. It answers 200 whatever happens,
        // including when the server's own cooldown refuses to send — so there is
        // nothing here to report and the countdown below is the honest signal.
        await authApi.forgotPassword({ email: forgotEmail });
      } else {
        const res = await authApi.resendCode({ email: pendingEmail });
        setDeliveryProblem(res.data?.emailDelivered === false);
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
      ) : tab === 'login-code' ? (
        /* ── Emailed sign-in code ──────────────────────────────────────────── */
        <>
          <div className="text-center mb-6">
            <span className="inline-flex w-14 h-14 bg-primary-50 text-primary-600 rounded-2xl items-center justify-center mb-3">
              <Icon name="shield" size={26} />
            </span>
            <h2 className="text-xl font-bold text-gray-900">Confirm it&apos;s you</h2>
            <p className="text-sm text-gray-500 mt-1">
              {loginChallenge.already
                ? 'Use the code we just sent to'
                : 'We sent a 6-digit code to'}<br />
              <span className="font-semibold text-gray-700 break-all">{loginChallenge.email}</span>
            </p>
          </div>

          {deliveryProblem && (
            <p className="notice-warning mb-4 text-left">
              <Icon name="warning" size={16} className="mt-0.5" />
              <span>
                We could not send that code just now — this is a problem at our end,
                not with your password. Try Resend in a moment, and if it keeps
                failing <a href="/contact" className="font-semibold underline">contact support</a>.
              </span>
            </p>
          )}

          <form onSubmit={handleLoginCode} className="space-y-4">
            {codeBoxes}

            {/* The whole reason a code on every sign-in is liveable. Off by
                default: a parent signing in on a library computer should have to
                choose to be remembered on it. */}
            <label className="flex items-start gap-3 text-sm text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={rememberDevice}
                onChange={(e) => setRememberDevice(e.target.checked)}
                className="mt-0.5 w-5 h-5 shrink-0 rounded border-gray-300 text-primary-600
                           focus:ring-2 focus:ring-primary-500 focus:ring-offset-0 cursor-pointer"
              />
              <span>
                Trust this device for 30 days
                <span className="block text-xs text-gray-500">
                  Skip this step next time. Don&apos;t tick this on a shared device.
                </span>
              </span>
            </label>

            {error && <p className="notice-error">{error}</p>}
            <button type="submit" disabled={loading} className="btn-primary btn-block">
              {loading ? 'Verifying…' : 'Verify & sign in'}
            </button>
          </form>

          {resendRow}
          {backButton(() => {
            setTab('login');
            setError('');
            setDeliveryProblem(false);
            setLoginChallenge({ preAuthToken: '', email: '' });
          })}
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
            <div className="notice-warning mb-4 text-left">
              <Icon name="warning" size={16} className="mt-0.5" />
              <span>
                We could not text that number. Nothing is wrong with the number you
                entered — this is a problem at our end.
                {' '}You can try Resend below, or sign in with an email address instead.
                <button
                  type="button"
                  onClick={() => { setMethod('email'); setTab(entry); setError(''); setDeliveryProblem(false); }}
                  className="block mt-2 font-semibold underline"
                >
                  Use an email address instead
                </button>
              </span>
            </div>
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
          {backButton(() => { setTab(entry); setError(''); }, 'Use a different number')}
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
              {/* Says nothing about *when* the account was made: this screen is
                  now reached both from signing up and from signing in to an
                  account that was never verified, and "Your account was created"
                  read as news to someone who made it a fortnight ago. */}
              <span>
                We could not send the code to that address. Nothing you typed is wrong —
                this is a problem at our end. Your account is fine and still waiting for you.
                Try Resend in a moment, and if it keeps failing{' '}
                <a href="/contact" className="font-semibold underline">contact support</a>.
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
        /* ── Forgotten password, step 1 of 3 ────────────────────────────── */
        <>
          <div className="text-center mb-6">
            <h2 className="text-xl font-bold text-gray-900">Reset your password</h2>
            <p className="text-sm text-gray-500 mt-1">
              Enter your account email and we&apos;ll send you a 6-digit code.
            </p>
          </div>

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
              {loading ? 'Sending…' : 'Send reset code'}
            </button>
          </form>

          {backButton(() => { setTab('login'); setError(''); })}
        </>
      ) : tab === 'reset-code' ? (
        /* ── Forgotten password, step 2 of 3 ────────────────────────────── */
        <>
          <div className="text-center mb-6">
            <span className="inline-flex w-14 h-14 bg-primary-50 text-primary-600 rounded-2xl items-center justify-center mb-3">
              <Icon name="mail" size={26} />
            </span>
            <h2 className="text-xl font-bold text-gray-900">Check your email</h2>
            <p className="text-sm text-gray-500 mt-1">
              If an account exists for<br />
              <span className="font-semibold text-gray-700 break-all">{forgotEmail}</span><br />
              we&apos;ve sent it a 6-digit code.
            </p>
          </div>

          <form onSubmit={handleVerifyResetCode} className="space-y-4">
            {codeBoxes}
            {error && <p className="notice-error">{error}</p>}
            <button type="submit" disabled={loading} className="btn-primary btn-block">
              {loading ? 'Checking…' : 'Continue'}
            </button>
          </form>

          {resendRow}
          {backButton(() => { setTab('forgot'); setError(''); }, 'Use a different address')}
        </>
      ) : tab === 'reset-new' ? (
        /* ── Forgotten password, step 3 of 3 ────────────────────────────── */
        <>
          <div className="text-center mb-6">
            <h2 className="text-xl font-bold text-gray-900">Choose a new password</h2>
            <p className="text-sm text-gray-500 mt-1">
              At least 10 characters, including a letter and a number.
            </p>
          </div>

          <form onSubmit={handleSetNewPassword} className="space-y-4">
            <PasswordField
              label="New password"
              autoComplete="new-password"
              placeholder="New password"
              value={newPassword.value}
              onChange={(e) => setNewPassword((p) => ({ ...p, value: e.target.value }))}
              required
            />
            <PasswordField
              label="Confirm new password"
              autoComplete="new-password"
              placeholder="Confirm new password"
              value={newPassword.confirm}
              onChange={(e) => setNewPassword((p) => ({ ...p, confirm: e.target.value }))}
              required
            />
            {/* Said before it happens rather than after: every other device is
                signed out, and a parent who does not expect that reads it as the
                reset having gone wrong. */}
            <p className="text-xs text-gray-500">
              This signs you out everywhere else.
            </p>
            {error && <p className="notice-error">{error}</p>}
            <button type="submit" disabled={loading} className="btn-primary btn-block">
              {loading ? 'Saving…' : 'Reset password'}
            </button>
          </form>

          {backButton(() => { setTab('login'); setError(''); setResetToken(''); })}
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

          {/* Where a finished password reset lands. Rendered above the form so
              it is the first thing read, and cleared by the tab switch below. */}
          {notice && <p className="notice-success mb-4">{notice}</p>}

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
                  onClick={() => {
                    // Carried across so the reset screen does not ask for an
                    // address that has already been typed one field above.
                    if (form.email) setForgotEmail(form.email);
                    setTab('forgot');
                    setError('');
                    setNotice('');
                  }}
                  className="link-action"
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
                {/* Links, not anchors. An anchor here is a full page load, so a
                    parent part-way through signing up who wanted to read what
                    they were agreeing to came back to an empty form — including
                    the box they had just ticked. */}
                <span>
                  I agree to the{' '}
                  <Link to="/terms" className="text-primary-600 font-medium hover:underline">Terms &amp; Conditions</Link>
                  {' '}and{' '}
                  <Link to="/privacy-policy" className="text-primary-600 font-medium hover:underline">Privacy Policy</Link>.
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
                setNotice('');
              }}
              className="inline-flex items-center min-h-[44px] px-1 text-primary-600 font-semibold hover:underline"
            >
              {isRegister ? 'Log In' : 'Sign Up'}
            </button>
          </p>
        </>
      )}
    </AuthShell>
  );
}
