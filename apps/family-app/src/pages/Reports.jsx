import { useEffect, useState } from 'react';
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { children as childrenApi, reports as reportsApi, EmptyState, errorMessage } from '@parentix/shared';
import ChildTabs from '../components/ChildTabs';
import PageIntro from '../components/PageIntro';
import { PRIMARY, SERIES } from '../brand';

const COLORS = SERIES;

const TOOLTIP_STYLE = { borderRadius: 12, border: '1px solid #f3f4f6', fontSize: 12 };

const formatHours = (minutes) => {
  const hours = minutes / 60;
  return hours >= 10 || Number.isInteger(hours) ? `${Math.round(hours)}h` : `${hours.toFixed(1)}h`;
};

export default function Reports() {
  const [childList, setChildList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [weekly, setWeekly] = useState(null);
  const [daily, setDaily] = useState(null);
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    childrenApi.list()
      .then((r) => { setChildList(r.data); if (r.data[0]) setSelected(r.data[0]); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setError('');
    // A null report renders as empty charts, which reads as "this child used
    // nothing all week" — a claim about the child rather than about the request
    // that failed. The two are told apart here.
    Promise.all([
      reportsApi.weekly(selected.id).then((r) => setWeekly(r.data)),
      reportsApi.daily(selected.id, selectedDate).then((r) => setDaily(r.data)),
    ]).catch((err) => {
      setWeekly(null);
      setDaily(null);
      setError(errorMessage(err, 'Could not load reports.'));
    });
  }, [selected, selectedDate]);

  /**
   * Every day of the reported week, including the ones with nothing in them.
   *
   * `dailyBreakdown` only carries days that have activity, and plotting it
   * directly drew a bar chart of three evenly-spaced bars for a week with three
   * reported days — a chart that looks like steady use and is actually four
   * silent days with the gaps closed up. Filling the window makes the quiet days
   * visible as what they are.
   */
  const weeklyChartData = (() => {
    if (!weekly) return [];
    const out = [];
    const cursor = new Date(`${weekly.period.from}T00:00:00Z`);
    const last = new Date(`${weekly.period.to}T00:00:00Z`);
    while (cursor <= last) {
      const key = cursor.toISOString().split('T')[0];
      out.push({ date: key.slice(5), minutes: Math.round(weekly.dailyBreakdown[key] || 0) });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return out;
  })();

  /**
   * Averaged over the days that were actually recorded, and labelled as such.
   *
   * This divided the week's total by seven unconditionally. A family who linked
   * a phone yesterday saw their one real day reported as a "daily average" one
   * seventh its true size — the number is on this screen to inform a decision
   * about a child's screen time, and it was understating it by up to 7×
   * precisely when the account was newest.
   */
  const recordedDays = weekly ? Object.keys(weekly.dailyBreakdown).length : 0;
  const averageMinutes = recordedDays ? weekly.totalMinutes / recordedDays : 0;

  const categoryData = daily
    ? Object.entries(daily.byCategory).map(([name, value]) => ({ name: name.replace('_', ' '), value: Math.round(value) }))
    : [];

  const topApps = daily
    ? Object.entries(daily.byApp).sort((a, b) => b[1] - a[1]).slice(0, 8)
    : [];

  return (
    <div className="space-y-5">
      <PageIntro description="Usage summaries and trends for each child." />

      <ChildTabs items={childList} selectedId={selected?.id} onSelect={setSelected} />

      {loading ? (
        <p className="text-sm text-gray-400 py-8">Loading reports…</p>
      ) : childList.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="children"
            title="No child profiles yet"
            description="Add a child under Children to start building reports."
          />
        </div>
      ) : error ? (
        <div className="card">
          <EmptyState icon="warning" title="Could not load reports" description={error} />
        </div>
      ) : !weekly ? (
        <div className="card">
          <EmptyState
            icon="reports"
            title="No report yet"
            description="Reports build up once a linked device starts reporting usage."
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
            <div className="card p-4 text-center">
              <p className="text-2xl sm:text-3xl font-bold text-primary-600">{formatHours(weekly.totalMinutes)}</p>
              <p className="text-xs sm:text-sm text-gray-500 mt-1">This week</p>
            </div>
            <div className="card p-4 text-center">
              <p className="text-2xl sm:text-3xl font-bold text-green-600">{formatHours(averageMinutes)}</p>
              <p className="text-xs sm:text-sm text-gray-500 mt-1">
                {recordedDays === 1 ? 'On the one day recorded' : `Average of ${recordedDays} recorded days`}
              </p>
            </div>
            <div className="card p-4 text-center col-span-2 sm:col-span-1">
              <p className="text-lg sm:text-xl font-bold text-purple-600 truncate">
                {weekly.topApps?.[0]?.[0] || '—'}
              </p>
              <p className="text-xs sm:text-sm text-gray-500 mt-1">Most used app</p>
            </div>
          </div>

          <div className="card">
            <h2 className="section-title mb-4">Screen time by day</h2>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={weeklyChartData} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
                <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9ca3af' }} />
                <YAxis unit="m" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9ca3af' }} width={48} />
                <Tooltip cursor={{ fill: '#f3f4f6' }} contentStyle={TOOLTIP_STYLE} />
                <Bar dataKey="minutes" fill={PRIMARY} radius={[6, 6, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="card">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <h2 className="section-title">Daily breakdown</h2>
              <input
                type="date"
                className="input w-auto"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                aria-label="Report date"
              />
            </div>

            {!daily || daily.totalMinutes === 0 ? (
              <EmptyState compact icon="calendar" title="Nothing recorded that day" />
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div>
                  <p className="text-sm text-gray-500 mb-3">
                    Total: <span className="font-semibold text-gray-900">{Math.round(daily.totalMinutes)} min</span>
                  </p>
                  <div className="space-y-2.5">
                    {topApps.map(([app, min]) => (
                      <div key={app}>
                        <div className="flex items-baseline justify-between gap-3 mb-1">
                          <span className="text-sm text-gray-700 truncate">{app}</span>
                          <span className="text-xs text-gray-500 shrink-0">{Math.round(min)}m</span>
                        </div>
                        <div className="bg-gray-100 rounded-full h-1.5">
                          <div
                            className="bg-primary-500 h-1.5 rounded-full"
                            style={{ width: `${Math.min(100, (min / daily.totalMinutes) * 100)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {categoryData.length > 0 && (
                  <div>
                    <ResponsiveContainer width="100%" height={220}>
                      <PieChart>
                        <Pie
                          data={categoryData} dataKey="value" nameKey="name"
                          cx="50%" cy="45%" outerRadius="75%" innerRadius="45%" paddingAngle={2}
                        >
                          {categoryData.map((entry, i) => (
                            <Cell key={entry.name} fill={COLORS[i % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [`${v} min`]} />
                        <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
