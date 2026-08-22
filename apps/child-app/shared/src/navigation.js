/**
 * Every screen a linked device can reach, described once.
 *
 * The drawer, the bottom bar and the header title all read this, so a screen is
 * added in one place rather than four — and the header can never disagree with
 * the tab that is lit.
 *
 * Link and Permissions are deliberately absent from both menus: they are steps
 * in setting the device up, not places to go back to. Permissions is reachable
 * from Settings, where a child who lost one can turn it back on.
 */
export const MENU_SECTIONS = [
  {
    id: 'me',
    label: 'My phone',
    items: [
      { route: 'Home', label: 'My Day', icon: 'home', tabIcon: 'homeOutline' },
      { route: 'Messages', label: 'Messages', icon: 'messages', tabIcon: 'messagesOutline' },
    ],
  },
  {
    id: 'device',
    label: 'This device',
    items: [
      { route: 'Settings', label: 'Settings', icon: 'settings', tabIcon: 'settingsOutline' },
      { route: 'Permissions', label: 'Permissions', icon: 'key', menuOnly: true },
    ],
  },
];

export const MENU_ITEMS = MENU_SECTIONS.flatMap((section) => section.items);

/** The bottom bar carries the everyday screens; the drawer carries all of them. */
export const TAB_ITEMS = MENU_ITEMS.filter((item) => !item.menuOnly);

/** The word in the header. Uppercased there, so it stays short here. */
const TITLES = {
  Home: 'My Day',
  Messages: 'Messages',
  Settings: 'Settings',
  Permissions: 'Permissions',
  Link: 'Welcome',
};

export const titleFor = (route) => TITLES[route] || 'Parentix';
