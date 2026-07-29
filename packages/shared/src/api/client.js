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

// Endpoints where a 401 is a legitimate answer rather than an expired session —
// the form needs to render "invalid credentials" instead of bouncing to /login.
const AUTH_ATTEMPT_PATHS = ['/auth/login', '/auth/register', '/auth/me', '/auth/mfa/validate'];

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

/** Normalises an axios failure into a message safe to show a user. */
export const errorMessage = (error, fallback = 'Something went wrong. Please try again.') =>
  error?.response?.data?.error || error?.message || fallback;

export default api;
