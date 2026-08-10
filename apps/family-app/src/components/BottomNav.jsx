import { NavLink } from 'react-router-dom';
import { Icon } from '@parentix/shared';
import { TAB_ITEMS } from '../navigation';

/**
 * The phone tab bar.
 *
 * A drawer alone means every move between screens costs two taps and a reach to
 * the top-left corner of the phone. The four destinations a parent actually
 * moves between live here, within thumb reach; "More" opens the drawer for the
 * rest.
 *
 * `pb-safe` keeps the row clear of the iOS home indicator, and the matching
 * `pb-nav-b` on the page content stops the last row of a list hiding underneath.
 */
export default function BottomNav({ onOpenMenu, badges = {} }) {
  const itemClass = (isActive) =>
    `flex flex-col items-center justify-center gap-1 flex-1 min-w-0 h-full pt-1 transition ${
      isActive ? 'text-primary-600' : 'text-gray-400 active:text-gray-600'
    }`;

  return (
    <nav
      aria-label="Primary"
      className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-white/95 backdrop-blur border-t border-gray-100 shadow-nav pb-safe"
    >
      <div className="flex items-stretch h-16">
        {TAB_ITEMS.map(({ to, label, icon, end, badge }) => {
          const count = badge ? badges[badge] || 0 : 0;
          return (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => itemClass(isActive)}>
              <span className="relative">
                <Icon name={icon} size={22} />
                {count > 0 && (
                  <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 bg-danger text-white text-[10px] font-semibold rounded-full flex items-center justify-center">
                    {count > 9 ? '9+' : count}
                  </span>
                )}
              </span>
              <span className="text-[11px] font-medium leading-none truncate max-w-full px-1">{label}</span>
            </NavLink>
          );
        })}

        <button type="button" onClick={onOpenMenu} className={itemClass(false)} aria-label="Open menu">
          <Icon name="menu" size={22} />
          <span className="text-[11px] font-medium leading-none">More</span>
        </button>
      </div>
    </nav>
  );
}
