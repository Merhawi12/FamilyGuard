import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './AuthContext';

const SocketContext = createContext(null);

export const SocketProvider = ({ children }) => {
  const { user } = useAuth();
  const socketRef = useRef(null);
  const [alerts, setAlerts] = useState([]);

  useEffect(() => {
    if (!user) return;
    const socket = io('/', { auth: { userId: user.id } });
    socketRef.current = socket;

    socket.emit('join:parent', user.id);

    socket.on('alert:new', (alert) => {
      setAlerts((prev) => [alert, ...prev]);
    });

    return () => socket.disconnect();
  }, [user]);

  const emit = (event, data) => socketRef.current?.emit(event, data);

  return (
    <SocketContext.Provider value={{ socket: socketRef.current, emit, alerts, setAlerts }}>
      {children}
    </SocketContext.Provider>
  );
};

export const useSocket = () => useContext(SocketContext);
