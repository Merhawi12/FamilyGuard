import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';

const baseLinks = [
  { to: '/dashboard', label: 'Dashboard', icon: '🏠' },
  { to: '/dashboard/children', label: 'Children', icon: '👨‍👩‍👧' },
  { to: '/dashboard/location', label: 'Location', icon: '📍' },
  { to: '/dashboard/screen-time', label: 'Screen Time', icon: '⏱️' },
  { to: '/dashboard/blocking', label: 'App Blocking', icon: '🚫' },
  { to: '/dashboard/activity', label: 'Activity Log', icon: '📊' },
  { to: '/dashboard/messages', label: 'Messages', icon: '💬' },
  { to: '/dashboard/alerts', label: 'Alerts', icon: '🔔' },
  { to: '/dashboard/reports', label: 'Reports', icon: '📈' },
  { to: '/dashboard/settings', label: 'Settings', icon: '⚙️' },
];

export default function Sidebar({ open, onClose }) {
  const { user, logout } = useAuth();
  const { alerts, messages } = useSocket();
  const unreadAlerts = alerts.filter((a) => !a.isRead).length;
  const unreadMessages = messages.filter((m) => m.senderRole === 'child').length;
  const links = user?.role === 'admin'
    ? [...baseLinks, { to: '/dashboard/admin', label: 'Admin Panel', icon: '🛡️' }]
    : baseLinks;

  return (
    <aside
      className={`
        fixed md:static inset-y-0 left-0 z-30
        w-64 bg-white border-r border-gray-100 flex flex-col h-screen
        transition-transform duration-300 ease-in-out
        ${open ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}
    >
      {/* Logo */}
      <div className="p-4 border-b border-gray-100 flex items-center justify-between">
        <NavLink to="/" onClick={onClose}>
          <img src="/logo.png" alt="FamilyGuard" className="h-14 w-auto mx-auto" />
        </NavLink>
        {/* Close button — mobile only */}
        <button
          onClick={onClose}
          className="md:hidden text-gray-400 hover:text-gray-600 text-xl leading-none"
          aria-label="Close menu"
        >
          ✕
        </button>
      </div>

      {/* Nav links */}
      <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
        {links.map(({ to, label, icon }) => {
          const badge = to === '/dashboard/alerts' ? unreadAlerts
            : to === '/dashboard/messages' ? unreadMessages
            : 0;
          return (
            <NavLink
              key={to}
              to={to}
              end={to === '/dashboard'}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition ${
                  isActive ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-50'
                }`
              }
            >
              <span className="text-lg">{icon}</span>
              <span className="flex-1">{label}</span>
              {badge > 0 && (
                <span className="w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center shrink-0">
                  {badge > 9 ? '9+' : badge}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* User footer */}
      <div className="p-4 border-t border-gray-100">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0">
            {user?.name?.[0]?.toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{user?.name}</p>
            <p className="text-xs text-gray-400 capitalize">{user?.plan} plan</p>
          </div>
        </div>
        <button onClick={logout} className="btn-ghost w-full text-sm text-left">Sign out</button>
      </div>
    </aside>
  );
}
