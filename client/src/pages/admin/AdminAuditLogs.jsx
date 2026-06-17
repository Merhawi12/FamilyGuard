import { useEffect, useState } from 'react';
import { admin as adminApi } from '../../services/api';

export default function AdminAuditLogs() {
  const [logs, setLogs] = useState([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionFilter, setActionFilter] = useState('');

  const load = () => {
    setLoading(true);
    adminApi.getAuditLogs({ action: actionFilter || undefined })
      .then((r) => { setLogs(r.data.rows); setCount(r.data.count); })
      .catch((e) => setError(e.response?.data?.error || 'Failed to load audit logs'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-4">
      {error && <div className="p-3 bg-red-50 text-red-700 rounded-xl text-sm">{error}</div>}

      <div className="flex gap-2">
        <input
          className="input w-64"
          placeholder="Filter by action prefix (e.g. admin., auth.)"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load()}
        />
        <button onClick={load} className="btn-ghost text-sm">Filter</button>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800">Audit Trail ({count})</h2>
        </div>

        {loading ? (
          <div className="text-center py-12 text-gray-400 text-sm">Loading...</div>
        ) : logs.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">No audit entries found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-6 py-3 text-left">Actor</th>
                  <th className="px-6 py-3 text-left">Action</th>
                  <th className="px-6 py-3 text-left">Entity</th>
                  <th className="px-6 py-3 text-left">IP</th>
                  <th className="px-6 py-3 text-left">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-gray-50 transition">
                    <td className="px-6 py-4">{log.user ? `${log.user.name} (${log.user.email})` : '—'}</td>
                    <td className="px-6 py-4 font-mono text-xs">{log.action}</td>
                    <td className="px-6 py-4 text-gray-500 text-xs">{log.entity || '—'}{log.entityId ? ` #${log.entityId.slice(0, 8)}` : ''}</td>
                    <td className="px-6 py-4 text-gray-400 text-xs">{log.ipAddress || '—'}</td>
                    <td className="px-6 py-4 text-gray-400 text-xs">{new Date(log.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
