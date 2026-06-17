import { useEffect, useState } from 'react';
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { admin as adminApi } from '../../services/api';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export default function AdminOverview() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    adminApi.getAnalytics().then((r) => setData(r.data)).catch((e) => setError(e.response?.data?.error || 'Failed to load analytics'));
  }, []);

  if (error) return <div className="p-4 bg-red-50 text-red-700 rounded-xl text-sm">{error}</div>;
  if (!data) return <div className="text-gray-400">Loading analytics...</div>;

  const signupData = Object.entries(data.signupsByDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date: date.slice(5), count }));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 md:gap-4">
        <div className="card text-center">
          <p className="text-2xl font-bold text-blue-600">{data.totalUsers}</p>
          <p className="text-xs text-gray-500 mt-1">Total Users</p>
        </div>
        <div className="card text-center">
          <p className="text-2xl font-bold text-green-600">{data.activeSessions}</p>
          <p className="text-xs text-gray-500 mt-1">Active Sessions</p>
        </div>
        <div className="card text-center">
          <p className="text-2xl font-bold text-purple-600">${data.totalRevenue.toFixed(2)}</p>
          <p className="text-xs text-gray-500 mt-1">Total Revenue</p>
        </div>
        <div className="card text-center">
          <p className="text-2xl font-bold text-orange-600">{data.mfaAdoptionRate}%</p>
          <p className="text-xs text-gray-500 mt-1">MFA Adoption</p>
        </div>
        <div className="card text-center">
          <p className="text-2xl font-bold text-pink-600">{signupData.reduce((s, d) => s + d.count, 0)}</p>
          <p className="text-xs text-gray-500 mt-1">Signups (30d)</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h2 className="font-semibold mb-4">Signups (last 30 days)</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={signupData}>
              <XAxis dataKey="date" axisLine={false} tickLine={false} />
              <YAxis axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <h2 className="font-semibold mb-4">Users by Plan</h2>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={data.byPlan} dataKey="count" nameKey="plan" cx="50%" cy="50%" outerRadius={70} label>
                {data.byPlan.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
