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
  return error?.response?.data?.error || error?.message || fallback;
};

export default api;
