import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Icon, useSocket } from '@parentix/shared';
import Sidebar from './Sidebar';
import BottomNav from './BottomNav';
import NotificationsBell from './NotificationsBell';
import ProfileMenu from './ProfileMenu';
import PushBanner from './PushBanner';
import { resyncPush, startNativeHandling } from '../services/push';
import { titleForPath } from '../navigation';

/**
 * The application shell.
 *
 * The page scrolls the document rather than an inner pane. A `h-screen` shell
 * with `overflow-hidden` and a scrolling `<main>` looks identical on a desktop
 * and is wrong on a phone: the browser's URL bar only collapses when the
 * document itself scrolls, so the old layout permanently gave up ~60px of an
 * already short screen and left the content in a nested scroller that no
 * pull-to-refresh or scroll-to-top gesture could reach.
 *
 * The header owns the page title. Every screen used to repeat it as its own
 * `<h1>`, which on a phone meant the first 90px below a header that already
 * said "Parentix" were spent saying "Dashboard" again.
 */
export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  /** A push that arrived while the app was in the foreground — Android only. */
  const [notice, setNotice] = useState(null);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { alerts, messages } = useSocket();

  // Following a link inside the drawer has to close it, including when the
  // destination is the page already open.
  useEffect(() => { setMenuOpen(false); }, [pathname]);

  /**
   * A push subscription belongs to the device; the server row belongs to an
   * account. Re-registering it here — the first thing rendered after a
   * successful sign-in — is what stops a parent who signed out and back in, or
   * who signed in on a browser another family member used, from holding a live
   * subscription the server no longer associates with them. This was written
   * when push shipped and never actually called.
   *
   * `startNativeHandling` is the Android half and a no-op in a browser: it makes
   * a tapped notification open the page it refers to. Registered here rather
   * than in the settings screen because a parent taps a notification far more
   * often than they visit settings, and the listener has to already exist.
   */
  useEffect(() => {
    resyncPush();
    startNativeHandling({
      onOpen: (data) => { if (data.url) navigate(data.url); },
      // Android shows nothing for a push that lands while the app is open — see
      // PushBanner. Without this the parent least likely to be told was the one
      // holding the app.
      onForeground: setNotice,
    });
  }, [navigate]);

  const badges = {
    alerts: alerts.filter((a) => !a.isRead).length,
    messages: messages.filter((m) => m.senderRole === 'child').length,
  };

  return (
    <div className="min-h-dvh bg-gray-50 lg:flex">
      <PushBanner
        notice={notice}
        onDismiss={() => setNotice(null)}
        onOpen={() => { const { url } = notice.data; setNotice(null); if (url) navigate(url); }}
      />

      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} badges={badges} />

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-30 bg-white/90 backdrop-blur-md border-b border-gray-100">
          {/* Tracks the sidebar's header height exactly. The two bottom borders
              meet at the sidebar edge and read as a single rule, so if one grows
              the other has to. See the note in Sidebar.jsx. */}
          <div className="h-16 lg:h-20 flex items-center gap-1 px-2 sm:px-4 lg:px-8">
            <button
              onClick={() => setMenuOpen(true)}
              className="icon-btn lg:hidden"
              aria-label="Open menu"
              aria-expanded={menuOpen}
            >
              <Icon name="menu" size={22} />
            </button>

            <h1 className="flex-1 min-w-0 px-1 text-lg font-semibold text-gray-900 tracking-tight truncate">
              {titleForPath(pathname)}
            </h1>

            <NotificationsBell />
            <ProfileMenu />
          </div>
        </header>

        <main className="flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-8 pb-[calc(5.5rem+env(safe-area-inset-bottom))] lg:pb-8">
          <div className="mx-auto w-full max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>

      <BottomNav onOpenMenu={() => setMenuOpen(true)} badges={badges} />
    </div>
  );
}
