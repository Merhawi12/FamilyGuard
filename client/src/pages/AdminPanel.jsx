import { useEffect, useState } from 'react';
import { admin as adminApi } from '../services/api';

const PLAN_COLORS = {
  premium: 'bg-green-100 text-green-700',
  free: 'bg-gray-100 text-gray-600',
  suspended: 'bg-red-100 text-red-600',
};

export default function AdminPanel() {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionId, setActionId] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const load = () =>
    adminApi.listClients().then((r) => setClients(r.data)).finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  const handleToggleBlock = async (id) => {
    setActionId(id);
    try {
      const res = await adminApi.toggleBlock(id);
      setClients((prev) => prev.map((c) => c.id === id ? { ...c, isActive: res.data.isActive } : c));
    } catch (e) {
      setError(e.response?.data?.error || 'Action failed');
    } finally {
      setActionId(null);
    }
  };

  const handlePlan = async (id, plan) => {
    setActionId(id);
    try {
      const res = await adminApi.updatePlan(id, plan);
      setClients((prev) => prev.map((c) => c.id === id ? { ...c, plan: res.data.plan, isActive: res.data.isActive } : c));
    } catch (e) {
      setError(e.response?.data?.error || 'Action failed');
    } finally {
      setActionId(null);
    }
  };

  const handleDelete = async (id) => {
    setActionId(id);
    try {
      await adminApi.deleteClient(id);
      setClients((prev) => prev.filter((c) => c.id !== id));
    } catch (e) {
      setError(e.response?.data?.error || 'Delete failed');
    } finally {
      setActionId(null);
      setDeleteConfirm(null);
    }
  };

  const trialStatus = (client) => {
    if (!client.trialEndsAt) return null;
    const ends = new Date(client.trialEndsAt);
    const expired = new Date() > ends;
    return expired
      ? <span className="text-xs text-red-500">Trial expired</span>
      : <span className="text-xs text-yellow-600">Trial ends {ends.toLocaleDateString()}</span>;
  };

  if (loading) return <div className="text-gray-400">Loading clients...</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Admin Panel</h1>
        <p className="text-gray-500 text-sm mt-1">Manage client accounts, plans, and access</p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl flex justify-between">
          {error}
          <button onClick={() => setError('')} className="font-bold">×</button>
        </div>
      )}

      <div className="card p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-semibold text-gray-800">Clients ({clients.length})</h2>
        </div>

        {clients.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">No clients registered yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-6 py-3 text-left">Client</th>
                  <th className="px-6 py-3 text-left">Plan</th>
                  <th className="px-6 py-3 text-left">Status</th>
                  <th className="px-6 py-3 text-left">Joined</th>
                  <th className="px-6 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {clients.map((client) => (
                  <tr key={client.id} className="hover:bg-gray-50 transition">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 bg-blue-100 rounded-full flex items-center justify-center font-bold text-blue-600 text-sm">
                          {client.name[0].toUpperCase()}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">{client.name}</p>
                          <p className="text-xs text-gray-400">{client.email}</p>
                          {trialStatus(client)}
                        </div>
                      </div>
                    </td>

                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 rounded-lg text-xs font-medium ${PLAN_COLORS[client.plan] || 'bg-gray-100 text-gray-600'}`}>
                        {client.plan}
                      </span>
                    </td>

                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 rounded-lg text-xs font-medium ${client.isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>
                        {client.isActive ? 'Active' : 'Blocked'}
                      </span>
                    </td>

                    <td className="px-6 py-4 text-gray-400 text-xs">
                      {new Date(client.createdAt).toLocaleDateString()}
                    </td>

                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2 justify-end flex-wrap">
                        <button
                          onClick={() => handleToggleBlock(client.id)}
                          disabled={actionId === client.id}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                            client.isActive
                              ? 'bg-red-50 text-red-600 hover:bg-red-100'
                              : 'bg-green-50 text-green-600 hover:bg-green-100'
                          }`}
                        >
                          {client.isActive ? 'Block' : 'Unblock'}
                        </button>

                        {client.plan !== 'premium' && (
                          <button
                            onClick={() => handlePlan(client.id, 'premium')}
                            disabled={actionId === client.id}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-50 text-blue-600 hover:bg-blue-100 transition"
                          >
                            Set Premium
                          </button>
                        )}

                        {client.plan !== 'suspended' && (
                          <button
                            onClick={() => handlePlan(client.id, 'suspended')}
                            disabled={actionId === client.id}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-orange-50 text-orange-600 hover:bg-orange-100 transition"
                          >
                            Suspend
                          </button>
                        )}

                        {deleteConfirm === client.id ? (
                          <>
                            <button
                              onClick={() => handleDelete(client.id)}
                              disabled={actionId === client.id}
                              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-600 text-white hover:bg-red-700 transition"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setDeleteConfirm(null)}
                              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setDeleteConfirm(client.id)}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 text-gray-500 hover:bg-red-50 hover:text-red-600 transition"
                          >
                            Delete
                          </button>
                        )}
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
