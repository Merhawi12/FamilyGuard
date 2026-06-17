import { useEffect, useState } from 'react';
import { notifications as notificationsApi } from '../services/api';

const TYPE_COLORS = {
  info: 'border-blue-400',
  warning: 'border-orange-400',
  success: 'border-green-400',
};

export default function NotificationBell() {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);

  const load = () => notificationsApi.list().then((r) => setItems(r.data)).catch(() => {});

  useEffect(() => {
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, []);

  const unread = items.filter((n) => !n.isRead).length;

  const markRead = async (id) => {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    notificationsApi.markRead(id).catch(() => {});
  };

  const markAllRead = async () => {
    setItems((prev) => prev.map((n) => ({ ...n, isRead: true })));
    notificationsApi.markAllRead().catch(() => {});
  };

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="relative p-2 rounded-xl hover:bg-gray-100 transition">
        <span className="text-xl">📩</span>
        {unread > 0 && (
          <span className="absolute top-1 right-1 w-4 h-4 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-12 w-80 bg-white rounded-2xl shadow-lg border border-gray-100 z-50">
          <div className="p-4 border-b border-gray-100 flex justify-between items-center">
            <span className="font-semibold">Notifications</span>
            <button onClick={markAllRead} className="text-xs text-blue-500 hover:underline">Mark all read</button>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {items.length === 0 ? (
              <p className="text-center text-gray-400 py-8 text-sm">No notifications</p>
            ) : (
              items.map((n) => (
                <div
                  key={n.id}
                  onClick={() => markRead(n.id)}
                  className={`p-4 border-b border-gray-50 border-l-4 ${TYPE_COLORS[n.type] || TYPE_COLORS.info} cursor-pointer hover:bg-gray-50 ${!n.isRead ? 'bg-blue-50' : ''}`}
                >
                  <p className="text-sm font-medium">{n.title}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{n.message}</p>
                  <p className="text-xs text-gray-400 mt-1">{new Date(n.createdAt).toLocaleString()}</p>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
