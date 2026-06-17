import { createContext, useContext, useState, useEffect } from 'react';
import { auth as authApi } from '../services/api';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('fg_token');
    if (token) {
      authApi.me()
        .then((res) => setUser(res.data))
        .catch(() => localStorage.removeItem('fg_token'))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email, password) => {
    const res = await authApi.login({ email, password });
    localStorage.setItem('fg_token', res.data.token);
    setUser(res.data.user);
  };

  const register = async (name, email, password) => {
    const res = await authApi.register({ name, email, password });
    return res.data; // { message, email } — no token yet, email must be verified first
  };

  const verifyEmail = async (email, code) => {
    const res = await authApi.verifyEmail({ email, code });
    localStorage.setItem('fg_token', res.data.token);
    setUser(res.data.user);
  };

  const logout = async () => {
    try { await authApi.logout(); } catch { /* best effort */ }
    localStorage.removeItem('fg_token');
    setUser(null);
  };

  return <AuthContext.Provider value={{ user, loading, login, register, verifyEmail, logout }}>{children}</AuthContext.Provider>;
};

export const useAuth = () => useContext(AuthContext);
