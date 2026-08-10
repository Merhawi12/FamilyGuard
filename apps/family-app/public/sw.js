/**
 * Service worker for parent push notifications.
 *
 * This is what makes a notification arrive when the dashboard tab is in the
 * background or closed entirely — the page's own JavaScript is not running then,
 * and the browser wakes this instead.
 *
 * Deliberately minimal: it does not cache or serve any application asset, so it
 * cannot serve a stale build. Its whole job is receiving pushes and routing the
 * click.
 */

const DEFAULT_TITLE = 'Parentix';
const FALLBACK_URL = '/dashboard/alerts';

self.addEventListener('install', () => {
  // Take over straight away rather than waiting for every old tab to close;
  // a parent who just enabled notifications expects the next one to arrive.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // A push that is not JSON still deserves to surface rather than vanish.
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || DEFAULT_TITLE;
  const options = {
    body: payload.body || '',
    icon: '/logo.png',
    badge: '/logo.png',
    // Alerts of the same kind for the same child collapse onto one entry rather
    // than stacking up while the parent is away from the screen.
    tag: payload.data?.alertType ? `${payload.data.alertType}:${payload.data.childId || ''}` : undefined,
    renotify: true,
    timestamp: Date.now(),
    data: payload.data || {},
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // The server names the destination, so a tap lands on the alert it was about
  // rather than on a generic dashboard.
  const target = new URL(event.notification.data?.url || FALLBACK_URL, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Reuse an open dashboard tab if there is one — opening a second copy of
      // an app the parent already has open is its own small annoyance.
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          if ('navigate' in client) client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
