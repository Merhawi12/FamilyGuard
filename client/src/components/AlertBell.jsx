import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSocket } from '../context/SocketContext';

export default function AlertBell() {
  const { alerts, setAlerts } = useSocket();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const unread = alerts.filter((a) => !a.isRead).length;

  const markRead = (id) => {
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, isRead: true } : a)));
  };

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="relative p-2 rounded-xl hover:bg-gray-100 transition">
        <span className="text-xl">🔔</span>
        {unread > 0 && (
          <span className="absolute top-1 right-1 w-4 h-4 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-12 w-80 bg-white rounded-2xl shadow-lg border border-gray-100 z-50">
          <div className="p-4 border-b border-gray-100 flex justify-between items-center">
            <span className="font-semibold">Alerts</span>
            <div className="flex gap-3">
              <button onClick={() => { setOpen(false); navigate('/dashboard/alerts'); }} className="text-xs text-blue-500 hover:underline">View all</button>
              <button onClick={() => setAlerts([])} className="text-xs text-gray-400 hover:underline">Clear</button>
            </div>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {alerts.length === 0 ? (
              <p className="text-center text-gray-400 py-8 text-sm">No alerts</p>
            ) : (
              alerts.map((a) => (
                <div
                  key={a.id}
                  onClick={() => markRead(a.id)}
                  className={`p-4 border-b border-gray-50 cursor-pointer hover:bg-gray-50 ${!a.isRead ? 'bg-blue-50' : ''}`}
                >
                  <p className="text-sm font-medium">{a.message}</p>
                  <p className="text-xs text-gray-400 mt-1">{new Date(a.createdAt).toLocaleString()}</p>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
