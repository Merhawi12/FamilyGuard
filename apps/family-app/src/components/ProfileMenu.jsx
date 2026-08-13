import { Link } from 'react-router-dom';
import { Avatar, Icon, useAuth, useDismissable, planLabel } from '@parentix/shared';

/**
 * The account menu in the header.
 *
 * Signing out used to live only in the sidebar footer, which on a phone meant
 * opening the drawer and scrolling past fourteen links to find it. Name, plan,
 * profile, settings and sign-out are two taps from anywhere now.
 */
export default function ProfileMenu() {
  const { user, logout } = useAuth();
  const { open, setOpen, toggle, ref } = useDismissable();

  const close = () => setOpen(false);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={toggle}
        aria-label="Account menu"
        aria-expanded={open}
        aria-haspopup="menu"
        className="w-11 h-11 rounded-xl flex items-center justify-center hover:bg-gray-100 transition shrink-0"
      >
        <Avatar name={user?.name} size="sm" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[3.25rem] z-50 w-64 bg-white rounded-2xl shadow-pop
                     border border-gray-100 overflow-hidden animate-scale-in"
        >
          <div className="flex items-center gap-3 p-4 border-b border-gray-100">
            <Avatar name={user?.name} size="md" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900 truncate">{user?.name}</p>
              <p className="text-xs text-gray-500 truncate">{user?.email}</p>
              <span className="badge-primary mt-1.5">{planLabel(user?.plan)}</span>
            </div>
          </div>

          <div className="p-1.5">
            {[
              { to: '/dashboard/profile', label: 'Your profile', icon: 'user' },
              { to: '/dashboard/settings', label: 'Settings', icon: 'settings' },
            ].map(({ to, label, icon }) => (
              <Link
                key={to}
                to={to}
                role="menuitem"
                onClick={close}
                className="flex items-center gap-3 min-h-[44px] px-3 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
              >
                <Icon name={icon} size={18} className="text-gray-400" />
                {label}
              </Link>
            ))}
          </div>

          <div className="p-1.5 border-t border-gray-100">
            <button
              role="menuitem"
              onClick={() => { close(); logout(); }}
              className="w-full flex items-center gap-3 min-h-[44px] px-3 rounded-xl text-sm font-medium text-danger hover:bg-red-50 transition"
            >
              <Icon name="logout" size={18} />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
