import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { children as childrenApi, alerts as alertsApi } from '../services/api';
import StatsCard from '../components/StatsCard';

export default function Dashboard() {
  const [childList, setChildList] = useState([]);
  const [alertList, setAlertList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([childrenApi.list(), alertsApi.list()])
      .then(([c, a]) => {
        setChildList(Array.isArray(c.data) ? c.data : []);
        setAlertList(Array.isArray(a.data) ? a.data : []);
      })
      .catch((err) => {
        console.error('[Dashboard] fetch error:', err.message);
        setError(err.message || 'Failed to load data');
      })
      .finally(() => setLoading(false));
  }, []);

  const totalDevices = childList.reduce((s, c) => s + (c.devices?.length || 0), 0);
  const unreadAlerts = alertList.filter((a) => !a.isRead).length;

  const sampleUsage = [
    { day: 'Mon', minutes: 85 }, { day: 'Tue', minutes: 120 },
    { day: 'Wed', minutes: 60 }, { day: 'Thu', minutes: 95 },
    { day: 'Fri', minutes: 140 }, { day: 'Sat', minutes: 180 }, { day: 'Sun', minutes: 110 },
  ];

  if (loading) return <div className="text-gray-400 text-sm p-4">Loading...</div>;
  if (error) return (
    <div className="p-6">
      <div className="bg-red-50 border border-red-200 rounded-xl p-4">
        <p className="text-red-700 font-medium text-sm">Unable to connect to the server</p>
        <p className="text-red-500 text-xs mt-1">{error}</p>
        <button onClick={() => window.location.reload()} className="mt-3 text-sm text-red-600 underline">Retry</button>
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl md:text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-500 text-sm mt-1">Overview of your family's digital activity</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <StatsCard icon="👨‍👩‍👧" title="Children" value={childList.length} color="blue" />
        <StatsCard icon="📱" title="Devices" value={totalDevices} color="green" />
        <StatsCard icon="🔔" title="Unread Alerts" value={unreadAlerts} color="red" />
        <StatsCard icon="⏱️" title="Avg. Screen Time" value="2h 15m" subtitle="Today" color="yellow" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
        <div className="card">
          <h2 className="font-semibold mb-4 text-sm md:text-base">Screen Time This Week</h2>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={sampleUsage}>
              <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fontSize: 11 }} />
              <YAxis unit="m" axisLine={false} tickLine={false} tick={{ fontSize: 11 }} width={35} />
              <Tooltip formatter={(v) => [`${v} min`]} />
              <Bar dataKey="minutes" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <h2 className="font-semibold mb-4 text-sm md:text-base">Children</h2>
          {childList.length === 0 ? (
            <div className="text-center py-8">
              <span className="text-4xl">👧</span>
              <p className="text-gray-400 text-sm mt-2">No children added yet</p>
              <a href="/dashboard/children" className="text-blue-500 text-sm hover:underline mt-1 block">Add a child</a>
            </div>
          ) : (
            <div className="space-y-2">
              {childList.map((child) => (
                <div key={child.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                  <div className="w-9 h-9 md:w-10 md:h-10 bg-blue-100 rounded-full flex items-center justify-center font-bold text-blue-600 shrink-0">
                    {child.name[0]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{child.name}</p>
                    <p className="text-xs text-gray-400">{child.devices?.length || 0} device(s)</p>
                  </div>
                  <span className="badge-blue text-xs shrink-0">{child.age ? `Age ${child.age}` : 'No age'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h2 className="font-semibold mb-4 text-sm md:text-base">Recent Alerts</h2>
        {alertList.length === 0 ? (
          <p className="text-gray-400 text-sm">No alerts yet</p>
        ) : (
          <div className="space-y-2">
            {alertList.slice(0, 5).map((a) => (
              <div key={a.id} className={`flex items-start gap-3 p-3 rounded-xl ${!a.isRead ? 'bg-blue-50' : 'bg-gray-50'}`}>
                <span className="shrink-0 mt-0.5">{a.severity === 'high' ? '🔴' : a.severity === 'medium' ? '🟡' : '🟢'}</span>
                <div className="min-w-0">
                  <p className="text-sm">{a.message}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{new Date(a.createdAt).toLocaleString()}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
