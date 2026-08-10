import { createContext, useContext, useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from '../auth/AuthContext.jsx';
import { getToken, errorMessage } from '../api/client.js';
import { alerts as alertsApi } from '../api/endpoints.js';
import { SOCKET_URL } from '../config.js';

const SocketContext = createContext(null);

export const SocketProvider = ({ children }) => {
  const { user } = useAuth();
  const socketRef = useRef(null);
  // Stateful as well as ref'd so consumers re-render once the socket exists.
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [alertsError, setAlertsError] = useState('');
  const [alertReloads, setAlertReloads] = useState(0);
  const [messages, setMessages] = useState([]);

  /** Retry the history load after a failure. */
  const reloadAlerts = useCallback(() => setAlertReloads((n) => n + 1), []);

  /**
   * Alerts that already existed are loaded once on sign-in.
   *
   * Without this the list only ever held what arrived over the socket during the
   * current page view, so a parent who opened the dashboard after an emergency
   * had been raised saw an empty bell and no unread badge — exactly the case
   * where the alert matters most.
   *
   * A failure is recorded rather than swallowed. The list is empty either way,
   * and an empty alert list renders as "No alerts — you are all caught up":
   * of all the screens in this product, it is the one where a request failure
   * must never be shown as reassurance.
   */
  useEffect(() => {
    if (!user) {
      setAlerts([]);
      setAlertsError('');
      setAlertsLoading(false);
      return undefined;
    }
    let cancelled = false;
    setAlertsLoading(true);
    alertsApi
      .list()
      .then((res) => {
        if (cancelled) return;
        setAlerts(Array.isArray(res.data) ? res.data : []);
        setAlertsError('');
      })
      .catch((err) => {
        // Anything arriving live is still appended by the socket below.
        if (!cancelled) setAlertsError(errorMessage(err, 'Could not load your alerts.'));
      })
      .finally(() => {
        if (!cancelled) setAlertsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, alertReloads]);

  useEffect(() => {
    if (!user) return undefined;
    const token = getToken();
    if (!token) return undefined;

    // The server derives identity from this JWT and ignores any client-supplied
    // ids, so room membership cannot be spoofed from the browser.
    const s = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    socketRef.current = s;
    setSocket(s);

    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    s.on('connect_error', (err) => console.warn('[socket] connect error:', err.message));
    // Guard against a duplicate: a reconnect can re-deliver an alert the initial
    // load already put in the list.
    s.on('alert:new', (alert) =>
      setAlerts((prev) => (prev.some((a) => a.id === alert.id) ? prev : [alert, ...prev]))
    );
    s.on('chat:message', (msg) => setMessages((prev) => [...prev, msg]));

    return () => {
      s.removeAllListeners();
      s.disconnect();
      socketRef.current = null;
      setSocket(null);
      setConnected(false);
    };
  }, [user]);

  const emit = useCallback((event, data) => socketRef.current?.emit(event, data), []);

  /**
   * Marking read is persisted, not just reflected in the UI.
   *
   * The state updates first so the badge responds immediately; if the request
   * fails the flag is put back, because an alert that silently looks read is
   * worse than one that stays unread.
   */
  const markAlertRead = useCallback(async (id) => {
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, isRead: true } : a)));
    try {
      await alertsApi.markRead(id);
    } catch {
      setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, isRead: false } : a)));
    }
  }, []);

  const markAllAlertsRead = useCallback(async () => {
    const previous = alerts;
    setAlerts((prev) => prev.map((a) => ({ ...a, isRead: true })));
    try {
      await alertsApi.markAllRead();
    } catch {
      setAlerts(previous);
    }
  }, [alerts]);

  const value = useMemo(
    () => ({
      socket, connected, emit,
      alerts, alertsLoading, alertsError, reloadAlerts,
      setAlerts, markAlertRead, markAllAlertsRead,
      messages, setMessages,
    }),
    [
      socket, connected, emit, alerts, alertsLoading, alertsError, reloadAlerts,
      markAlertRead, markAllAlertsRead, messages,
    ]
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
};

export const useSocket = () => {
  const ctx = useContext(SocketContext);
  if (!ctx) throw new Error('useSocket must be used inside a <SocketProvider>');
  return ctx;
};
