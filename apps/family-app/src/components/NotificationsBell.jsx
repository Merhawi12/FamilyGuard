import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  notifications as notificationsApi,
  alertLabel,
  timeAgo,
  useDismissable,
  useSocket,
  EmptyState,
  Icon,
} from '@parentix/shared';

const SEVERITY_DOT = {
  high: 'bg-danger',
  medium: 'bg-warning',
  low: 'bg-success',
};

const TYPE_ACCENT = {
  info: 'bg-primary-500',
  warning: 'bg-warning',
  success: 'bg-success',
};

/** The panel is phone-width, so the units are short and a day back is a date. */
const sent = (value) => timeAgo(value, { compact: true });

/**
 * One bell for both kinds of message.
 *
 * There used to be two, side by side in the header: 🔔 for safety alerts raised
 * by a child's device and 📩 for announcements from Parentix. They were near
 * identical components, and on a phone they were two competing red dots in a
 * header with room for neither. They are one control with two tabs now — the
 * distinction is real, so it is kept, but it costs a tab rather than a second
 * icon and a second panel.
 */
export default function NotificationsBell() {
  const { socket, alerts, alertsError, markAlertRead, markAllAlertsRead } = useSocket();
  const [updates, setUpdates] = useState([]);
  const [tab, setTab] = useState('alerts');
  const { open, setOpen, toggle, ref } = useDismissable();
  const navigate = useNavigate();

  /**
   * The updates list, refreshed while someone is actually looking at it.
   *
   * Still polled: the socket covers a dashboard that is open, and this covers
   * one that was asleep, offline, or missed a delivery while reconnecting.
   *
   * But it used to poll unconditionally, so a dashboard left open in a
   * background tab asked the API for its notifications every minute for as long
   * as the browser stayed alive — on a phone that is a request a minute against
   * the radio and the battery, for a panel nobody can see. A hidden tab is
   * skipped and refreshed the moment it comes back instead, which is both
   * cheaper and *fresher* than the old behaviour: a parent returning to the tab
   * used to wait up to a minute for the next tick.
   */
  useEffect(() => {
    const load = () => notificationsApi.list().then((r) => setUpdates(r.data)).catch(() => {});
    load();

    const interval = setInterval(() => {
      if (!document.hidden) load();
    }, 60000);

    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  /**
   * An announcement from Parentix, the moment it is sent.
   *
   * Without this the only path to the bell was the minute poll above — so a
   * maintenance notice reached a parent watching the dashboard up to a minute
   * after the operator sent it. Deduplicated by id because the poll and the
   * socket can deliver the same row.
   */
  useEffect(() => {
    if (!socket) return undefined;
    const onNotification = (row) =>
      setUpdates((prev) => (prev.some((n) => n.id === row.id) ? prev : [row, ...prev]));
    socket.on('notification:new', onNotification);
    return () => socket.off('notification:new', onNotification);
  }, [socket]);

  const unreadAlerts = alerts.filter((a) => !a.isRead).length;
  const unreadUpdates = updates.filter((n) => !n.isRead).length;
  const unread = unreadAlerts + unreadUpdates;

  const markUpdateRead = (id) => {
    setUpdates((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    notificationsApi.markRead(id).catch(() => {});
  };

  const markAllRead = () => {
    if (tab === 'alerts') return markAllAlertsRead();
    setUpdates((prev) => prev.map((n) => ({ ...n, isRead: true })));
    return notificationsApi.markAllRead().catch(() => {});
  };

  const tabUnread = tab === 'alerts' ? unreadAlerts : unreadUpdates;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={toggle}
        aria-label={unread > 0 ? `Alerts, ${unread} unread` : 'Alerts'}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="icon-btn relative"
      >
        <Icon name="bell" size={22} />
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
          <div className="flex items-center gap-1 p-2 border-b border-gray-100 shrink-0">
            {[
              { key: 'alerts', label: 'Alerts', count: unreadAlerts },
              { key: 'updates', label: 'Updates', count: unreadUpdates },
            ].map(({ key, label, count }) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex-1 min-h-[38px] px-3 rounded-xl text-sm font-medium transition ${
                  tab === key ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:bg-gray-50'
                }`}
              >
                {label}
                {count > 0 && <span className="ml-1.5 text-xs text-danger font-semibold">{count}</span>}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto scroll-touch overscroll-contain">
            {tab === 'alerts' ? (
              // "No alerts" is reassurance, so it is only shown when we know it
              // to be true — a failed load says so instead. See Alerts.jsx.
              alertsError ? (
                <EmptyState
                  compact
                  icon="warning"
                  title="Could not load alerts"
                  description={alertsError}
                />
              ) : alerts.length === 0 ? (
                <EmptyState compact icon="bell" title="No alerts" description="Safety alerts from your children's devices appear here." />
              ) : (
                alerts.slice(0, 30).map((a) => (
                  <button
                    key={a.id}
                    onClick={() => markAlertRead(a.id)}
                    className={`w-full text-left flex gap-3 px-4 py-3 border-b border-gray-50 last:border-0 transition hover:bg-gray-50 ${
                      !a.isRead ? 'bg-primary-50/60' : ''
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full shrink-0 mt-1.5 ${SEVERITY_DOT[a.severity] || SEVERITY_DOT.low}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-gray-900">{a.message}</span>
                      <span className="block text-xs text-gray-400 mt-1">
                        {alertLabel(a.type)} · {sent(a.createdAt)}
                      </span>
                    </span>
                  </button>
                ))
              )
            ) : updates.length === 0 ? (
              <EmptyState compact icon="inbox" title="No updates" description="News and account notices from Parentix appear here." />
            ) : (
              updates.map((n) => (
                <button
                  key={n.id}
                  onClick={() => markUpdateRead(n.id)}
                  className={`w-full text-left flex gap-3 px-4 py-3 border-b border-gray-50 last:border-0 transition hover:bg-gray-50 ${
                    !n.isRead ? 'bg-primary-50/60' : ''
                  }`}
                >
                  <span className={`w-1 self-stretch rounded-full shrink-0 ${TYPE_ACCENT[n.type] || TYPE_ACCENT.info}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-gray-900">{n.title}</span>
                    <span className="block text-xs text-gray-500 mt-0.5">{n.message}</span>
                    <span className="block text-xs text-gray-400 mt-1">{sent(n.createdAt)}</span>
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="flex items-center justify-between gap-2 p-2 border-t border-gray-100 shrink-0">
            <button
              onClick={() => { setOpen(false); navigate('/dashboard/alerts'); }}
              className="btn-ghost btn-sm"
            >
              View all alerts
            </button>
            <button onClick={markAllRead} disabled={tabUnread === 0} className="btn-ghost btn-sm">
              Mark all read
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
