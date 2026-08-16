import { useEffect } from 'react';
import { Icon } from '@parentix/shared';

/**
 * A notification that arrived while the parent was already looking at the app.
 *
 * Android's FCM SDK posts to the notification tray only when the app is
 * *backgrounded*. In the foreground the push is handed to the Capacitor plugin
 * and nothing is displayed — so the one parent guaranteed to see nothing when
 * their child pressed the emergency button was the parent holding the app open.
 *
 * Shown in-app rather than re-posted to the tray. Re-posting needs a local
 * notification plugin, a second channel and its own permission handling, and it
 * would put a notification behind the very screen that could show the thing
 * itself. A banner over the app needs none of that and can carry a real action.
 *
 * The browser needs none of this: Web Push always runs through the service
 * worker, which calls `showNotification` whether or not the tab is visible.
 *
 * It does not auto-dismiss. Everything that reaches a parent this way is about
 * their child, and a banner that removes itself after four seconds is a banner
 * that a parent who looked away has no way to get back.
 */
export default function PushBanner({ notice, onDismiss, onOpen }) {
  // Escape closes it, the same as any transient overlay.
  useEffect(() => {
    if (!notice) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [notice, onDismiss]);

  if (!notice) return null;

  const urgent = notice.data?.severity === 'high';

  return (
    <div
      // `alert` rather than `status`: these interrupt on purpose, and a screen
      // reader should say so rather than wait for a pause in the page.
      role="alert"
      aria-live="assertive"
      className="fixed inset-x-2 top-2 z-50 sm:inset-x-auto sm:right-4 sm:top-4 sm:w-96 animate-scale-in"
    >
      <div
        className={`card p-3 flex items-start gap-3 shadow-pop ${
          urgent ? 'border-red-200 bg-red-50' : ''
        }`}
      >
        <span
          className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
            urgent ? 'bg-white text-danger' : 'bg-primary-50 text-primary-600'
          }`}
          aria-hidden="true"
        >
          <Icon name={urgent ? 'warning' : 'bell'} size={18} />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900">{notice.title}</p>
          {notice.body && <p className="text-sm text-gray-600 mt-0.5 break-words">{notice.body}</p>}
          {notice.data?.url && (
            <button onClick={onOpen} className="btn-primary btn-sm mt-2.5">
              View
            </button>
          )}
        </div>

        <button
          onClick={onDismiss}
          className="icon-btn w-9 h-9 text-gray-400 hover:text-gray-600 shrink-0"
          aria-label="Dismiss notification"
        >
          <Icon name="close" size={18} />
        </button>
      </div>
    </div>
  );
}
