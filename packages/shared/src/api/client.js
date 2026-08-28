import axios from 'axios';
import { API_BASE_URL } from '../config.js';

/**
 * Where the session JWT lives. Each app passes its own key so the Admin Dashboard
 * and Family App never share a session even when served from the same host during
 * local development.
 */
let tokenKey = 'px_token';

export const setTokenKey = (key) => {
  tokenKey = key;
};

export const getToken = () => localStorage.getItem(tokenKey);
export const setToken = (token) => localStorage.setItem(tokenKey, token);
export const clearToken = () => localStorage.removeItem(tokenKey);

/**
 * "Don't ask me for a sign-in code on this browser again."
 *
 * A 30-day claim the API mints when someone ticks the box on the code screen,
 * and presents on the next `POST /auth/login` so the challenge is skipped. It is
 * bound to one account and useless without the password; the API refuses it
 * after a password change or reset.
 *
 * Derived from `tokenKey` rather than given its own setter, so the Admin Console
 * and the Family App keep separate ones for free and neither app can forget to
 * name it. Deliberately *not* cleared by `clearToken`: skipping the code after
 * signing out and back in is the case it exists for, and clearing it on logout
 * would push an ordinary parent into the five-sends-an-hour ceiling. Only a
 * password change clears it, and the API does that end.
 */
const trustedDeviceKey = () => `${tokenKey}_trusted_device`;

export const getTrustedDeviceToken = () => localStorage.getItem(trustedDeviceKey());
export const setTrustedDeviceToken = (token) => localStorage.setItem(trustedDeviceKey(), token);
export const clearTrustedDeviceToken = () => localStorage.removeItem(trustedDeviceKey());

/** Where to send the browser when a live session turns out to be dead. */
let loginPath = '/login';

export const setLoginPath = (path) => {
  loginPath = path;
};

const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  timeout: 15000,
});

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/**
 * Endpoints where a 401 is a legitimate answer rather than an expired session —
 * the form needs to render "invalid credentials" instead of bouncing to /login.
 *
 * Every sign-in method belongs here, not just the password one. `/auth/google`
 * answers 401 for a credential Google's keys reject, and that reply was being
 * read as "your session died": the interceptor cleared the token and threw the
 * browser at /login, reloading the page out from under the catch block that was
 * about to explain what happened. The user saw a blank sign-in form and no
 * reason at all. The phone and email code paths are listed for the same reason —
 * a wrong code is an answer to a question the form asked, not a dead session.
 */
const AUTH_ATTEMPT_PATHS = [
  // Covers `/auth/login`, `/auth/login/verify` and `/auth/login/resend` — the
  // last two answer 401 for a wrong code or a challenge that has expired, and
  // both are answers to a question the form asked rather than a dead session.
  '/auth/login',
  '/auth/register',
  '/auth/me',
  '/auth/mfa/validate',
  '/auth/google',
  '/auth/phone/request',
  '/auth/phone/verify',
  '/auth/verify-email',
];

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const url = error.config?.url || '';
    const isAuthAttempt = AUTH_ATTEMPT_PATHS.some((path) => url.includes(path));
    if (error.response?.status === 401 && !isAuthAttempt) {
      clearToken();
      window.location.href = loginPath;
    }
    return Promise.reject(error);
  }
);

/**
 * Normalises an axios failure into a message safe to show a user.
 *
 * A 404 is deliberately not passed through. The API answers an unmatched path
 * with the literal body `{"error":"Not found"}`, and this helper handed that
 * straight to the screen — a parent who tried to sign up by phone against a
 * deployment whose API predates the phone endpoints was told "Not found" under
 * the Create Account button, which describes the route table rather than
 * anything they did or could fix.
 *
 * A 404 on a path the client itself constructed always means the client and the
 * server disagree about the API surface — a stale deployment, or a rollback.
 * That is an operator's problem and never a sentence worth showing a parent, so
 * it falls back to the caller's own wording, which is written for the screen it
 * appears on.
 */
export const errorMessage = (error, fallback = 'Something went wrong. Please try again.') => {
  if (error?.response?.status === 404) return fallback;

  /**
   * A request that never reached the API has no `response`, and axios describes
   * those in its own vocabulary: `Network Error`, or `timeout of 15000ms
   * exceeded`. Both were being printed verbatim under a form field. Neither
   * tells a parent the one thing that is true and actionable — the phone or the
   * laptop is not currently talking to us, and nothing they typed was wrong.
   *
   * This is the single place all 87 call sites funnel through, so the offline
   * wording belongs here rather than in each screen's catch block.
   */
  if (!error?.response) {
    const timedOut = error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT';
    if (timedOut) return 'The server is taking too long to respond. Please try again in a moment.';

    // `navigator.onLine` is only trustworthy when it says *false* — a captive
    // portal reports itself online — so it is used to sharpen the message, never
    // to decide whether the request failed.
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (offline) return 'You appear to be offline. Reconnect and try again.';

    if (error?.request) return 'Cannot reach Parentix right now. Check your connection and try again.';
  }

  return error?.response?.data?.error || error?.message || fallback;
};

export default api;
