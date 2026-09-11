import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  notifications as notificationsApi,
  errorMessage,
  timeAgo,
  useDismissable,
  hasPermission,
  useAuth,
  PERMISSIONS,
  EmptyState,
  Icon,
} from '@parentix/shared';

/**
 * The console's inbox.
 *
 * This header had a bell already, and it was a link to the screen where staff
 * *compose* notifications — so the one control shaped like an inbox opened an
 * outbox, and anything the platform had to say to its own operators had nowhere
 * to arrive. A customer subscribing, a card failing, a subscription cancelled:
 * all of it was written down and none of it was delivered, because the console
 * had no surface that read a staff account's own notifications.
 *
 * Polled, not pushed. The console holds no socket — every live thing on it (the
 * System Logs tail, the Overview) polls — and inventing one here for a handful
 * of billing notices would be a connection per operator for news that is not
 * second-sensitive. A minute is the same cadence the family app's bell settles
 * for.
 */

/** The panel is narrow, so a day back is a date rather than "27 hours ago". */
const sent = (value) => timeAgo(value, { compact: true });

/** The stripe down the left of a row, by what kind of news it is. */
const TYPE_ACCENT = {
  info: 'bg-primary-500',
  warning: 'bg-warning',
  success: 'bg-success',
};

export default function NotificationsBell() {
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const { open, setOpen, toggle, ref } = useDismissable();
  const navigate = useNavigate();

  /**
   * A failed load is not an empty inbox.
   *
   * The list is left alone on a failure rather than cleared, so a poll that
   * fails behind an open panel does not empty a list that was already correct.
   * The error only replaces the *empty state*, which is the one case where "no
   * notifications" and "could not ask" are confusable — and telling an operator
   * there is nothing waiting is the wrong answer to give when we do not know.
   */
  const load = useCallback(() => notificationsApi.list({ limit: 50 })
    .then((r) => { setRows(r.data); setError(''); })
    .catch((e) => setError(errorMessage(e, 'Could not load your notifications.'))), []);

  useEffect(() => {
    load();

    // A hidden tab is skipped and refreshed the moment it comes back: a console
    // left open in a background tab should not poll all night, and an operator
    // returning to it should not wait out the rest of a minute.
    const interval = setInterval(() => { if (!document.hidden) load(); }, 60000);
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const unread = rows.filter((row) => !row.isRead).length;

  /**
   * Read it, and go where it points.
   *
   * Marked read optimistically — the request is a formality, and a bell that
   * waits for a round trip before dimming a row feels broken. A failure leaves
   * the row unread again on the next poll, which is the right recovery.
   */
  const openRow = (row) => {
    setRows((prev) => prev.map((n) => (n.id === row.id ? { ...n, isRead: true } : n)));
    notificationsApi.markRead(row.id).catch(() => {});
    if (row.link) {
      setOpen(false);
      navigate(row.link);
    }
  };

  const markAllRead = () => {
    setRows((prev) => prev.map((n) => ({ ...n, isRead: true })));
    notificationsApi.markAllRead().catch(() => {});
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={toggle}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="icon-btn relative"
      >
        <Icon name="bell" size={20} />
        {unread > 0 && (
          <span className="absolute top-1.5 right-1.5 min-w-[17px] h-[17px] px-1 bg-danger text-white text-[10px] font-semibold rounded-full flex items-center justify-center ring-2 ring-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="fixed sm:absolute left-2 right-2 top-[4.25rem] sm:left-auto sm:right-0 sm:top-[3.25rem]
                     sm:w-96 z-50 bg-white rounded-2xl shadow-pop border border-gray-100
                     flex flex-col max-h-[70dvh] overflow-hidden animate-scale-in"
        >
          <div className="px-4 py-3 border-b border-gray-100 shrink-0">
            <h2 className="text-sm font-semibold text-gray-900">Notifications</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Payments, cancellations and anything else the platform reports to staff.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto scroll-touch overscroll-contain">
            {error && rows.length === 0 ? (
              <EmptyState compact icon="warning" title="Could not load notifications" description={error} />
            ) : rows.length === 0 ? (
              <EmptyState
                compact
                icon="inbox"
                title="Nothing yet"
                description="New subscriptions, renewals and failed payments arrive here."
              />
            ) : (
              rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => openRow(row)}
                  className={`w-full text-left flex gap-3 px-4 py-3 border-b border-gray-50 last:border-0 transition hover:bg-gray-50 ${
                    !row.isRead ? 'bg-primary-50/60' : ''
                  }`}
                >
                  <span className={`w-1 self-stretch rounded-full shrink-0 ${TYPE_ACCENT[row.type] || TYPE_ACCENT.info}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-gray-900">{row.title}</span>
                    <span className="block text-xs text-gray-500 mt-0.5 break-words">{row.message}</span>
                    <span className="block text-xs text-gray-400 mt-1">{sent(row.createdAt)}</span>
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="flex items-center justify-between gap-2 p-2 border-t border-gray-100 shrink-0">
            {/* The outbox this bell used to be. Kept, for the accounts whose job
                it is — it is just no longer the only thing the bell can do. */}
            {hasPermission(user, PERMISSIONS.SEND_NOTIFICATIONS) ? (
              <button
                type="button"
                onClick={() => { setOpen(false); navigate('/notifications'); }}
                className="btn-ghost btn-sm"
              >
                Send a notification
              </button>
            ) : <span />}
            <button type="button" onClick={markAllRead} disabled={unread === 0} className="btn-ghost btn-sm">
              Mark all read
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
