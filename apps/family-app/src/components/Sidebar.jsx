import { useEffect, useRef, useState, useCallback } from 'react';
import { NavLink } from 'react-router-dom';
import { Avatar, BrandLogo, Icon, useAuth, useBodyScrollLock, isStaff } from '@parentix/shared';
import { NAV_SECTIONS } from '../navigation';

// The staff console is a separate application; link out to it rather than
// bundling admin screens into the parent-facing app.
const ADMIN_URL = import.meta.env.VITE_ADMIN_URL || '';

const COLLAPSED_KEY = 'parentix:sidebar-collapsed';
const SECTIONS_KEY = 'parentix:sidebar-collapsed-sections';

/**
 * Reads a persisted preference without letting a bad value break the render.
 *
 * localStorage throws outright in a Safari private window and in an iframe with
 * third-party storage blocked, and the value itself is user-editable text. A
 * sidebar is not worth a white screen, so anything unexpected falls back.
 */
const readStored = (key, fallback) => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const writeStored = (key, value) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage unavailable — the preference simply does not persist */ }
};

/**
 * The main navigation: a permanent rail from `lg` up, a slide-in drawer below it.
 *
 * One component rather than two so the two never drift apart — the drawer is
 * the rail with a backdrop, a close button and a transform, not a second copy
 * of the link list.
 *
 * Two independent kinds of collapse, which is worth stating because they are
 * easily confused:
 *
 *   the rail    collapses to icons only, on desktop, and is remembered.
 *   a section   collapses its own links away, and each is remembered separately.
 *
 * Neither applies to the drawer. On a phone the sidebar is already a temporary
 * overlay you opened deliberately: an icon-only overlay would be a menu you
 * cannot read, and there is no adjacent content for it to be making room for.
 */
export default function Sidebar({ open, onClose, badges = {} }) {
  const { user, logout } = useAuth();
  const panelRef = useRef(null);

  const [collapsed, setCollapsed] = useState(() => readStored(COLLAPSED_KEY, false));
  // Which sections are *closed*, by title. Storing the closed ones means a
  // section added to `navigation.js` later starts open rather than hidden.
  const [closedSections, setClosedSections] = useState(() => {
    const stored = readStored(SECTIONS_KEY, []);
    return new Set(Array.isArray(stored) ? stored : []);
  });

  useEffect(() => { writeStored(COLLAPSED_KEY, collapsed); }, [collapsed]);
  useEffect(() => { writeStored(SECTIONS_KEY, [...closedSections]); }, [closedSections]);

  const toggleSection = useCallback((title) => {
    setClosedSections((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  }, []);

  // Only while it is a drawer; the rail must never lock the page.
  useBodyScrollLock(open);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // Separate from the listener above for the reason described in Modal: `onClose`
  // is an inline arrow at the call site, so a shared effect re-ran on every
  // render of the parent and dragged focus back to the panel each time. There
  // are no text fields in a nav drawer, so this never ate a keystroke — it
  // interrupted keyboard navigation instead, which is the same bug being quieter.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus({ preventScroll: true });
  }, [open]);

  // The drawer is always full width. `collapsed` is a desktop preference, and
  // applying it below `lg` would render an overlay of unlabelled icons.
  const railCollapsed = collapsed;

  const linkClass = ({ isActive }) =>
    `group relative flex items-center gap-3 min-h-[44px] px-3 py-2.5 rounded-xl text-sm font-medium
     outline-none transition-colors duration-150
     focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1 ${
      isActive
        ? 'bg-primary-50 text-primary-700'
        : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 active:bg-gray-100'
    } ${railCollapsed ? 'lg:justify-center lg:px-0' : ''}`;

  /**
   * The label, hidden by width rather than unmounted when the rail is collapsed.
   *
   * Removing it from the DOM would take it out of the accessibility tree too,
   * leaving a screen reader with a row of icons and no names. Collapsing it to
   * zero width keeps the accessible name intact and lets the change animate.
   */
  const label = (text) => (
    // `text-left` because a <button> is centred by default and a NavLink is not.
    // Without it "Sign out" and "Collapse" sit centred while every link above
    // them starts at the same left edge.
    <span
      className={`flex-1 truncate text-left transition-[opacity,max-width] duration-200 ${
        railCollapsed ? 'lg:opacity-0 lg:max-w-0 lg:flex-none' : 'opacity-100 max-w-full'
      }`}
    >
      {text}
    </span>
  );

  /** Only shown when collapsed, where the visible label is gone. */
  const tooltip = (text) => railCollapsed && (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-full ml-2 hidden lg:block whitespace-nowrap rounded-lg
                 bg-gray-900 px-2 py-1 text-xs font-medium text-white opacity-0 shadow-lg transition-opacity
                 group-hover:opacity-100 group-focus-visible:opacity-100 z-50"
    >
      {text}
    </span>
  );

  const countBadge = (count) => count > 0 && (
    <span
      className={`min-w-[20px] h-5 px-1.5 bg-danger text-white text-[11px] font-semibold rounded-full
                  flex items-center justify-center ${railCollapsed ? 'lg:absolute lg:top-1 lg:right-1 lg:min-w-[16px] lg:h-4 lg:px-1' : ''}`}
    >
      {count > 9 ? '9+' : count}
    </span>
  );

  return (
    <>
      {/* Backdrop — drawer only. */}
      <div
        className={`fixed inset-0 z-40 bg-gray-900/50 lg:hidden transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        ref={panelRef}
        tabIndex={-1}
        {...(open ? { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Main menu' } : {})}
        className={`fixed lg:sticky inset-y-0 left-0 top-0 z-50 lg:z-auto shrink-0 outline-none
                    w-[17rem] h-dvh flex flex-col
                    bg-white border-r border-gray-100
                    transition-[transform,width] duration-200 ease-out
                    ${open ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0
                    ${railCollapsed ? 'lg:w-[4.75rem]' : 'lg:w-64'}`}
      >
        {/*
          `lg:h-20`, and Layout's header matches it.

          The two bars sit side by side above the fold and their bottom borders
          read as one rule across the app, so the height of this one is not a
          local decision — grow it alone and the line steps down at the sidebar
          edge. Below `lg` there is no such pair: this is a drawer floating over
          the page, so it keeps the shorter header and gives the space back to
          the content on the screen that has least of it.
        */}
        <div className={`flex items-center gap-2 px-4 h-16 lg:h-20 shrink-0 border-b border-gray-100 ${
          railCollapsed ? 'lg:px-0 lg:justify-center' : 'justify-between'
        }`}
        >
          <NavLink to="/dashboard" end onClick={onClose} className="flex items-center min-w-0" aria-label="Parentix dashboard">
            {/*
              The logo is a square stacked lockup — shield over wordmark — with
              roughly a fifth of its height as transparent margin baked into the
              PNG. At `h-9` that left the word "Parentix" about six pixels tall:
              present, unreadable, and the first thing anyone sees. Height has to
              buy the whole lockup, not just the mark, which is why this is a
              large jump rather than a nudge.
            */}
            <BrandLogo className="h-12 lg:h-16 w-auto shrink-0" />
          </NavLink>
          <button onClick={onClose} className="icon-btn lg:hidden -mr-2" aria-label="Close menu">
            <Icon name="close" />
          </button>
        </div>

        {/* `space-y-1`, not the old `space-y-6`: each section now carries its own
            44px heading, which supplies the separation the gap used to. */}
        <nav className="flex-1 overflow-y-auto scroll-touch px-3 py-2 space-y-1" aria-label="Sections">
          {NAV_SECTIONS.map((section) => {
            const sectionClosed = closedSections.has(section.title);
            const panelId = `nav-section-${section.title.toLowerCase()}`;

            return (
              <div key={section.title}>
                {/*
                  A heading that is also the disclosure control. When the rail is
                  collapsed there is no room for it and nothing to label, so it
                  is hidden and the section is forced open — otherwise a section
                  someone closed at full width would silently swallow its icons.
                */}
                <button
                  type="button"
                  onClick={() => toggleSection(section.title)}
                  aria-expanded={!sectionClosed}
                  aria-controls={panelId}
                  /*
                    `min-h-[44px]` because this is a control, not a caption. It
                    used to be a `<p>`, so nothing had to be able to hit it; as
                    a disclosure button on a touch screen it needs a target of
                    the same size as every link below it. The box is 44px while
                    the text stays 11px — the target is invisible, which is why
                    the section rhythm below is tightened to pay for it.
                  */
                  className={`w-full flex items-center gap-1 min-h-[44px] px-3 rounded-lg
                              text-[11px] font-semibold uppercase tracking-wider text-gray-400
                              outline-none transition-colors hover:text-gray-600
                              focus-visible:ring-2 focus-visible:ring-primary-500
                              ${railCollapsed ? 'lg:hidden' : ''}`}
                >
                  <span className="flex-1 text-left">{section.title}</span>
                  <Icon
                    name="chevronDown"
                    size={14}
                    className={`transition-transform duration-200 ${sectionClosed ? '-rotate-90' : ''}`}
                  />
                </button>

                <div
                  id={panelId}
                  // `hidden` rather than unmounting: it keeps the links out of
                  // the tab order and out of the accessibility tree, which is
                  // exactly what a closed section should be.
                  hidden={sectionClosed && !railCollapsed}
                  className="space-y-0.5"
                >
                  {section.items.map(({ to, label: text, icon, end, badge }) => {
                    const count = badge ? badges[badge] || 0 : 0;
                    return (
                      <NavLink
                        key={to}
                        to={to}
                        end={end}
                        onClick={onClose}
                        className={linkClass}
                        title={railCollapsed ? text : undefined}
                      >
                        <Icon name={icon} className="shrink-0" />
                        {label(text)}
                        {countBadge(count)}
                        {tooltip(text)}
                      </NavLink>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {isStaff(user) && ADMIN_URL && (
            <a
              href={ADMIN_URL}
              target="_blank"
              rel="noreferrer"
              title={railCollapsed ? 'Admin Console' : undefined}
              className={`group relative flex items-center gap-3 min-h-[44px] px-3 py-2.5 rounded-xl text-sm font-medium
                          text-gray-600 outline-none transition-colors hover:bg-gray-50 hover:text-gray-900
                          focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1
                          ${railCollapsed ? 'lg:justify-center lg:px-0' : ''}`}
            >
              <Icon name="shield" className="shrink-0" />
              {label('Admin Console')}
              {!railCollapsed && <Icon name="external" size={14} className="text-gray-300" />}
              {tooltip('Admin Console')}
            </a>
          )}
        </nav>

        <div className="border-t border-gray-100 p-3 shrink-0 pb-safe space-y-1">
          <NavLink
            to="/dashboard/profile"
            onClick={onClose}
            title={railCollapsed ? user?.name : undefined}
            className={`group relative flex items-center gap-3 p-2 rounded-xl outline-none transition-colors
                        hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-primary-500
                        ${railCollapsed ? 'lg:justify-center' : ''}`}
          >
            <Avatar name={user?.name} size="sm" />
            <span
              className={`flex-1 min-w-0 transition-[opacity,max-width] duration-200 ${
                railCollapsed ? 'lg:opacity-0 lg:max-w-0 lg:flex-none lg:overflow-hidden' : 'opacity-100 max-w-full'
              }`}
            >
              <span className="block text-sm font-medium text-gray-900 truncate">{user?.name}</span>
              <span className="block text-xs text-gray-400 capitalize">{user?.plan} plan</span>
            </span>
            {!railCollapsed && <Icon name="chevronRight" size={16} className="text-gray-300" />}
            {tooltip(user?.name || 'Profile')}
          </NavLink>

          <button
            onClick={logout}
            title={railCollapsed ? 'Sign out' : undefined}
            /* Shaped like a nav row rather than `btn-block`, whose own
               `justify-center` beats a `justify-start` added alongside it —
               Tailwind resolves by stylesheet order, not class order. */
            className={`group relative flex items-center gap-3 w-full min-h-[44px] px-3 py-2.5 rounded-xl
                        text-sm font-medium text-gray-600 outline-none transition-colors
                        hover:bg-gray-50 hover:text-gray-900 active:bg-gray-100
                        focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1
                        ${railCollapsed ? 'lg:justify-center lg:px-0' : ''}`}
          >
            <Icon name="logout" size={18} className="shrink-0" />
            {label('Sign out')}
            {tooltip('Sign out')}
          </button>

          {/*
            Desktop only, and last: the control that changes the shape of the
            page belongs below the things it is changing, not above them where
            it competes with navigation for attention.
          */}
          <button
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!railCollapsed}
            aria-label={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={`hidden lg:flex items-center gap-3 w-full min-h-[40px] px-3 rounded-xl text-sm font-medium
                        text-gray-400 outline-none transition-colors hover:bg-gray-50 hover:text-gray-600
                        focus-visible:ring-2 focus-visible:ring-primary-500
                        ${railCollapsed ? 'justify-center px-0' : ''}`}
          >
            <Icon
              name="chevronLeft"
              size={18}
              className={`shrink-0 transition-transform duration-200 ${railCollapsed ? 'rotate-180' : ''}`}
            />
            {label('Collapse')}
          </button>
        </div>
      </aside>
    </>
  );
}
