import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { auth as authApi, mfa as mfaApi } from '../api/endpoints.js';
import { getToken, setToken, clearToken } from '../api/client.js';

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
   * Resolves to `{ mfaRequired: true, preAuthToken }` when the account has MFA on;
   * the caller then finishes with `completeMfa`.
   */
  const login = useCallback(
    async (email, password) => {
      const res = await authApi.login({ email, password });
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
      user, setUser, loading, login, loginWithGoogle, completeMfa, register, verifyEmail,
      requestPhoneCode, loginWithPhone, logout,
    }),
    [user, loading, login, loginWithGoogle, completeMfa, register, verifyEmail,
      requestPhoneCode, loginWithPhone, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an <AuthProvider>');
  return ctx;
};
