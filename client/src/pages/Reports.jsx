import { useEffect, useState } from 'react';
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { children as childrenApi, reports as reportsApi } from '../services/api';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

export default function Reports() {
  const [childList, setChildList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [weekly, setWeekly] = useState(null);
  const [daily, setDaily] = useState(null);
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);

  useEffect(() => { childrenApi.list().then((r) => { setChildList(r.data); if (r.data[0]) setSelected(r.data[0]); }); }, []);

  useEffect(() => {
    if (!selected) return;
    reportsApi.weekly(selected.id).then((r) => setWeekly(r.data));
    reportsApi.daily(selected.id, selectedDate).then((r) => setDaily(r.data));
  }, [selected, selectedDate]);

  const weeklyChartData = weekly
    ? Object.entries(weekly.dailyBreakdown).map(([date, min]) => ({ date: date.slice(5), minutes: Math.round(min) }))
    : [];

  const categoryData = daily
    ? Object.entries(daily.byCategory).map(([name, value]) => ({ name: name.replace('_', ' '), value: Math.round(value) }))
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Reports</h1>
        <p className="text-gray-500 text-sm mt-1">Usage summaries and trends</p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {childList.map((c) => (
          <button key={c.id} onClick={() => setSelected(c)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition ${selected?.id === c.id ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 hover:bg-gray-50'}`}>
            {c.name}
          </button>
        ))}
      </div>

      {selected && weekly && (
        <>
          <div className="grid grid-cols-3 gap-4">
            <div className="card text-center">
              <p className="text-3xl font-bold text-blue-600">{Math.round(weekly.totalMinutes / 60)}h</p>
              <p className="text-sm text-gray-500 mt-1">Total this week</p>
            </div>
            <div className="card text-center">
              <p className="text-3xl font-bold text-green-600">{Math.round(weekly.totalMinutes / 7 / 60)}h</p>
              <p className="text-sm text-gray-500 mt-1">Daily average</p>
            </div>
            <div className="card text-center">
              <p className="text-3xl font-bold text-purple-600">{weekly.topApps?.[0]?.[0] || '—'}</p>
              <p className="text-sm text-gray-500 mt-1">Top app</p>
            </div>
          </div>

          <div className="card">
            <h2 className="font-semibold mb-4">Weekly Screen Time (minutes)</h2>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={weeklyChartData}>
                <XAxis dataKey="date" axisLine={false} tickLine={false} />
                <YAxis axisLine={false} tickLine={false} />
                <Tooltip />
                <Bar dataKey="minutes" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="card">
            <div className="flex justify-between items-center mb-4">
              <h2 className="font-semibold">Daily Breakdown</h2>
              <input type="date" className="input max-w-[180px]" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
            </div>
            {daily && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div>
                  <p className="text-sm text-gray-500 mb-2">Total: <span className="font-semibold">{Math.round(daily.totalMinutes)} min</span></p>
                  <div className="space-y-2">
                    {Object.entries(daily.byApp).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([app, min]) => (
                      <div key={app} className="flex items-center gap-3">
                        <span className="text-sm flex-1 truncate">{app}</span>
                        <div className="flex-1 bg-gray-100 rounded-full h-2">
                          <div className="bg-blue-500 h-2 rounded-full" style={{ width: `${Math.min(100, (min / daily.totalMinutes) * 100)}%` }} />
                        </div>
                        <span className="text-xs text-gray-500 w-12 text-right">{Math.round(min)}m</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <ResponsiveContainer width="100%" height={180}>
                    <PieChart>
                      <Pie data={categoryData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label>
                        {categoryData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                      </Pie>
                      <Tooltip />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
