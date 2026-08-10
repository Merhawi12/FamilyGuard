import { useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Avatar, Icon, useAuth, roleLabel } from '@parentix/shared';
import { sectionsFor, sectionForPath } from '../navigation';
import usePersistentState from '../hooks/usePersistentState';

/**
 * The console rail.
 *
 * One component covers three shapes, because they are the same navigation seen
 * at three widths:
 *
 *   phone/tablet  a drawer over the page — backdrop, Escape, scroll lock,
 *                 closes behind the link you tapped
 *   desktop       a permanent rail
 *   desktop, collapsed
 *                 the same rail at icon width, labels moved into tooltips
 *
 * `railed` is only ever true on a desktop: a 72px strip of icons is the wrong
 * answer on a phone, where the drawer already gives the labels back.
 *
 * Sections fold. Which ones are folded is remembered, with one exception — the
 * section holding the screen you are on is always opened, so arriving from the
 * console search never leaves the current page hidden inside a closed group.
 */
export default function Sidebar({ open, onClose, railed, collapsed, onToggleCollapse, panelRef }) {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const sections = sectionsFor(user);

  const [folded, setFolded] = usePersistentState('px_admin_folded_sections', []);
  const activeSection = sectionForPath(pathname);

  useEffect(() => {
    if (!activeSection) return;
    // Returns the same array when nothing changes, so this cannot loop.
    setFolded((ids) => (ids.includes(activeSection) ? ids.filter((id) => id !== activeSection) : ids));
  }, [activeSection, setFolded]);

  const toggleSection = (id) =>
    setFolded((ids) => (ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id]));

  /**
   * Up/Down walk the rail, Home/End jump to its ends — the pattern a keyboard
   * user expects from a menu, and the reason the section headers are buttons in
   * the same focus order rather than plain headings.
   */
  const onKeyDown = (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const stops = [...event.currentTarget.querySelectorAll('[data-rail-stop]')]
      .filter((el) => el.offsetParent !== null && el.tabIndex !== -1);
    if (!stops.length) return;

    event.preventDefault();
    const here = stops.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? stops.length - 1
        : event.key === 'ArrowDown' ? (here + 1) % stops.length
          : (here - 1 + stops.length) % stops.length;
    stops[next].focus();
  };

  const linkClass = ({ isActive }) => [
    'rail-item',
    railed ? 'justify-center px-0' : 'px-3',
    isActive ? 'rail-item-active' : 'rail-item-idle',
  ].join(' ');

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      {...(open ? { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Console menu' } : {})}
      className={`fixed lg:sticky inset-y-0 left-0 top-0 z-50 lg:z-auto shrink-0 outline-none
                  h-dvh w-[17.5rem] flex flex-col bg-navy-900 text-white
                  border-r border-navy-950/50 shadow-pop lg:shadow-none
                  transition-[transform,width] duration-300 ease-out
                  ${open ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0
                  ${railed ? 'lg:w-[4.75rem]' : 'lg:w-[17rem]'}`}
    >
      {/* Brand */}
      <div className={`flex items-center gap-2.5 h-16 shrink-0 border-b border-white/10
                       ${railed ? 'justify-center px-2' : 'px-4'}`}>
        {/* The logo file is navy ink on transparent — it disappears against the
            rail, so the mark here is drawn from the icon set instead. */}
        <span
          className="flex items-center justify-center w-9 h-9 shrink-0 rounded-xl bg-primary-600 text-white
                     shadow-[0_4px_14px_-4px_rgba(37,99,235,0.9)]"
          aria-hidden="true"
        >
          <Icon name="shieldCheck" size={20} strokeWidth={2.2} />
        </span>
        {!railed && (
          <div className="min-w-0 flex-1">
            <p className="font-bold text-white leading-tight truncate">Parentix</p>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-navy-400 leading-tight">
              Admin console
            </p>
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          className="rail-ghost w-10 h-10 lg:hidden -mr-1"
          aria-label="Close menu"
        >
          <Icon name="close" />
        </button>
      </div>

      {/* Sections */}
      <nav
        onKeyDown={onKeyDown}
        aria-label="Console sections"
        className="flex-1 overflow-y-auto scroll-touch no-scrollbar px-3 py-4 space-y-4"
      >
        {sections.map((section) => {
          const expanded = railed || !folded.includes(section.id);

          return (
            <div key={section.id}>
              {railed ? (
                <div className="mx-auto mb-2 h-px w-8 bg-white/10" aria-hidden="true" />
              ) : (
                <button
                  type="button"
                  data-rail-stop
                  onClick={() => toggleSection(section.id)}
                  aria-expanded={expanded}
                  aria-controls={`rail-section-${section.id}`}
                  className="rail-section"
                >
                  <span>{section.label}</span>
                  <Icon
                    name="chevronDown"
                    size={14}
                    strokeWidth={2.4}
                    className={`transition-transform duration-200 ${expanded ? '' : '-rotate-90'}`}
                  />
                </button>
              )}

              {/* 0fr → 1fr animates a height nobody has measured, so a section
                  folds smoothly whatever it happens to contain. */}
              <div
                id={`rail-section-${section.id}`}
                className={`grid transition-[grid-template-rows] duration-200 ease-out
                            ${expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
              >
                <ul
                  className={`min-h-0 overflow-hidden space-y-1 ${expanded ? 'mt-1.5' : ''}`}
                  aria-hidden={!expanded}
                >
                  {section.items.map(({ to, label, icon, end }) => (
                    <li key={to}>
                      <NavLink
                        to={to}
                        end={end}
                        data-rail-stop
                        tabIndex={expanded ? undefined : -1}
                        title={railed ? label : undefined}
                        className={linkClass}
                      >
                        <Icon name={icon} size={19} className="shrink-0" />
                        <span className={railed ? 'sr-only' : 'truncate'}>{label}</span>
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          );
        })}
      </nav>

      {/* Who is signed in */}
      <div className="shrink-0 border-t border-white/10 p-3 pb-safe">
        <div className={`flex items-center gap-1.5 ${railed ? 'justify-center' : ''}`}>
          <NavLink
            to="/profile"
            title={railed ? user?.name : undefined}
            className={`flex items-center gap-2.5 min-w-0 min-h-[44px] rounded-xl p-1.5 transition-colors
                        hover:bg-white/[0.07] focus-visible:ring-white focus-visible:ring-offset-navy-900
                        ${railed ? '' : 'flex-1'}`}
          >
            <Avatar name={user?.name} size="sm" />
            {!railed && (
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-white leading-tight">
                  {user?.name}
                </span>
                <span className="block truncate text-[11px] text-navy-400 leading-tight">
                  {user?.email || roleLabel(user?.role)}
                </span>
              </span>
            )}
          </NavLink>

          {!railed && (
            <button
              type="button"
              onClick={logout}
              className="rail-ghost w-11 h-11 shrink-0"
              aria-label="Sign out"
              title="Sign out"
            >
              <Icon name="logout" size={18} />
            </button>
          )}
        </div>

        {/* Desktop only: on a phone the drawer is already the collapsed state. */}
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-pressed={collapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={`rail-ghost hidden lg:flex w-full min-h-[38px] mt-1 text-[11px] font-semibold
                      uppercase tracking-[0.14em] ${railed ? 'px-0' : 'px-3 justify-start'}`}
        >
          <Icon
            name="chevronLeft"
            size={16}
            strokeWidth={2.4}
            className={`transition-transform duration-300 ${collapsed ? 'rotate-180' : ''}`}
          />
          {!railed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
