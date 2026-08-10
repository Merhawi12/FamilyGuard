import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useBodyScrollLock } from '@parentix/shared';
import Sidebar from './Sidebar.jsx';
import Topbar from './Topbar.jsx';
import usePersistentState from '../hooks/usePersistentState';
import useMediaQuery from '../hooks/useMediaQuery';

/**
 * The console shell: a navy rail, a header that names the screen, and the
 * screen itself on a light working surface.
 *
 * The rail is a drawer below `lg` and permanent above it, and above `lg` it can
 * be collapsed to icon width — a preference that is remembered, because an
 * operator who works in the tables all day wants the width back and should not
 * have to reclaim it on every visit.
 *
 * The document scrolls, not an inner pane. A `h-screen`/`overflow-hidden` shell
 * looks identical on a desktop and stops a mobile browser collapsing its URL
 * bar, which costs a phone ~10% of its screen on every screen.
 */
export default function AdminLayout() {
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = usePersistentState('px_admin_rail_collapsed', false);
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const panelRef = useRef(null);
  const menuButtonRef = useRef(null);

  // Icon width is a desktop affordance; on a phone the drawer is the collapse.
  const railed = isDesktop && collapsed;

  useBodyScrollLock(menuOpen);

  // Follow a link and the drawer has done its job.
  useEffect(() => { setMenuOpen(false); }, [pathname]);

  /** Dismissed rather than navigated — put the keyboard back where it was. */
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    menuButtonRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKeyDown = (e) => { if (e.key === 'Escape') closeMenu(); };
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus({ preventScroll: true });
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen, closeMenu]);

  return (
    <div className="min-h-dvh bg-canvas lg:flex">
      <a
        href="#console-main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60]
                   focus:px-4 focus:py-2.5 focus:rounded-xl focus:bg-white focus:shadow-pop
                   focus:text-sm focus:font-semibold focus:text-gray-900"
      >
        Skip to content
      </a>

      <div
        className={`fixed inset-0 z-40 bg-navy-950/60 backdrop-blur-[2px] lg:hidden
                    transition-opacity duration-300
                    ${menuOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={closeMenu}
        aria-hidden="true"
      />

      <Sidebar
        open={menuOpen}
        onClose={closeMenu}
        railed={railed}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        panelRef={panelRef}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <Topbar menuOpen={menuOpen} onOpenMenu={() => setMenuOpen(true)} menuButtonRef={menuButtonRef} />

        <main id="console-main" className="flex-1 p-4 sm:p-6 lg:p-8">
          <div className="mx-auto w-full max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
