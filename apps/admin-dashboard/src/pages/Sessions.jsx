import { useEffect, useState, useCallback } from 'react';
import { admin as adminApi, errorMessage, EmptyState, Icon } from '@parentix/shared';
import DataTable from '../components/DataTable';

const PAGE_SIZE = 50;

export default function AdminSessions() {
  const [sessions, setSessions] = useState([]);
  const [count, setCount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionId, setActionId] = useState(null);

  const load = useCallback((nextOffset = offset) => {
    setLoading(true);
    return adminApi.listActiveSessions({ limit: PAGE_SIZE, offset: nextOffset })
      .then((r) => { setSessions(r.data.rows); setCount(r.data.count); })
      .catch((e) => setError(errorMessage(e, 'Failed to load sessions')))
      .finally(() => setLoading(false));
  }, [offset]);

  useEffect(() => { load(offset); }, [offset, load]);

  /**
   * Revoking can empty the last page — step back one rather than leaving the
   * admin looking at a blank table.
   */
  const reloadAfterRevoke = async () => {
    const remaining = count - 1;
    if (offset > 0 && offset >= remaining) setOffset(Math.max(0, offset - PAGE_SIZE));
    else await load(offset);
  };

  const forceLogout = async (sessionId) => {
    if (!window.confirm('Sign this session out? The device will have to sign in again.')) return;
    setActionId(sessionId);
    try { await adminApi.forceLogoutSession(sessionId); await reloadAfterRevoke(); }
    catch (e) { setError(errorMessage(e, 'Failed to revoke session')); }
    finally { setActionId(null); }
  };

  const forceLogoutUser = async (userId) => {
    if (!window.confirm('Sign this user out of every device?')) return;
    setActionId(userId);
    try { await adminApi.forceLogoutUser(userId); await reloadAfterRevoke(); }
    catch (e) { setError(errorMessage(e, 'Failed to revoke sessions')); }
    finally { setActionId(null); }
  };

  const columns = [
    {
      key: 'user',
      header: 'User',
      primary: true,
      cell: (s) => (
        <>
          <p className="font-medium text-gray-900 truncate">{s.user?.name}</p>
          <p className="text-xs text-gray-400 truncate">{s.user?.email}</p>
        </>
      ),
    },
    { key: 'ip', header: 'IP address', cell: (s) => <span className="text-xs text-gray-500">{s.ipAddress || '—'}</span> },
    {
      key: 'agent',
      header: 'User agent',
      // A 200-character UA string is desktop-only detail; on a card it would be
      // the tallest thing on screen.
      hideOnCard: true,
      cell: (s) => <span className="text-xs text-gray-500 block max-w-xs truncate">{s.userAgent || '—'}</span>,
    },
    {
      key: 'active',
      header: 'Last active',
      cell: (s) => <span className="text-xs text-gray-400">{new Date(s.lastActiveAt).toLocaleString()}</span>,
    },
  ];

  const actions = (s) => (
    <>
      <button
        disabled={actionId === s.id}
        onClick={() => forceLogout(s.id)}
        className="btn btn-sm bg-amber-50 text-amber-700 hover:bg-amber-100"
      >
        Force logout
      </button>
      <button
        disabled={actionId === s.userId}
        onClick={() => forceLogoutUser(s.userId)}
        className="btn btn-sm bg-red-50 text-red-600 hover:bg-red-100"
      >
        Logout everywhere
      </button>
    </>
  );

  return (
    <div className="space-y-4">
      {error && (
        <p className="notice-error">
          <Icon name="warning" size={16} className="mt-0.5" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')} aria-label="Dismiss" className="shrink-0">
            <Icon name="close" size={16} />
          </button>
        </p>
      )}

      <DataTable
        title={`Active sessions (${count})`}
        toolbar={
          <button onClick={() => load(offset)} className="btn-secondary btn-sm" disabled={loading}>
            <Icon name="refresh" size={15} />
            Refresh
          </button>
        }
        columns={columns}
        rows={sessions}
        rowKey={(s) => s.id}
        actions={actions}
        loading={loading}
        loadingLabel="Loading active sessions…"
        empty={<EmptyState icon="lock" title="No active sessions" description="Nobody is signed in right now." />}
        pagination={{ offset, limit: PAGE_SIZE, count, onChange: setOffset, disabled: loading, label: 'sessions' }}
      />
    </div>
  );
}
