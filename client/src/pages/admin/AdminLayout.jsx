import { NavLink, Outlet } from 'react-router-dom';

const TABS = [
  { to: '/dashboard/admin', label: 'Overview', end: true },
  { to: '/dashboard/admin/users', label: 'Users' },
  { to: '/dashboard/admin/sessions', label: 'Sessions' },
  { to: '/dashboard/admin/billing', label: 'Billing' },
  { to: '/dashboard/admin/notifications', label: 'Notifications' },
  { to: '/dashboard/admin/settings', label: 'Settings' },
  { to: '/dashboard/admin/audit-logs', label: 'Audit Logs' },
];

export default function AdminLayout() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Admin Panel</h1>
        <p className="text-gray-500 text-sm mt-1">Full platform management — users, billing, settings, and security</p>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-gray-200 -mb-px">
        {TABS.map(({ to, label, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition ${
                isActive ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`
            }
          >
            {label}
          </NavLink>
        ))}
      </div>

      <Outlet />
    </div>
  );
}
