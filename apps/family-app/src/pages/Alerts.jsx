import { useState } from 'react';
import { alertLabel, EmptyState, Icon, useSocket } from '@parentix/shared';
import PageIntro from '../components/PageIntro';

const SEVERITY = {
  high: { dot: 'bg-danger', badge: 'badge-red', label: 'High' },
  medium: { dot: 'bg-warning', badge: 'badge-amber', label: 'Medium' },
  low: { dot: 'bg-success', badge: 'badge-green', label: 'Low' },
};

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'high', label: 'High' },
  { key: 'medium', label: 'Medium' },
  { key: 'low', label: 'Low' },
];

export default function Alerts() {
  const [filter, setFilter] = useState('all');
  /**
   * The alert list lives in the socket context, which loads the history once and
   * appends anything arriving live. Keeping a second copy here meant this page
   * and the bell disagreed about what was unread.
   */
  const {
    alerts: alertList, alertsLoading: loading, alertsError, reloadAlerts,
    markAlertRead: markRead, markAllAlertsRead: markAllRead,
  } = useSocket();

  const filtered = alertList.filter((a) => {
    if (filter === 'unread') return !a.isRead;
    if (filter === 'all') return true;
    return a.severity === filter;
  });

  const unreadCount = alertList.filter((a) => !a.isRead).length;

  if (loading) return <p className="text-sm text-gray-400 py-8">Loading alerts…</p>;

  /**
   * A failed load is never dressed up as good news.
   *
   * The list is empty whether nothing happened or the request failed, and the
   * empty state for this page reads "No alerts — you are all caught up". On a
   * child-safety screen that is the one wrong answer worth guarding against, so
   * the failure replaces the page rather than sitting above a reassuring list.
   */
  if (alertsError) {
    return (
      <div className="space-y-5">
        <PageIntro description="We could not check for alerts." />
        <div className="card p-6 text-center space-y-3">
          <Icon name="warning" size={28} className="mx-auto text-danger" />
          <p className="text-sm text-gray-900">{alertsError}</p>
          <p className="text-xs text-gray-500">
            This does not mean there are none — we were unable to reach the server.
          </p>
          <button onClick={reloadAlerts} className="btn-secondary btn-sm">Try again</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageIntro
        description={
          unreadCount > 0
            ? `${unreadCount} unread alert${unreadCount === 1 ? '' : 's'}.`
            : 'You are all caught up.'
        }
      >
        {unreadCount > 0 && (
          <button onClick={markAllRead} className="btn-secondary btn-sm">
            Mark all read
          </button>
        )}
      </PageIntro>

      <div className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto no-scrollbar scroll-touch">
        <div className="flex gap-2 w-max pb-0.5">
          {FILTERS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              aria-pressed={filter === key}
              className={`chip ${filter === key ? 'chip-active' : ''}`}
            >
              {key !== 'all' && key !== 'unread' && (
                <span className={`w-2 h-2 rounded-full ${SEVERITY[key].dot}`} />
              )}
              {label}
              {key === 'unread' && unreadCount > 0 && ` (${unreadCount})`}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="shieldCheck"
            title={filter === 'unread' ? 'Nothing unread' : 'No alerts'}
            description={
              filter === 'all'
                ? "Safety alerts raised by your children's devices will appear here."
                : 'No alerts match this filter.'
            }
          />
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((alert) => {
            const sev = SEVERITY[alert.severity] || SEVERITY.low;
            return (
              <div
                key={alert.id}
                className={`card p-4 flex items-start gap-3 ${
                  !alert.isRead ? 'bg-primary-50/60 border-primary-100' : ''
                }`}
              >
                <span
                  className={`w-2.5 h-2.5 rounded-full shrink-0 mt-1.5 ${
                    alert.isRead ? 'bg-gray-200' : sev.dot
                  }`}
                />

                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-1.5">
                    <span className={sev.badge}>{sev.label}</span>
                    {alert.type && <span className="badge-gray">{alertLabel(alert.type)}</span>}
                  </div>
                  <p className="text-sm text-gray-900">{alert.message}</p>
                  <p className="text-xs text-gray-400 mt-1">{new Date(alert.createdAt).toLocaleString()}</p>
                </div>

                {!alert.isRead && (
                  <button
                    onClick={() => markRead(alert.id)}
                    className="icon-btn text-gray-400 hover:text-primary-600"
                    aria-label="Mark as read"
                    title="Mark as read"
                  >
                    <Icon name="check" size={18} strokeWidth={2.2} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
