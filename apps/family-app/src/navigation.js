/**
 * Every navigable screen in the parent app, described once.
 *
 * The sidebar, the phone tab bar and the header title were each keeping their
 * own list of routes, so a new page had to be added in three places and a
 * renamed one silently disagreed between them. They all read this instead.
 *
 * `badge` names a live counter the shell resolves — the nav itself stays a
 * plain data structure with no dependency on the socket or the API.
 */

/** Grouped for the drawer / sidebar. Fourteen flat links is a wall; five groups is a menu. */
export const NAV_SECTIONS = [
  {
    title: 'Overview',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: 'dashboard', end: true },
      { to: '/dashboard/children', label: 'Children', icon: 'children' },
      { to: '/dashboard/location', label: 'Location', icon: 'location' },
    ],
  },
  {
    title: 'Controls',
    items: [
      { to: '/dashboard/screen-time', label: 'Screen Time', icon: 'clock' },
      { to: '/dashboard/blocking', label: 'App Blocking', icon: 'block' },
      { to: '/dashboard/contacts', label: 'Contacts', icon: 'contacts' },
    ],
  },
  {
    title: 'Activity',
    items: [
      { to: '/dashboard/activity', label: 'Activity Log', icon: 'activity' },
      { to: '/dashboard/web-history', label: 'Web History', icon: 'globe' },
      { to: '/dashboard/reports', label: 'Reports', icon: 'reports' },
    ],
  },
  {
    title: 'Inbox',
    items: [
      { to: '/dashboard/messages', label: 'Messages', icon: 'message', badge: 'messages' },
      { to: '/dashboard/alerts', label: 'Alerts', icon: 'bell', badge: 'alerts' },
    ],
  },
  {
    title: 'Account',
    items: [
      { to: '/dashboard/profile', label: 'Profile', icon: 'user' },
      { to: '/dashboard/settings', label: 'Settings', icon: 'settings' },
    ],
  },
];

export const NAV_ITEMS = NAV_SECTIONS.flatMap((section) => section.items);

/**
 * The phone tab bar. Four destinations plus the drawer.
 *
 * Everything else is one tap further in, under "More" — a tab bar that tries to
 * hold fourteen items holds none of them well.
 */
export const TAB_ITEMS = [
  { to: '/dashboard', label: 'Home', icon: 'dashboard', end: true },
  { to: '/dashboard/children', label: 'Children', icon: 'children' },
  { to: '/dashboard/location', label: 'Location', icon: 'location' },
  { to: '/dashboard/alerts', label: 'Alerts', icon: 'bell', badge: 'alerts' },
];

/**
 * The heading shown in the header for a given pathname.
 *
 * The trailing slash is dropped first: React Router routes `/dashboard/` and
 * `/dashboard` to the same screen but reports the pathname exactly as typed, so
 * an exact-match lookup on the raw value left the index route titled "Parentix".
 */
export const titleForPath = (pathname) => {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const match = NAV_ITEMS
    .filter((item) => (item.end ? path === item.to : path.startsWith(item.to)))
    // The longest matching prefix is the most specific route.
    .sort((a, b) => b.to.length - a.to.length)[0];
  return match?.label || 'Parentix';
};
