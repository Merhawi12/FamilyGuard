import { useEffect, useRef, useState } from 'react';
import { auth as authApi } from '../api/endpoints.js';

const GSI_SRC = 'https://accounts.google.com/gsi/client';

/**
 * Sign in with Google, rendered by Google.
 *
 * The button is Google's own, injected into `ref` by their Identity Services
 * script. Drawing our own and calling the library by hand is possible and is a
 * bad trade: the branding rules are strict, the button is what users recognise,
 * and Google changes the flow behind it without changing this API.
 *
 * What comes back is an ID token — a JWT signed by Google — which is posted
 * straight to the API. Nothing is decided in the browser: the API checks the
 * signature, the issuer, the expiry and the audience before it will look up an
 * account. So a tampered token is not a client-side problem.
 *
 * The component renders nothing at all unless two things are true: the
 * deployment advertises Google as a provider (`GET /auth/providers`) and a
 * client ID was compiled in. Either missing is a configuration state, not a
 * fault — a dead button that fails on click is worse than no button.
 */
export default function GoogleSignInButton({ onCredential, onError, text = 'signin_with' }) {
  const ref = useRef(null);
  const [available, setAvailable] = useState(false);
  const clientId = import.meta.env?.VITE_GOOGLE_CLIENT_ID || '';

  // The server is asked as well as the bundle, because the two are configured
  // separately and independently: a client ID baked into a build that the API
  // does not know about produces a token it will refuse.
  useEffect(() => {
    if (!clientId) return undefined;
    let cancelled = false;
    authApi
      .providers()
      .then((res) => {
        if (!cancelled) setAvailable(!!res.data?.google);
      })
      .catch(() => {
        /* offline, or an older API — leave the button hidden */
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  useEffect(() => {
    if (!available || !ref.current) return undefined;

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
  }, [available, clientId, onCredential, onError, text]);

  if (!clientId || !available) return null;

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
      <div ref={ref} className="flex justify-center" />
    </div>
  );
}
