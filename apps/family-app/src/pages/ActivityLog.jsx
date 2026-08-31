import { useEffect, useState } from 'react';
import {
  children as childrenApi, activity as activityApi,
  EmptyState, Icon, Pagination, errorMessage, formatMinutes,
} from '@parentix/shared';
import ChildTabs from '../components/ChildTabs';
import PageIntro from '../components/PageIntro';

const CATEGORY_ICON = {
  social_media: 'message',
  gaming: 'sparkle',
  education: 'file',
  entertainment: 'image',
  browsing: 'globe',
  other: 'inbox',
};

const LIMIT = 20;

export default function ActivityLog() {
  const [childList, setChildList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [dateRange, setDateRange] = useState({ from: '', to: '' });
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  // Bumped to re-run the load effect after a delete, without duplicating it.
  const [reloads, setReloads] = useState(0);

  /**
   * A failed child list must not read as "you have no children".
   *
   * There was no `.catch` here, so a request that failed left `childList` empty
   * and the screen drew "No child profiles yet — add a child under Children" to
   * a parent who has several. The activity load below already tells an empty
   * result apart from a failed one; this is the same rule applied to the list it
   * depends on. It also left an unhandled rejection behind it.
   *
   * `error` is already rendered ahead of the empty case here, so setting it is
   * enough to put the right screen up.
   */
  useEffect(() => {
    childrenApi.list()
      .then((r) => { setChildList(r.data); if (r.data[0]) setSelected(r.data[0]); })
      .catch((err) => setError(errorMessage(err, 'Could not load your children.')))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    setError('');
    activityApi.get(selected.id, { limit: LIMIT, offset, ...dateRange })
      .then((r) => { setLogs(r.data.rows); setTotal(r.data.count); })
      .catch((err) => {
        // "No activity yet" is a statement about the child, not about the
        // request — the same distinction WebHistory draws.
        setError(errorMessage(err, 'Could not load activity.'));
        setLogs([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  }, [selected, offset, dateRange, reloads]);

  const hasFilters = !!(dateRange.from || dateRange.to);

  /**
   * Delete one record.
   *
   * Named in the prompt because the rows are dense and repetitive — several
   * "Microsoft Edge" entries minutes apart is exactly where the wrong one gets
   * tapped.
   */
  const removeRow = async (log) => {
    const label = log.appName || log.url || 'Unknown';
    if (!confirm([
      'Delete this record?',
      `${label}\n${new Date(log.startTime).toLocaleString()}`,
      'This cannot be undone.',
    ].join('\n\n'))) return;
    setError('');
    try {
      await activityApi.removeEntry(selected.id, log.id);
      setReloads((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err, 'Could not delete that record.'));
    }
  };

  /**
   * Clear the log, honouring the date range on screen.
   *
   * The prompt names the browsing consequence explicitly. This screen shows app
   * usage *and* browsing — they are one table — so clearing it takes the web
   * history with it. A parent who discovered that afterwards would have no way
   * to tell it apart from a device that had stopped reporting.
   */
  const clearLog = async () => {
    const scope = hasFilters
      ? `the activity between ${dateRange.from || 'the beginning'} and ${dateRange.to || 'now'}`
      : "this child's entire activity log";
    if (!confirm([
      `Delete ${scope}?`,
      'This includes the browsing records, so their Web History goes too — they are the same records.',
      'This cannot be undone.',
    ].join('\n\n'))) return;

    setDeleting(true);
    setError('');
    try {
      const { data } = await activityApi.clear(selected.id, {
        from: dateRange.from || undefined,
        to: dateRange.to || undefined,
      });
      setOffset(0);
      setReloads((n) => n + 1);
      if (!data?.deleted) setError('There was nothing to delete.');
    } catch (err) {
      setError(errorMessage(err, 'Could not clear the activity log.'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageIntro description="App usage and browsing recorded on your child's devices.">
        {selected && logs.length > 0 && (
          <button
            onClick={clearLog}
            disabled={deleting}
            className="btn-secondary btn-sm text-danger border-red-200 hover:bg-red-50 disabled:opacity-50"
          >
            <Icon name="trash" size={15} />
            {hasFilters ? 'Clear range' : 'Clear all'}
          </button>
        )}
      </PageIntro>

      <ChildTabs
        items={childList}
        selectedId={selected?.id}
        onSelect={(c) => { setSelected(c); setOffset(0); }}
      />

      <div className="card">
        {/* Two dates side by side stay readable at 360px; the reset button gets
            its own row rather than being squeezed to an unreadable width. */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <label className="field">
            <span className="field-label text-xs">From</span>
            <input
              type="date" className="input" value={dateRange.from}
              onChange={(e) => { setDateRange({ ...dateRange, from: e.target.value }); setOffset(0); }}
            />
          </label>
          <label className="field">
            <span className="field-label text-xs">To</span>
            <input
              type="date" className="input" value={dateRange.to}
              onChange={(e) => { setDateRange({ ...dateRange, to: e.target.value }); setOffset(0); }}
            />
          </label>
          {hasFilters && (
            <button
              onClick={() => { setDateRange({ from: '', to: '' }); setOffset(0); }}
              className="btn-ghost btn-sm col-span-2 justify-self-start"
            >
              Clear dates
            </button>
          )}
        </div>

        {loading ? (
          <p className="text-sm text-gray-400 text-center py-10">Loading activity…</p>
        ) : error ? (
          <EmptyState
            icon="warning"
            title="Could not load activity"
            description={error}
          />
        ) : childList.length === 0 ? (
          <EmptyState
            icon="children"
            title="No child profiles yet"
            description="Add a child under Children to start recording activity."
          />
        ) : logs.length === 0 ? (
          <EmptyState
            icon="activity"
            title={hasFilters ? 'Nothing in that range' : 'No activity yet'}
            description={
              hasFilters
                ? 'Try a wider date range.'
                : 'Activity appears once a linked device starts reporting usage.'
            }
          />
        ) : (
          <div className="space-y-2">
            {logs.map((log) => (
              <div key={log.id} className="list-row bg-gray-50">
                <span className="w-9 h-9 rounded-xl bg-white text-gray-500 flex items-center justify-center shrink-0">
                  <Icon name={CATEGORY_ICON[log.category] || CATEGORY_ICON.other} size={18} />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm text-gray-900 truncate">
                    {log.appName || log.url || 'Unknown'}
                  </p>
                  <p className="text-xs text-gray-500 truncate">
                    {log.device?.name ? `${log.device.name} · ` : ''}
                    {new Date(log.startTime).toLocaleString()}
                  </p>
                </div>
                <span className="text-sm font-medium text-gray-700 shrink-0">
                  {formatMinutes(log.durationMinutes)}
                </span>
                <button
                  onClick={() => removeRow(log)}
                  className="icon-btn w-11 h-11 shrink-0 text-gray-400 hover:text-danger hover:bg-red-50"
                  aria-label={`Delete record: ${log.appName || log.url || 'Unknown'}`}
                  title="Delete this record"
                >
                  <Icon name="trash" size={17} />
                </button>
              </div>
            ))}
          </div>
        )}

        <Pagination
          offset={offset}
          limit={LIMIT}
          count={total}
          onChange={setOffset}
          label="records"
          disabled={loading}
        />
      </div>
    </div>
  );
}
