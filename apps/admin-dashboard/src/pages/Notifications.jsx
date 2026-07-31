import { useEffect, useState, useCallback } from 'react';
import { admin as adminApi, errorMessage, Pagination, hasPermission, useAuth, PERMISSIONS } from '@parentix/shared';

const PAGE_SIZE = 50;

export default function AdminNotifications() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [sent, setSent] = useState([]);
  const [sentCount, setSentCount] = useState(0);
  const [sentOffset, setSentOffset] = useState(0);
  const [loadingSent, setLoadingSent] = useState(true);
  const [form, setForm] = useState({ target: 'broadcast', userId: '', title: '', message: '', type: 'info' });
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

  return (
    <div className="space-y-6">
      <div className="card max-w-xl">
        <h2 className="font-semibold mb-4">Send Notification</h2>
        {error && <div className="p-3 bg-red-50 text-red-700 rounded-xl text-sm mb-3">{error}</div>}
        {success && <div className="p-3 bg-green-50 text-green-700 rounded-xl text-sm mb-3">{success}</div>}
        <form onSubmit={handleSend} className="space-y-3">
          <select className="input" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })}>
            <option value="broadcast">Broadcast to all users</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
          </select>
          <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="success">Success</option>
          </select>
          <input className="input" placeholder="Title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <textarea className="input" placeholder="Message" required rows={3} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
          <button type="submit" disabled={sending} className="btn-primary w-full disabled:opacity-60">{sending ? 'Sending...' : 'Send'}</button>
        </form>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800">Sent History ({sentCount})</h2>
        </div>
        {sent.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">No notifications sent yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-6 py-3 text-left">Recipient</th>
                  <th className="px-6 py-3 text-left">Title</th>
                  <th className="px-6 py-3 text-left">Type</th>
                  <th className="px-6 py-3 text-left">Read</th>
                  <th className="px-6 py-3 text-left">Sent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sent.map((n) => (
                  <tr key={n.id} className="hover:bg-gray-50 transition">
                    <td className="px-6 py-4">{n.user?.name || '—'}</td>
                    <td className="px-6 py-4">{n.title}</td>
                    <td className="px-6 py-4 capitalize">{n.type}</td>
                    <td className="px-6 py-4">{n.isRead ? 'Read' : 'Unread'}</td>
                    <td className="px-6 py-4 text-gray-400 text-xs">{new Date(n.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="px-6 pb-4">
          <Pagination
            offset={sentOffset} limit={PAGE_SIZE} count={sentCount}
            onChange={setSentOffset} disabled={loadingSent} label="notifications"
          />
        </div>
      </div>
    </div>
  );
}
