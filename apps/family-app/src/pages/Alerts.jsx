import { useState } from 'react';
import { alertLabel, EmptyState, errorMessage, Icon, useSocket } from '@parentix/shared';
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
    deleteAlert, clearAlerts,
  } = useSocket();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const filtered = alertList.filter((a) => {
    if (filter === 'unread') return !a.isRead;
    if (filter === 'all') return true;
    return a.severity === filter;
  });

  const unreadCount = alertList.filter((a) => !a.isRead).length;

  /**
   * Deleting one alert.
   *
   * Confirmed, because the button sits on the same row as "mark read" and the
   * two are a mis-tap apart — but one is reversible and the other destroys the
   * only record that something happened on a child's device.
   */
  const removeOne = async (alert) => {
    if (!confirm([
      'Delete this alert?',
      `"${alert.message}"`,
      'This cannot be undone.',
    ].join('\n\n'))) return;
    setError('');
    try {
      await deleteAlert(alert.id);
    } catch (err) {
      setError(errorMessage(err, 'Could not delete that alert.'));
    }
  };

  /**
   * Clearing in bulk, narrowed to whatever the screen is currently showing.
   *
   * The confirmation names the filter for the same reason the request carries
   * it: a parent looking at "High" is asking about high-severity alerts, and a
   * clear that quietly took the rest would destroy rows they cannot see and the
   * dialog could not have warned them about.
   */
  const clearShown = async () => {
    const scope = filter === 'all' ? 'every alert on this account'
      : filter === 'unread' ? 'every unread alert'
        : `every ${SEVERITY[filter].label.toLowerCase()}-severity alert`;
    if (!confirm(`Delete ${scope}?\n\nThis cannot be undone.`)) return;

    setBusy(true);
    setError('');
    try {
      const deleted = await clearAlerts(
        filter === 'all' ? {}
          : filter === 'unread' ? { unreadOnly: true }
            : { severity: filter }
      );
      // The server's count, not the length of this page's list — the account may
      // own more alerts than the 50 loaded here.
      if (deleted === 0) setError('There was nothing to delete.');
    } catch (err) {
      setError(errorMessage(err, 'Could not clear those alerts.'));
    } finally {
      setBusy(false);
    }
  };

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
        {filtered.length > 0 && (
          <button
            onClick={clearShown}
            disabled={busy}
            className="btn-secondary btn-sm text-danger border-red-200 hover:bg-red-50 disabled:opacity-50"
          >
            {filter === 'all' ? 'Clear all' : 'Clear these'}
          </button>
        )}
      </PageIntro>

      {error && (
        <div className="card border-red-200 bg-red-50">
          <p className="text-sm text-gray-900">{error}</p>
        </div>
      )}

      {/*
        * Wraps rather than scrolls, unlike ChildTabs.
        *
        * The two look alike and the right answer is opposite, because the lists
        * are: a family can have any number of children, so that row has to be a
        * scroller — but there are exactly five severity filters and there always
        * will be. Side by side they measure 475px, so on a 320–375px phone
        * "Medium" and "Low" sat off the right edge behind a scrollbar that
        * `no-scrollbar` hides, with nothing to suggest they existed. A filter a
        * parent cannot discover is a filter that is not there.
        *
        * Wrapping costs a second row on a narrow screen and shows all five.
        */}
      <div className="flex flex-wrap gap-2">
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

                <div className="flex items-center gap-1 shrink-0">
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
                  <button
                    onClick={() => removeOne(alert)}
                    className="icon-btn text-gray-400 hover:text-danger hover:bg-red-50"
                    aria-label={`Delete alert: ${alert.message}`}
                    title="Delete this alert"
                  >
                    <Icon name="trash" size={17} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
