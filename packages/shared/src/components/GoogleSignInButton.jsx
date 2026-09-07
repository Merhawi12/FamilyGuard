import { useCallback, useEffect, useRef, useState } from 'react';
import { auth as authApi } from '../api/endpoints.js';

const GSI_SRC = 'https://accounts.google.com/gsi/client';

/**
 * Whether this is the Capacitor shell rather than a browser.
 *
 * Identity Services is a *browser* SDK and Google will not run its sign-in in an
 * embedded WebView — that is their policy, not a bug to work around, and it is
 * why the mobile answer is a native plugin talking to Play Services rather than
 * this script. In the APK the script does not even load: what the parent saw
 * before there was a `native` adapter was "Could not reach Google to sign in" in
 * red, under an "or continue with" divider with nothing beneath it, on every
 * visit to the sign-in screen.
 *
 * That is precisely the dead button this component's contract exists to avoid,
 * one layer up — the check below only asked whether Google was *configured*,
 * never whether it could work here. Login.jsx says the same thing about the
 * reset flow: inside the Capacitor shell, "bouncing out to a browser and back
 * was never going to" work.
 *
 * Guarded because `window.Capacitor` is undefined in a browser and this runs
 * during render on both.
 */
const inNativeShell = () => {
  try {
    return !!window.Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
};

/** Google's mark, at the size their branding guidance asks for beside the text. */
const GoogleMark = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.97-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

/**
 * Sign in with Google, by whichever route this build actually has.
 *
 * ## In a browser
 *
 * The button is Google's own, injected into `ref` by their Identity Services
 * script. Drawing our own and calling the library by hand is possible and is a
 * bad trade: the branding rules are strict, the button is what users recognise,
 * and Google changes the flow behind it without changing this API.
 *
 * ## In the Android app
 *
 * That script cannot run, so the host passes a `native` adapter — see
 * `apps/family-app/src/services/googleAuth.js` — and the button below is ours,
 * drawn to Google's guidance because there is no script to draw theirs. The
 * adapter is a prop rather than an import: this package is also what the admin
 * console is built from, and it must not learn about Capacitor.
 *
 * ## Both
 *
 * What comes back is an ID token — a JWT signed by Google — which is posted
 * straight to the API. Nothing is decided on the device: the API checks the
 * signature, the issuer, the expiry and the audience before it will look up an
 * account. So a tampered token is not a client-side problem.
 *
 * The component renders nothing at all unless two independently configured
 * things are both true: the deployment advertises Google as a provider
 * (`GET /auth/providers`) and this build can obtain a token — a client ID
 * compiled into the bundle in a browser, or an adapter that reports itself ready
 * on a device. Either missing is a configuration state, not a fault — a dead
 * button that fails on click is worse than no button.
 */
export default function GoogleSignInButton({ onCredential, onError, text = 'signin_with', native = null }) {
  const ref = useRef(null);
  const nativeShell = inNativeShell();
  // Deliberately empty in the shell: the bundle's client ID is a *browser*
  // credential, and the native adapter carries its own. See `nativeReady`.
  const clientId = nativeShell ? '' : (import.meta.env?.VITE_GOOGLE_CLIENT_ID || '');
  /**
   * Whether the device half can work: a client ID compiled into the APK, and a
   * handset with Play Services to show the chooser. Asked of the adapter rather
   * than assumed from `nativeShell`, because a Capacitor build without the
   * plugin — the iOS one — is a shell where this cannot happen.
   */
  const [nativeReady, setNativeReady] = useState(false);
  const [serverOffers, setServerOffers] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!nativeShell || !native) return undefined;
    let cancelled = false;
    Promise.resolve()
      .then(() => native.available())
      .then((ok) => { if (!cancelled) setNativeReady(!!ok); })
      .catch(() => { /* no plugin, no Play Services — stay hidden */ });
    return () => { cancelled = true; };
  }, [nativeShell, native]);

  const configured = nativeShell ? nativeReady : !!clientId;

  // The server is asked as well as the client, because the two are configured
  // separately and independently: a client ID baked into a build that the API
  // does not know about produces a token it will refuse.
  useEffect(() => {
    if (!configured) return undefined;
    let cancelled = false;
    authApi
      .providers()
      .then((res) => {
        if (!cancelled) setServerOffers(!!res.data?.google);
      })
      .catch(() => {
        /* offline, or an older API — leave the button hidden */
      });
    return () => {
      cancelled = true;
    };
  }, [configured]);

  const available = configured && serverOffers;

  useEffect(() => {
    if (nativeShell || !available || !ref.current) return undefined;

    let cancelled = false;

    const render = () => {
      if (cancelled || !ref.current || !window.google?.accounts?.id) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: ({ credential }) => {
          if (credential) onCredential(credential);
          else onError?.(new Error('Google did not return a credential'));
        },
        // The browser deciding on its own to sign someone in, on a page about a
        // family's location history, is not a welcome surprise.
        auto_select: false,
        cancel_on_tap_outside: true,
      });
      window.google.accounts.id.renderButton(ref.current, {
        theme: 'outline',
        size: 'large',
        width: 320,
        text,
        shape: 'rectangular',
        logo_alignment: 'left',
      });
    };

    if (window.google?.accounts?.id) {
      render();
      return () => {
        cancelled = true;
      };
    }

    // Loaded here rather than in index.html so a visitor who never reaches the
    // sign-in page never contacts Google at all.
    let script = document.querySelector(`script[src="${GSI_SRC}"]`);
    if (!script) {
      script = document.createElement('script');
      script.src = GSI_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    script.addEventListener('load', render);
    script.addEventListener('error', () => onError?.(new Error('Could not reach Google to sign in')));

    return () => {
      cancelled = true;
      script.removeEventListener('load', render);
    };
  }, [nativeShell, available, clientId, onCredential, onError, text]);

  /**
   * The device path. `signIn` resolving with nothing is a chooser that was
   * dismissed — a normal outcome, and the one case that must leave no error
   * behind it.
   */
  const handleNativeTap = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const credential = await native.signIn();
      // Awaited so the button stays disabled for the API round trip as well as
      // for the chooser; the caller's own error handling is what reports a
      // rejected token.
      if (credential) await onCredential(credential);
    } catch (err) {
      onError?.(err);
    } finally {
      setBusy(false);
    }
  }, [busy, native, onCredential, onError]);

  if (!available) return null;

  return (
    <div className="mt-5">
      {/* The divider lives here, not on the page, because it is only ever
          separating the page's form from *this* button — and this component is
          the only thing that knows whether the button is going to render. A
          page-level copy becomes a heading over nothing on any deployment
          without an OAuth client. */}
      <div className="flex items-center gap-3 mb-4" aria-hidden="true">
        <span className="h-px flex-1 bg-gray-200" />
        <span className="text-xs text-gray-400">or continue with</span>
        <span className="h-px flex-1 bg-gray-200" />
      </div>
      {nativeShell ? (
        <button
          type="button"
          onClick={handleNativeTap}
          disabled={busy}
          className="btn-secondary btn-block"
        >
          <GoogleMark />
          {/* Google's approved wording, matched to the tab the parent is on —
              the same two strings the web button is asked for. */}
          {busy
            ? 'Please wait…'
            : (text === 'signup_with' ? 'Sign up with Google' : 'Sign in with Google')}
        </button>
      ) : (
        <div ref={ref} className="flex justify-center" />
      )}
    </div>
  );
}
