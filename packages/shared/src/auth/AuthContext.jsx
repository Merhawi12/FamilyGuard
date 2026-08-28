import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { auth as authApi, mfa as mfaApi } from '../api/endpoints.js';
import {
  getToken, setToken, clearToken, getTrustedDeviceToken, setTrustedDeviceToken,
} from '../api/client.js';

const AuthContext = createContext(null);

/**
 * Session state for both web apps.
 *
 * `allowRole` lets an app refuse a session that authenticated fine but belongs to
 * the wrong audience — the Admin Dashboard uses it so a parent's token can never
 * mount the staff console, even though the API would 403 each call anyway.
 */
export const AuthProvider = ({ children, allowRole }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const isAllowed = useCallback(
    (candidate) => (typeof allowRole === 'function' ? allowRole(candidate) : true),
    [allowRole]
  );

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    authApi
      .me()
      .then((res) => {
        if (isAllowed(res.data)) setUser(res.data);
        else clearToken();
      })
      .catch(() => clearToken())
      .finally(() => setLoading(false));
  }, [isAllowed]);

  /**
   * A password does not necessarily open a session. Three outcomes:
   *
   * - `{ mfaRequired: true, preAuthToken }` — the account has an authenticator;
   *   the caller finishes with `completeMfa`.
   * - `{ loginCodeRequired: true, preAuthToken, email }` — this deployment sends
   *   a code to the address on the account; the caller finishes with
   *   `completeLoginCode`. `email` is masked and is there so the code screen can
   *   name the inbox.
   * - `{ mfaRequired: false, user }` — signed in.
   *
   * The stored trusted-device token rides along on every attempt. It is what
   * makes the code an event rather than a toll on a browser somebody uses daily;
   * the API ignores an absent, foreign or revoked one.
   */
  const login = useCallback(
    async (email, password) => {
      const res = await authApi.login({
        email,
        password,
        trustedDeviceToken: getTrustedDeviceToken() || undefined,
      });
      if (res.data.mfaRequired) return { mfaRequired: true, preAuthToken: res.data.preAuthToken };
      if (res.data.loginCodeRequired) {
        return {
          loginCodeRequired: true,
          preAuthToken: res.data.preAuthToken,
          email: res.data.email,
          // Set when the challenge reuses a code sent moments ago rather than
          // sending another; `retryAfter` is when a resend becomes possible, so
          // the screen's countdown matches what the server will actually allow.
          codeAlreadySent: !!res.data.codeAlreadySent,
          retryAfter: res.data.retryAfter,
        };
      }

      if (!isAllowed(res.data.user)) {
        const error = new Error('This account does not have access to this application.');
        error.forbiddenRole = true;
        throw error;
      }
      setToken(res.data.token);
      setUser(res.data.user);
      return { mfaRequired: false, user: res.data.user };
    },
    [isAllowed]
  );

  /**
   * The same contract as `login`, with an ID token in place of a password.
   *
   * Registration and sign-in are one call: the API creates the account the first
   * time a Google identity appears and signs it in every time after, so the page
   * needs no separate "sign up with Google" path. The role check still applies —
   * a parent arriving at the staff console is refused here exactly as they are
   * with a password.
   */
  const loginWithGoogle = useCallback(
    async (credential) => {
      const res = await authApi.google(credential);
      if (res.data.mfaRequired) return { mfaRequired: true, preAuthToken: res.data.preAuthToken };

      if (!isAllowed(res.data.user)) {
        const error = new Error('This account does not have access to this application.');
        error.forbiddenRole = true;
        throw error;
      }
      setToken(res.data.token);
      setUser(res.data.user);
      return { mfaRequired: false, user: res.data.user, created: res.data.created };
    },
    [isAllowed]
  );

  const completeMfa = useCallback(
    async (preAuthToken, code) => {
      const res = await mfaApi.validate({ preAuthToken, code });
      if (!isAllowed(res.data.user)) {
        const error = new Error('This account does not have access to this application.');
        error.forbiddenRole = true;
        throw error;
      }
      setToken(res.data.token);
      setUser(res.data.user);
      return res.data.user;
    },
    [isAllowed]
  );

  /**
   * The six digits emailed by `login`, exchanged for a session.
   *
   * `rememberDevice` is the box on the code screen. The token that comes back
   * with it is stored only after the role check passes, on the same reasoning
   * that keeps the session token unstored: an account this app refuses should
   * leave nothing at all behind on the device.
   */
  const completeLoginCode = useCallback(
    async (preAuthToken, code, rememberDevice = false) => {
      const res = await authApi.verifyLoginCode({ preAuthToken, code, rememberDevice });
      if (!isAllowed(res.data.user)) {
        const error = new Error('This account does not have access to this application.');
        error.forbiddenRole = true;
        throw error;
      }
      if (res.data.trustedDeviceToken) setTrustedDeviceToken(res.data.trustedDeviceToken);
      setToken(res.data.token);
      setUser(res.data.user);
      return res.data.user;
    },
    [isAllowed]
  );

  /**
   * Another sign-in code for the same challenge. Returns the API's body so the
   * screen can report an undelivered one rather than promising a message that
   * never left.
   */
  const resendLoginCode = useCallback(
    (preAuthToken) => authApi.resendLoginCode({ preAuthToken }).then((res) => res.data),
    []
  );

  const register = useCallback(async (name, email, password) => {
    // No token yet — the address has to be verified first.
    const res = await authApi.register({ name, email, password });
    return res.data;
  }, []);

  /**
   * Ask for an SMS code. No token yet, by the same logic as `register`: the
   * number is a claim until a code sent to it comes back.
   *
   * Returns the API's body unchanged so the caller can see `smsDelivered` and
   * say so, rather than showing a "check your phone" screen for a message that
   * a deployment with no SMS credentials never sent.
   */
  const requestPhoneCode = useCallback(
    (phone, { mode, name } = {}) => authApi.requestPhoneCode({ phone, mode, name }).then((res) => res.data),
    []
  );

  /**
   * Present the code. Same contract as `login` — an account with MFA on gets a
   * challenge rather than a session, and the role check applies identically, so
   * a parent cannot reach the staff console by arriving through SMS.
   */
  const loginWithPhone = useCallback(
    async (phone, code) => {
      const res = await authApi.verifyPhoneCode({ phone, code });
      if (res.data.mfaRequired) return { mfaRequired: true, preAuthToken: res.data.preAuthToken };

      if (!isAllowed(res.data.user)) {
        const error = new Error('This account does not have access to this application.');
        error.forbiddenRole = true;
        throw error;
      }
      setToken(res.data.token);
      setUser(res.data.user);
      return { mfaRequired: false, user: res.data.user };
    },
    [isAllowed]
  );

  const verifyEmail = useCallback(async (email, code) => {
    const res = await authApi.verifyEmail({ email, code });
    setToken(res.data.token);
    setUser(res.data.user);
    return res.data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* best effort — the local session is cleared either way */
    }
    clearToken();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({
      user, setUser, loading, login, loginWithGoogle, completeMfa, completeLoginCode,
      resendLoginCode, register, verifyEmail, requestPhoneCode, loginWithPhone, logout,
    }),
    [user, loading, login, loginWithGoogle, completeMfa, completeLoginCode, resendLoginCode,
      register, verifyEmail, requestPhoneCode, loginWithPhone, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an <AuthProvider>');
  return ctx;
};
