import { useEffect, useState } from 'react';
import { children as childrenApi, activity as activityApi } from '../services/api';

const CATEGORY_ICON = { social_media: '📱', gaming: '🎮', education: '📚', entertainment: '🎬', browsing: '🌐', other: '📂' };

export default function ActivityLog() {
  const [childList, setChildList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [dateRange, setDateRange] = useState({ from: '', to: '' });
  const LIMIT = 20;

  useEffect(() => { childrenApi.list().then((r) => { setChildList(r.data); if (r.data[0]) setSelected(r.data[0]); }); }, []);

  useEffect(() => {
    if (!selected) return;
    activityApi.get(selected.id, { limit: LIMIT, offset: page * LIMIT, ...dateRange })
      .then((r) => { setLogs(r.data.rows); setTotal(r.data.count); });
  }, [selected, page, dateRange]);

  const fmtDur = (min) => min < 60 ? `${Math.round(min)}m` : `${Math.floor(min / 60)}h ${Math.round(min % 60)}m`;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl md:text-2xl font-bold">Activity Log</h1>
        <p className="text-gray-500 text-sm mt-1">Track app usage and browsing activity</p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {childList.map((c) => (
          <button key={c.id} onClick={() => { setSelected(c); setPage(0); }}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition ${selected?.id === c.id ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 hover:bg-gray-50'}`}>
            {c.name}
          </button>
        ))}
      </div>

      <div className="card">
        <div className="grid grid-cols-2 sm:flex gap-3 mb-4 items-end">
          <label className="flex flex-col gap-1 col-span-1">
            <span className="text-xs text-gray-500">From</span>
            <input type="date" className="input" value={dateRange.from} onChange={(e) => setDateRange({ ...dateRange, from: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 col-span-1">
            <span className="text-xs text-gray-500">To</span>
            <input type="date" className="input" value={dateRange.to} onChange={(e) => setDateRange({ ...dateRange, to: e.target.value })} />
          </label>
          <button onClick={() => setDateRange({ from: '', to: '' })} className="btn-ghost text-sm col-span-2 sm:col-span-1">Clear</button>
        </div>

        {logs.length === 0 ? (
          <p className="text-gray-400 text-sm text-center py-8">No activity recorded</p>
        ) : (
          <div className="space-y-2">
            {logs.map((log) => (
              <div key={log.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                <span className="text-lg shrink-0">{CATEGORY_ICON[log.category] || '📂'}</span>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{log.appName || log.url || 'Unknown'}</p>
                  <p className="text-xs text-gray-400 truncate">{log.device?.name} · {new Date(log.startTime).toLocaleString()}</p>
                </div>
                <div className="flex flex-col items-end shrink-0 gap-1">
                  <span className="text-sm font-medium text-gray-600">{fmtDur(log.durationMinutes)}</span>
                  <span className="badge-blue capitalize text-xs hidden sm:inline">{log.category?.replace('_', ' ')}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {total > LIMIT && (
          <div className="flex justify-between items-center mt-4">
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="btn-ghost text-sm">Previous</button>
            <span className="text-sm text-gray-500">{page * LIMIT + 1}–{Math.min((page + 1) * LIMIT, total)} of {total}</span>
            <button onClick={() => setPage((p) => p + 1)} disabled={(page + 1) * LIMIT >= total} className="btn-ghost text-sm">Next</button>
          </div>
        )}
      </div>
    </div>
  );
}
