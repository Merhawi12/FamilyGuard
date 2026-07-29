import { createContext, useContext, useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from '../auth/AuthContext.jsx';
import { getToken } from '../api/client.js';
import { SOCKET_URL } from '../config.js';

const SocketContext = createContext(null);

export const SocketProvider = ({ children }) => {
  const { user } = useAuth();
  const socketRef = useRef(null);
  // Stateful as well as ref'd so consumers re-render once the socket exists.
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const [messages, setMessages] = useState([]);

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
    s.on('alert:new', (alert) => setAlerts((prev) => [alert, ...prev]));
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

  const value = useMemo(
    () => ({ socket, connected, emit, alerts, setAlerts, messages, setMessages }),
    [socket, connected, emit, alerts, messages]
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
};

export const useSocket = () => {
  const ctx = useContext(SocketContext);
  if (!ctx) throw new Error('useSocket must be used inside a <SocketProvider>');
  return ctx;
};
