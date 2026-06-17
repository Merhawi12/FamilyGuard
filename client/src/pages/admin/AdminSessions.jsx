import { useEffect, useState } from 'react';
import { admin as adminApi } from '../../services/api';

export default function AdminSessions() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionId, setActionId] = useState(null);

  const load = () =>
    adminApi.listActiveSessions().then((r) => setSessions(r.data)).catch((e) => setError(e.response?.data?.error || 'Failed to load sessions')).finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  const forceLogout = async (sessionId) => {
    setActionId(sessionId);
    try { await adminApi.forceLogoutSession(sessionId); load(); }
    catch (e) { setError(e.response?.data?.error || 'Failed to revoke session'); }
    finally { setActionId(null); }
  };

  const forceLogoutUser = async (userId) => {
    setActionId(userId);
    try { await adminApi.forceLogoutUser(userId); load(); }
    catch (e) { setError(e.response?.data?.error || 'Failed to revoke sessions'); }
    finally { setActionId(null); }
  };

  if (loading) return <div className="text-gray-400">Loading active sessions...</div>;

  return (
    <div className="space-y-4">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl flex justify-between">
          {error}
          <button onClick={() => setError('')} className="font-bold">×</button>
        </div>
      )}

      <div className="card p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-semibold text-gray-800">Active Sessions ({sessions.length})</h2>
          <button onClick={load} className="text-xs text-blue-500 hover:underline">Refresh</button>
        </div>

        {sessions.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">No active sessions.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-6 py-3 text-left">User</th>
                  <th className="px-6 py-3 text-left">IP Address</th>
                  <th className="px-6 py-3 text-left">User Agent</th>
                  <th className="px-6 py-3 text-left">Last Active</th>
                  <th className="px-6 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sessions.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-50 transition">
                    <td className="px-6 py-4">
                      <p className="font-medium text-gray-900">{s.user?.name}</p>
                      <p className="text-xs text-gray-400">{s.user?.email}</p>
                    </td>
                    <td className="px-6 py-4 text-gray-500 text-xs">{s.ipAddress || '—'}</td>
                    <td className="px-6 py-4 text-gray-500 text-xs max-w-xs truncate">{s.userAgent || '—'}</td>
                    <td className="px-6 py-4 text-gray-400 text-xs">{new Date(s.lastActiveAt).toLocaleString()}</td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2 justify-end">
                        <button disabled={actionId === s.id} onClick={() => forceLogout(s.id)}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-orange-50 text-orange-600 hover:bg-orange-100 transition">
                          Force Logout
                        </button>
                        <button disabled={actionId === s.userId} onClick={() => forceLogoutUser(s.userId)}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-50 text-red-600 hover:bg-red-100 transition">
                          Logout Everywhere
                        </button>
                      </div>
                    </td>
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
