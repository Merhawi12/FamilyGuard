import { useEffect, useState } from 'react';
import { alerts as alertsApi } from '../services/api';
import { useSocket } from '../context/SocketContext';

const SEVERITY_CONFIG = {
  high:   { dot: 'bg-red-500',    badge: 'bg-red-100 text-red-700',    icon: '🔴', label: 'High' },
  medium: { dot: 'bg-yellow-500', badge: 'bg-yellow-100 text-yellow-700', icon: '🟡', label: 'Medium' },
  low:    { dot: 'bg-green-500',  badge: 'bg-green-100 text-green-700', icon: '🟢', label: 'Low' },
};

const TYPE_LABELS = {
  entered_safe_zone: 'Entered Safe Zone',
  left_safe_zone:    'Left Safe Zone',
  screen_time_limit: 'Screen Time Limit',
  blocked_app:       'Blocked App',
  blocked_website:   'Blocked Website',
  location_update:   'Location Update',
};

export default function Alerts() {
  const [alertList, setAlertList] = useState([]);
  const [filter, setFilter] = useState('all'); // all | unread | high | medium | low
  const [loading, setLoading] = useState(true);
  const { alerts: socketAlerts, setAlerts: setSocketAlerts } = useSocket();

  useEffect(() => {
    alertsApi.list().then((r) => setAlertList(r.data)).finally(() => setLoading(false));
  }, []);

  // Prepend real-time alerts from socket
  useEffect(() => {
    if (socketAlerts.length === 0) return;
    setAlertList((prev) => {
      const ids = new Set(prev.map((a) => a.id));
      const newOnes = socketAlerts.filter((a) => !ids.has(a.id));
      return newOnes.length ? [...newOnes, ...prev] : prev;
    });
  }, [socketAlerts]);

  const markRead = async (id) => {
    await alertsApi.markRead(id);
    setAlertList((prev) => prev.map((a) => a.id === id ? { ...a, isRead: true } : a));
  };

  const markAllRead = async () => {
    await alertsApi.markAllRead();
    setAlertList((prev) => prev.map((a) => ({ ...a, isRead: true })));
    setSocketAlerts([]);
  };

  const filtered = alertList.filter((a) => {
    if (filter === 'unread') return !a.isRead;
    if (filter === 'high' || filter === 'medium' || filter === 'low') return a.severity === filter;
    return true;
  });

  const unreadCount = alertList.filter((a) => !a.isRead).length;

  if (loading) return <div className="text-gray-400 text-sm p-4">Loading...</div>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-gray-900">Alerts</h1>
          <p className="text-gray-500 text-sm mt-1">
            {unreadCount > 0 ? `${unreadCount} unread alert${unreadCount !== 1 ? 's' : ''}` : 'All caught up'}
          </p>
        </div>
        {unreadCount > 0 && (
          <button onClick={markAllRead} className="btn-ghost text-sm shrink-0">
            Mark all as read
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {[
          { key: 'all',    label: 'All' },
          { key: 'unread', label: `Unread${unreadCount ? ` (${unreadCount})` : ''}` },
          { key: 'high',   label: '🔴 High' },
          { key: 'medium', label: '🟡 Medium' },
          { key: 'low',    label: '🟢 Low' },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-3 py-1.5 rounded-xl text-sm font-medium transition ${
              filter === key
                ? 'bg-blue-600 text-white'
                : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Alert list */}
      {filtered.length === 0 ? (
        <div className="card text-center py-16">
          <span className="text-5xl">🔔</span>
          <h2 className="text-lg font-semibold mt-4 mb-1">No alerts</h2>
          <p className="text-gray-400 text-sm">
            {filter === 'unread' ? "You're all caught up!" : 'No alerts match this filter.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((alert) => {
            const sev = SEVERITY_CONFIG[alert.severity] || SEVERITY_CONFIG.low;
            return (
              <div
                key={alert.id}
                className={`card flex items-start gap-3 transition ${!alert.isRead ? 'bg-blue-50 border-blue-100' : ''}`}
              >
                {/* Unread dot */}
                <div className="shrink-0 mt-1">
                  {!alert.isRead
                    ? <span className={`block w-2.5 h-2.5 rounded-full ${sev.dot}`} />
                    : <span className="block w-2.5 h-2.5 rounded-full bg-gray-200" />}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${sev.badge}`}>
                      {sev.label}
                    </span>
                    {alert.type && (
                      <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                        {TYPE_LABELS[alert.type] || alert.type}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-800">{alert.message}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {new Date(alert.createdAt).toLocaleString()}
                  </p>
                </div>

                {!alert.isRead && (
                  <button
                    onClick={() => markRead(alert.id)}
                    className="shrink-0 text-xs text-blue-600 hover:underline"
                  >
                    Mark read
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
