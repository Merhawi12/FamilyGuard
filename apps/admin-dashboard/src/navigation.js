import { PERMISSIONS, hasPermission, isSuperAdmin } from '@parentix/shared';

/**
 * Every screen in the console, described once — the sidebar, the drawer, the
 * console search and the header title all read this.
 *
 * The screens are grouped the way an operator thinks about them rather than in
 * route order: the day-to-day views first, the things you do on a schedule
 * next, the settings that change how the platform behaves last. Each group is a
 * collapsible section in the rail.
 *
 * `permission` hides a link the account cannot use; `superAdmin` marks the
 * screens only a Super Admin gets. Presentation only — the API enforces both.
 *
 * Labels are also the page headings, so changing one changes what the header
 * announces on that screen.
 */
export const NAV_SECTIONS = [
  {
    id: 'main',
    label: 'Main',
    items: [
      { to: '/', label: 'Overview', icon: 'reports', end: true },
      { to: '/users', label: 'User Management', icon: 'children', permission: PERMISSIONS.MANAGE_USERS },
      // A device belongs to a customer account, so the directory permission is
      // the one that opens it — matching what the API enforces.
      { to: '/devices', label: 'Device Control', icon: 'devices', permission: PERMISSIONS.MANAGE_USERS },
      // Platform-wide filtering configures the platform, so it answers to the
      // settings permission — the same one the API gates the endpoint with.
      { to: '/content-filtering', label: 'Content Filtering', icon: 'filter', permission: PERMISSIONS.MANAGE_SETTINGS },
      { to: '/sessions', label: 'Sessions', icon: 'lock', permission: PERMISSIONS.MANAGE_SESSIONS },
    ],
  },
  {
    id: 'operations',
    label: 'Operations',
    items: [
      { to: '/billing', label: 'Billing & Subscriptions', icon: 'card', permission: PERMISSIONS.MANAGE_BILLING },
      { to: '/notifications', label: 'Notifications', icon: 'bell', permission: PERMISSIONS.SEND_NOTIFICATIONS },
      // The route stays `/audit-logs` — the entries are the audit trail, and a
      // renamed path would break every link anyone has bookmarked to it.
      { to: '/audit-logs', label: 'System Logs', icon: 'file', permission: PERMISSIONS.VIEW_AUDIT_LOGS },
    ],
  },
  {
    id: 'administration',
    label: 'Administration',
    items: [
      { to: '/settings', label: 'Settings', icon: 'settings', permission: PERMISSIONS.MANAGE_SETTINGS },
      { to: '/staff', label: 'Staff Accounts', icon: 'shield', superAdmin: true },
      // Reached from the account block at the foot of the rail and from the
      // header menu, so a third copy in the list would only be noise — but it
      // is still a screen, so it keeps its heading and answers to search.
      { to: '/profile', label: 'My Profile', icon: 'user', hideInRail: true },
    ],
  },
];

/** Every screen, ungrouped — for the title lookup and the console search. */
export const NAV = NAV_SECTIONS.flatMap((section) => section.items);

const allows = (user) => (item) => {
  if (item.superAdmin) return isSuperAdmin(user);
  if (item.permission) return hasPermission(user, item.permission);
  return true;
};

export const visibleTo = (user) => NAV.filter(allows(user));

/** The same list grouped, with the groups an account cannot use dropped. */
export const sectionsFor = (user) => NAV_SECTIONS
  .map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.hideInRail && allows(user)(item)),
  }))
  .filter((section) => section.items.length > 0);

/**
 * The nav entry a pathname belongs to. The trailing slash is dropped first: the
 * router treats `/users/` and `/users` as the same screen but reports the path
 * as typed, so an exact-match lookup on the raw value misses.
 */
export const matchForPath = (pathname) => {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return NAV
    .filter((item) => (item.end ? path === item.to : path.startsWith(item.to)))
    .sort((a, b) => b.to.length - a.to.length)[0];
};

export const titleForPath = (pathname) => matchForPath(pathname)?.label || 'Parentix Admin';

/** Which rail section holds the current screen, so it can be opened for you. */
export const sectionForPath = (pathname) => {
  const item = matchForPath(pathname);
  return item ? NAV_SECTIONS.find((section) => section.items.includes(item))?.id : undefined;
};
