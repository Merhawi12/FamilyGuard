import { useEffect, useState } from 'react';
import {
  children as childrenApi, activity as activityApi,
  EmptyState, Icon, Pagination, errorMessage,
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

const formatDuration = (min) =>
  (min < 60 ? `${Math.round(min)}m` : `${Math.floor(min / 60)}h ${Math.round(min % 60)}m`);

export default function ActivityLog() {
  const [childList, setChildList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [dateRange, setDateRange] = useState({ from: '', to: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    childrenApi.list()
      .then((r) => { setChildList(r.data); if (r.data[0]) setSelected(r.data[0]); })
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
  }, [selected, offset, dateRange]);

  const hasFilters = !!(dateRange.from || dateRange.to);

  return (
    <div className="space-y-5">
      <PageIntro description="App usage and browsing recorded on your child's devices." />

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
                  {formatDuration(log.durationMinutes)}
                </span>
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
