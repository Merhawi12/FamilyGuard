import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import {
  children as childrenApi, reports as reportsApi,
  alertLabel, Avatar, EmptyState, Icon, StatsCard, useSocket,
} from '@parentix/shared';
import PageIntro from '../components/PageIntro';
import { PRIMARY } from '../brand';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const SEVERITY_DOT = { high: 'bg-danger', medium: 'bg-warning', low: 'bg-success' };

function formatMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function Dashboard() {
  const [childList, setChildList] = useState([]);
  // Shared with the bell and the Alerts page, so the counts here cannot drift
  // from what the rest of the dashboard shows — and it saves a second fetch.
  const { alerts: alertList } = useSocket();
  const [weeklyUsage, setWeeklyUsage] = useState([]);
  const [todayMinutes, setTodayMinutes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    childrenApi.list()
      .then(async (c) => {
        const children = Array.isArray(c.data) ? c.data : [];
        setChildList(children);

        if (children.length === 0) return;

        const weeklyReports = await Promise.all(
          children.map((child) => reportsApi.weekly(child.id).catch(() => null))
        );

        const minutesByDay = {};
        weeklyReports.forEach((r) => {
          const breakdown = r?.data?.dailyBreakdown;
          if (!breakdown) return;
          Object.entries(breakdown).forEach(([day, minutes]) => {
            minutesByDay[day] = (minutesByDay[day] || 0) + minutes;
          });
        });

        const today = new Date();
        const days = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date(today);
          d.setDate(d.getDate() - i);
          const key = d.toISOString().split('T')[0];
          days.push({ day: DAY_LABELS[d.getDay()], minutes: minutesByDay[key] || 0 });
        }
        setWeeklyUsage(days);
        setTodayMinutes(days[days.length - 1].minutes);
      })
      .catch((err) => {
        console.error('[Dashboard] fetch error:', err.message);
        setError(err.message || 'Failed to load data');
      })
      .finally(() => setLoading(false));
  }, []);

  const totalDevices = childList.reduce((s, c) => s + (c.devices?.length || 0), 0);
  const unreadAlerts = alertList.filter((a) => !a.isRead).length;

  if (loading) return <p className="text-sm text-gray-400 py-8">Loading your dashboard…</p>;

  if (error) {
    return (
      <div className="card">
        <EmptyState
          icon="warning"
          title="Unable to reach the server"
          description={error}
          action={
            <button onClick={() => window.location.reload()} className="btn-primary">
              Try again
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageIntro description="An overview of your family's digital activity." />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <Link to="/dashboard/children" className="block">
          <StatsCard icon="children" title="Children" value={childList.length} color="primary" />
        </Link>
        <Link to="/dashboard/children" className="block">
          <StatsCard icon="phone" title="Devices" value={totalDevices} color="green" />
        </Link>
        <Link to="/dashboard/alerts" className="block">
          <StatsCard icon="bell" title="Unread alerts" value={unreadAlerts} color="red" />
        </Link>
        <Link to="/dashboard/screen-time" className="block">
          <StatsCard
            icon="clock"
            title="Screen time"
            value={formatMinutes(todayMinutes)}
            subtitle="Today"
            color="amber"
          />
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">
        <div className="card">
          <h2 className="section-title mb-4">Screen time this week</h2>
          {weeklyUsage.length === 0 ? (
            <EmptyState
              compact
              icon="clock"
              title="Nothing recorded yet"
              description="Usage appears once a linked device starts reporting."
            />
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={weeklyUsage} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9ca3af' }} />
                <YAxis unit="m" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9ca3af' }} width={44} />
                <Tooltip
                  cursor={{ fill: '#f3f4f6' }}
                  formatter={(v) => [`${v} min`, 'Screen time']}
                  contentStyle={{ borderRadius: 12, border: '1px solid #f3f4f6', fontSize: 12 }}
                />
                <Bar dataKey="minutes" fill={PRIMARY} radius={[6, 6, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="card">
          <div className="flex items-center justify-between gap-3 mb-4">
            <h2 className="section-title">Children</h2>
            <Link to="/dashboard/children" className="text-sm font-medium text-primary-600 hover:underline">
              Manage
            </Link>
          </div>

          {childList.length === 0 ? (
            <EmptyState
              compact
              icon="children"
              title="No children yet"
              description="Add a child profile to start monitoring their devices."
              action={<Link to="/dashboard/children" className="btn-primary">Add a child</Link>}
            />
          ) : (
            <div className="space-y-2">
              {childList.map((child) => (
                <Link
                  key={child.id}
                  to="/dashboard/children"
                  className="list-row bg-gray-50 hover:bg-gray-100"
                >
                  <Avatar name={child.name} imageUrl={child.avatarUrl} size="sm" />
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium text-sm text-gray-900 truncate">{child.name}</span>
                    <span className="block text-xs text-gray-500">
                      {child.devices?.length || 0} device{child.devices?.length === 1 ? '' : 's'}
                    </span>
                  </span>
                  {child.age ? <span className="badge-primary">Age {child.age}</span> : null}
                  <Icon name="chevronRight" size={16} className="text-gray-300" />
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="section-title">Recent alerts</h2>
          <Link to="/dashboard/alerts" className="text-sm font-medium text-primary-600 hover:underline">
            View all
          </Link>
        </div>

        {alertList.length === 0 ? (
          <EmptyState
            compact
            icon="shieldCheck"
            title="All quiet"
            description="Safety alerts from your children's devices will show up here."
          />
        ) : (
          <div className="space-y-2">
            {alertList.slice(0, 5).map((a) => (
              <div
                key={a.id}
                className={`flex items-start gap-3 p-3 rounded-xl ${!a.isRead ? 'bg-primary-50' : 'bg-gray-50'}`}
              >
                <span className={`w-2 h-2 rounded-full shrink-0 mt-1.5 ${SEVERITY_DOT[a.severity] || SEVERITY_DOT.low}`} />
                <div className="min-w-0">
                  <p className="text-sm text-gray-900">{a.message}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {alertLabel(a.type)} · {new Date(a.createdAt).toLocaleString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
