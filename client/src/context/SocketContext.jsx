import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './AuthContext';

const SocketContext = createContext(null);

export const SocketProvider = ({ children }) => {
  const { user } = useAuth();
  const socketRef = useRef(null);
  const [socket, setSocket] = useState(null); // stateful so consumers re-render when it connects
  const [alerts, setAlerts] = useState([]);
  const [messages, setMessages] = useState([]); // real-time chat messages

  useEffect(() => {
    if (!user) return;
    const token = localStorage.getItem('fg_token');
    if (!token) return;
    // Authenticate the socket handshake with the JWT — the server derives the
    // parent identity from the token and ignores any client-supplied ids.
    const s = io(import.meta.env.VITE_API_URL || '/', { auth: { token } });
    socketRef.current = s;
    setSocket(s);

    s.on('alert:new', (alert) => {
      setAlerts((prev) => [alert, ...prev]);
    });

    s.on('chat:message', (msg) => {
      setMessages((prev) => [...prev, msg]);
    });

    return () => {
      s.disconnect();
      socketRef.current = null;
      setSocket(null);
    };
  }, [user]);

  const emit = (event, data) => socketRef.current?.emit(event, data);

  return (
    <SocketContext.Provider value={{ socket, emit, alerts, setAlerts, messages, setMessages }}>
      {children}
    </SocketContext.Provider>
  );
};

export const useSocket = () => useContext(SocketContext);
