import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Avatar, Icon, useAuth, roleLabel, hasPermission, PERMISSIONS,
} from '@parentix/shared';

/**
 * The signed-in staff member, top right.
 *
 * The rail carries the same account block, but the rail can be collapsed or
 * closed — this is the one control that is on every screen at every width, so
 * signing out never depends on finding the menu first.
 */
export default function AccountMenu() {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus({ preventScroll: true });
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...(menuRef.current?.querySelectorAll('[role="menuitem"]') || [])];
      if (!items.length) return;
      e.preventDefault();
      const here = items.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown'
        ? (here + 1) % items.length
        : (here - 1 + items.length) % items.length;
      items[next].focus();
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    menuRef.current?.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className={`flex items-center gap-2 h-11 pl-1 pr-1.5 sm:pr-2 rounded-xl transition-colors
                    ${open ? 'bg-gray-100' : 'hover:bg-gray-100 active:bg-gray-200'}`}
      >
        <Avatar name={user?.name} size="sm" />
        <span className="hidden xl:block max-w-[9rem] truncate text-sm font-semibold text-gray-800">
          {user?.name}
        </span>
        <Icon
          name="chevronDown"
          size={15}
          strokeWidth={2.4}
          className={`text-gray-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Account"
          className="absolute right-0 top-full mt-2 w-64 z-50 origin-top-right p-1.5
                     rounded-2xl border border-gray-100 bg-white shadow-pop animate-scale-in"
        >
          <div className="flex items-center gap-3 px-2.5 py-2.5 mb-1 border-b border-gray-100">
            <Avatar name={user?.name} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-gray-900 leading-tight">{user?.name}</p>
              <p className="truncate text-xs text-gray-400 leading-tight mt-0.5">{user?.email}</p>
            </div>
          </div>
          <p className="px-2.5 pb-2">
            <span className="badge-blue">{roleLabel(user?.role)}</span>
          </p>

          <Link to="/profile" role="menuitem" className="menu-item">
            <Icon name="user" size={18} className="text-gray-400" />
            My Profile
          </Link>

          {hasPermission(user, PERMISSIONS.MANAGE_SETTINGS) && (
            <Link to="/settings" role="menuitem" className="menu-item">
              <Icon name="settings" size={18} className="text-gray-400" />
              Settings
            </Link>
          )}

          <button type="button" role="menuitem" onClick={logout} className="menu-item text-red-600 hover:bg-red-50">
            <Icon name="logout" size={18} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
