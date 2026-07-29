import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '@parentix/shared';

const NAV = [
  { to: '/', label: 'Overview', icon: '📊', end: true },
  { to: '/users', label: 'Users', icon: '👥' },
  { to: '/sessions', label: 'Sessions', icon: '🔐' },
  { to: '/billing', label: 'Billing', icon: '💳' },
  { to: '/notifications', label: 'Notifications', icon: '🔔' },
  { to: '/settings', label: 'Settings', icon: '⚙️' },
  { to: '/audit-logs', label: 'Audit Logs', icon: '📋' },
];

const linkClass = ({ isActive }) =>
  `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition ${
    isActive ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'
  }`;

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  const nav = (
    <nav className="space-y-1">
      {NAV.map(({ to, label, icon, end }) => (
        <NavLink key={to} to={to} end={end} className={linkClass} onClick={() => setMenuOpen(false)}>
          <span aria-hidden="true">{icon}</span>
          {label}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      <header className="lg:hidden flex items-center justify-between bg-white border-b border-gray-200 px-4 py-3">
        <span className="font-bold text-gray-900">Parentix Admin</span>
        <button className="btn-ghost px-3 py-1" onClick={() => setMenuOpen((open) => !open)}>
          {menuOpen ? '✕' : '☰'}
        </button>
      </header>

      <aside
        className={`${menuOpen ? 'block' : 'hidden'} lg:block lg:w-64 shrink-0 bg-white border-r border-gray-200 p-4`}
      >
        <div className="hidden lg:flex items-center gap-2 px-2 pb-6">
          <img src="/logo.png" alt="" className="w-8 h-8 rounded-lg" />
          <div>
            <p className="font-bold text-gray-900 leading-tight">Parentix</p>
            <p className="text-xs text-gray-400 leading-tight">Admin console</p>
          </div>
        </div>

        {nav}

        <div className="mt-6 pt-4 border-t border-gray-100">
          <p className="px-3 text-sm font-medium text-gray-900 truncate">{user?.name}</p>
          <p className="px-3 text-xs text-gray-400 capitalize">{user?.role}</p>
          <button onClick={logout} className="btn-ghost w-full text-left mt-2 px-3">
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 p-4 md:p-8 max-w-full overflow-x-hidden">
        <Outlet />
      </main>
    </div>
  );
}
