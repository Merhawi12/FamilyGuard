import { useEffect, useState } from 'react';
import { admin as adminApi } from '../../services/api';

const STATUS_COLORS = {
  succeeded: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-600',
  active: 'bg-green-100 text-green-700',
  past_due: 'bg-orange-100 text-orange-600',
  cancelled: 'bg-gray-100 text-gray-600',
};

export default function AdminBilling() {
  const [transactions, setTransactions] = useState([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ status: '', plan: '' });

  const load = () => {
    setLoading(true);
    adminApi.listTransactions(filters)
      .then((r) => { setTransactions(r.data.rows); setCount(r.data.count); })
      .catch((e) => setError(e.response?.data?.error || 'Failed to load transactions'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [filters.status, filters.plan]);

  return (
    <div className="space-y-4">
      {error && <div className="p-3 bg-red-50 text-red-700 rounded-xl text-sm">{error}</div>}

      <div className="flex flex-wrap gap-2">
        <select className="input w-40" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
          <option value="">All statuses</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="active">Active</option>
          <option value="past_due">Past Due</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select className="input w-40" value={filters.plan} onChange={(e) => setFilters({ ...filters, plan: e.target.value })}>
          <option value="">All plans</option>
          <option value="free">Free</option>
          <option value="premium">Premium</option>
          <option value="family">Family</option>
        </select>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800">Transactions ({count})</h2>
        </div>

        {loading ? (
          <div className="text-center py-12 text-gray-400 text-sm">Loading...</div>
        ) : transactions.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">No transactions recorded yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-6 py-3 text-left">User</th>
                  <th className="px-6 py-3 text-left">Type</th>
                  <th className="px-6 py-3 text-left">Plan</th>
                  <th className="px-6 py-3 text-left">Amount</th>
                  <th className="px-6 py-3 text-left">Status</th>
                  <th className="px-6 py-3 text-left">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {transactions.map((t) => (
                  <tr key={t.id} className="hover:bg-gray-50 transition">
                    <td className="px-6 py-4">
                      <p className="font-medium text-gray-900">{t.user?.name || '—'}</p>
                      <p className="text-xs text-gray-400">{t.user?.email}</p>
                    </td>
                    <td className="px-6 py-4 text-gray-600 text-xs">{t.type.replace(/_/g, ' ')}</td>
                    <td className="px-6 py-4 capitalize">{t.plan || '—'}</td>
                    <td className="px-6 py-4">{t.amount != null ? `$${(t.amount / 100).toFixed(2)} ${t.currency?.toUpperCase()}` : '—'}</td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 rounded-lg text-xs font-medium ${STATUS_COLORS[t.status] || 'bg-gray-100 text-gray-600'}`}>{t.status}</span>
                    </td>
                    <td className="px-6 py-4 text-gray-400 text-xs">{new Date(t.createdAt).toLocaleString()}</td>
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
