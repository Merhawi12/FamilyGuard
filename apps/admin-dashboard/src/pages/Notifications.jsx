import { useEffect, useState, useCallback } from 'react';
import {
  admin as adminApi, errorMessage, EmptyState, hasPermission, useAuth, PERMISSIONS,
} from '@parentix/shared';
import DataTable from '../components/DataTable';

const PAGE_SIZE = 50;

const TYPE_BADGE = { info: 'badge-blue', warning: 'badge-amber', success: 'badge-green' };

export default function AdminNotifications() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [sent, setSent] = useState([]);
  const [sentCount, setSentCount] = useState(0);
  const [sentOffset, setSentOffset] = useState(0);
  const [loadingSent, setLoadingSent] = useState(true);
  const [form, setForm] = useState({ target: 'broadcast', title: '', message: '', type: 'info' });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [sending, setSending] = useState(false);

  const loadSent = useCallback((nextOffset = sentOffset) => {
    setLoadingSent(true);
    return adminApi
      .listSentNotifications({ limit: PAGE_SIZE, offset: nextOffset })
      .then((r) => { setSent(r.data.rows); setSentCount(r.data.count); })
      .catch((e) => setError(errorMessage(e, 'Failed to load sent notifications')))
      .finally(() => setLoadingSent(false));
  }, [sentOffset]);

  useEffect(() => { loadSent(sentOffset); }, [sentOffset, loadSent]);

  useEffect(() => {
    // Picking a single recipient needs the directory, which this role may not
    // have — without it only broadcast is offered.
    if (!hasPermission(me, PERMISSIONS.MANAGE_USERS)) return;
    adminApi
      .listUsers({ limit: 200 })
      .then((r) => setUsers(r.data.rows))
      .catch((e) => setError(errorMessage(e, 'Failed to load the recipient list')));
  }, [me]);

  const handleSend = async (e) => {
    e.preventDefault();
    // A broadcast reaches every customer at once and cannot be recalled.
    if (form.target === 'broadcast'
      && !window.confirm('Send this to every customer? A broadcast cannot be recalled.')) return;

    setError(''); setSuccess(''); setSending(true);
    try {
      const payload = {
        title: form.title,
        message: form.message,
        type: form.type,
        ...(form.target === 'broadcast' ? { broadcast: true } : { userId: form.target }),
      };
      const res = await adminApi.sendNotification(payload);
      setSuccess(res.data.message);
      setForm({ ...form, title: '', message: '' });
      // Newest first — jump back to page one so the send is visible.
      if (sentOffset === 0) await loadSent(0); else setSentOffset(0);
    } catch (e) { setError(errorMessage(e, 'Failed to send notification')); }
    finally { setSending(false); }
  };

  const columns = [
    {
      key: 'title',
      header: 'Title',
      primary: true,
      cell: (n) => (
        <>
          <p className="font-medium text-gray-900">{n.title}</p>
          <p className="text-xs text-gray-400 truncate">{n.user?.name || 'Broadcast'}</p>
        </>
      ),
    },
    { key: 'recipient', header: 'Recipient', hideOnCard: true, cell: (n) => n.user?.name || '—' },
    {
      key: 'type',
      header: 'Type',
      cell: (n) => <span className={`${TYPE_BADGE[n.type] || 'badge-gray'} capitalize`}>{n.type}</span>,
    },
    {
      key: 'read',
      header: 'Read',
      cell: (n) => <span className={n.isRead ? 'badge-green' : 'badge-gray'}>{n.isRead ? 'Read' : 'Unread'}</span>,
    },
    {
      key: 'sent',
      header: 'Sent',
      cell: (n) => <span className="text-xs text-gray-400">{new Date(n.createdAt).toLocaleString()}</span>,
    },
  ];

  return (
    <div className="space-y-5">
      <div className="card max-w-xl">
        <h2 className="section-title mb-4">Send a notification</h2>

        {error && <p className="notice-error mb-3">{error}</p>}
        {success && <p className="notice-success mb-3">{success}</p>}

        <form onSubmit={handleSend} className="space-y-4">
          <label className="field">
            <span className="field-label">Recipient</span>
            <select
              className="input" value={form.target}
              onChange={(e) => setForm({ ...form, target: e.target.value })}
            >
              <option value="broadcast">Broadcast to all customers</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Type</span>
            <select
              className="input" value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
            >
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="success">Success</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Title</span>
            <input
              className="input" required value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Message</span>
            <textarea
              className="input" required rows={3} value={form.message}
              onChange={(e) => setForm({ ...form, message: e.target.value })}
            />
          </label>
          <button type="submit" disabled={sending} className="btn-primary btn-block sm:w-auto">
            {sending ? 'Sending…' : 'Send'}
          </button>
        </form>
      </div>

      <DataTable
        title={`Sent history (${sentCount})`}
        columns={columns}
        rows={sent}
        rowKey={(n) => n.id}
        loading={loadingSent}
        loadingLabel="Loading sent notifications…"
        empty={<EmptyState icon="inbox" title="Nothing sent yet" description="Announcements you send appear here." />}
        pagination={{
          offset: sentOffset, limit: PAGE_SIZE, count: sentCount,
          onChange: setSentOffset, disabled: loadingSent, label: 'notifications',
        }}
      />
    </div>
  );
}
