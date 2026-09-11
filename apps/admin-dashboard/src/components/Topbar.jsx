import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Icon, Modal } from '@parentix/shared';
import { titleForPath } from '../navigation';
import ConsoleSearch from './ConsoleSearch.jsx';
import AccountMenu from './AccountMenu.jsx';
import NotificationsBell from './NotificationsBell.jsx';

/**
 * The console header: where you are on the left, what you can do about it on
 * the right.
 *
 * The heading lives here rather than on each screen, so every page is announced
 * the same way and no screen can forget to title itself. The search field is
 * the header's own control — it is the width the phone cannot spare, so below
 * `md` it folds into a button that opens the same search as a sheet.
 */
export default function Topbar({ menuOpen, onOpenMenu, menuButtonRef }) {
  const { pathname } = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  const title = titleForPath(pathname);

  useEffect(() => { setSearchOpen(false); }, [pathname]);

  // ⌘K / Ctrl-K reaches the field wherever it currently lives.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      const bar = document.getElementById('console-search');
      if (bar && bar.offsetParent !== null) bar.focus();
      else setSearchOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-gray-200/70 bg-white/95 backdrop-blur-md">
        <div className="flex items-center gap-1.5 sm:gap-3 h-16 px-2 sm:px-5 lg:px-8">
          <button
            ref={menuButtonRef}
            type="button"
            onClick={onOpenMenu}
            className="icon-btn lg:hidden"
            aria-label="Open menu"
            aria-expanded={menuOpen}
          >
            <Icon name="menu" size={22} />
          </button>

          <div className="min-w-0 flex-1 px-1">
            <p className="hidden sm:flex items-center gap-1 text-[11px] font-medium text-gray-400 leading-none mb-1">
              <span>Console</span>
              <Icon name="chevronRight" size={11} strokeWidth={2.5} />
              <span className="text-gray-500 truncate">{title}</span>
            </p>
            <h1 className="truncate text-[17px] sm:text-lg font-bold tracking-tight text-gray-900 leading-tight">
              {title}
            </h1>
          </div>

          <ConsoleSearch className="hidden md:block w-52 lg:w-72 xl:w-80 shrink-0" />

          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="icon-btn md:hidden"
            aria-label="Search the console"
          >
            <Icon name="search" size={20} />
          </button>

          {/* An inbox, not an outbox.
              This was a link to the screen where staff *compose* notifications,
              gated on being allowed to compose them — so the control shaped like
              a bell opened a send form, and the notices the platform writes to
              its own operators (a subscription bought, a card declined) had
              nowhere to arrive. Every staff account can receive one, so every
              staff account gets the bell; the send screen is a footer link
              inside it for the accounts that can use it. */}
          <NotificationsBell />

          <AccountMenu />
        </div>
      </header>

      <Modal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        title="Go to screen"
        description="Every console screen your account can open."
      >
        <ConsoleSearch
          variant="sheet"
          id="console-search-sheet"
          onDone={() => setSearchOpen(false)}
        />
      </Modal>
    </>
  );
}
