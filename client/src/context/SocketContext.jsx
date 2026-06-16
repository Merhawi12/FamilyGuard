import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './AuthContext';

const SocketContext = createContext(null);

export const SocketProvider = ({ children }) => {
  const { user } = useAuth();
  const socketRef = useRef(null);
  const [alerts, setAlerts] = useState([]);
  const [messages, setMessages] = useState([]); // real-time chat messages

  useEffect(() => {
    if (!user) return;
    const socket = io(import.meta.env.VITE_API_URL || '/', { auth: { userId: user.id } });
    socketRef.current = socket;

    socket.emit('join:parent', user.id);

    socket.on('alert:new', (alert) => {
      setAlerts((prev) => [alert, ...prev]);
    });

    socket.on('chat:message', (msg) => {
      setMessages((prev) => [...prev, msg]);
    });

    return () => socket.disconnect();
  }, [user]);

  const emit = (event, data) => socketRef.current?.emit(event, data);

  return (
    <SocketContext.Provider value={{ socket: socketRef.current, emit, alerts, setAlerts, messages, setMessages }}>
      {children}
    </SocketContext.Provider>
  );
};

export const useSocket = () => useContext(SocketContext);
