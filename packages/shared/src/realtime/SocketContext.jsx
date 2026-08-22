import { createContext, useContext, useEffect, useRef, useState, useMemo, useCallback } from 'react';
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

  /**
   * The connection, and the library that makes it.
   *
   * socket.io-client is imported here rather than at the top of the file, and
   * that placement is the point: it is ~40 kB of transports, parsers and
   * reconnection logic, and a static import put all of it in the Family App's
   * entry chunk — downloaded and parsed by every visitor arriving at /login, to
   * open a connection that cannot exist until they have signed in. This effect
   * is the only code in the package that touches it, and it returns early
   * without a session, so the fetch happens exactly when the socket is about to
   * be opened and never before. (The Admin Dashboard imports the barrel this
   * provider sits in but has no realtime feature at all; tree-shaking now drops
   * the module there entirely.)
   *
   * Everything after the `await` is guarded by `cancelled`, because an effect
   * can be torn down while the chunk is still in flight — a sign-out, or React
   * Strict Mode's double-invoke in development. Without that guard the late
   * arrival would open a socket nothing holds a reference to and never close it.
   */
  useEffect(() => {
    if (!user) return undefined;
    const token = getToken();
    if (!token) return undefined;

    let cancelled = false;
    let socketInstance = null;

    import('socket.io-client')
      .then(({ io }) => {
        if (cancelled) return;

        // The server derives identity from this JWT and ignores any
        // client-supplied ids, so room membership cannot be spoofed from the
        // browser.
        const s = io(SOCKET_URL, {
          auth: { token },
          transports: ['websocket', 'polling'],
          reconnectionAttempts: 10,
          reconnectionDelay: 1000,
        });

        socketInstance = s;
        socketRef.current = s;
        setSocket(s);

        s.on('connect', () => setConnected(true));
        s.on('disconnect', () => setConnected(false));
        s.on('connect_error', (err) => console.warn('[socket] connect error:', err.message));
        // Guard against a duplicate: a reconnect can re-deliver an alert the
        // initial load already put in the list.
        s.on('alert:new', (alert) =>
          setAlerts((prev) => (prev.some((a) => a.id === alert.id) ? prev : [alert, ...prev]))
        );
        s.on('chat:message', (msg) => setMessages((prev) => [...prev, msg]));
      })
      .catch((err) => {
        // A chunk that will not load is a broken deploy, not a dead session, so
        // it must not sign anyone out. The alert history above is fetched over
        // HTTP and still renders; only live delivery is lost.
        if (!cancelled) console.warn('[socket] could not load the realtime client:', err.message);
      });

    return () => {
      cancelled = true;
      if (socketInstance) {
        socketInstance.removeAllListeners();
        socketInstance.disconnect();
      }
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

  /**
   * Deleting lives here for the same reason marking read does: this list is also
   * the header bell's list. A page that removed a row from its own copy would
   * leave the bell counting an alert nobody can reach any more.
   *
   * Optimistic, and put back on failure — but note the asymmetry with marking
   * read. A row that reappears is a visible, correctable surprise; a row that
   * vanished from the screen while still existing on the server is one a parent
   * has no way to notice at all. So the restore matters more here, and the
   * caller is given the error to show rather than it being swallowed.
   */
  const deleteAlert = useCallback(async (id) => {
    const previous = alerts;
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    try {
      await alertsApi.remove(id);
    } catch (err) {
      setAlerts(previous);
      throw err;
    }
  }, [alerts]);

  /**
   * Clear in bulk, narrowed by the same filter the screen is showing.
   *
   * Not optimistic: the server decides what matched, and the count it returns is
   * the honest answer — this list holds at most 50 rows and the account may own
   * many more, so guessing from what is loaded would under-report every time.
   * The reload is what makes the bell agree.
   */
  const clearAlerts = useCallback(async (params) => {
    const { data } = await alertsApi.clear(params);
    reloadAlerts();
    return data?.deleted ?? 0;
  }, [reloadAlerts]);

  const value = useMemo(
    () => ({
      socket, connected, emit,
      alerts, alertsLoading, alertsError, reloadAlerts,
      setAlerts, markAlertRead, markAllAlertsRead, deleteAlert, clearAlerts,
      messages, setMessages,
    }),
    [
      socket, connected, emit, alerts, alertsLoading, alertsError, reloadAlerts,
      markAlertRead, markAllAlertsRead, deleteAlert, clearAlerts, messages,
    ]
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
};

export const useSocket = () => {
  const ctx = useContext(SocketContext);
  if (!ctx) throw new Error('useSocket must be used inside a <SocketProvider>');
  return ctx;
};
