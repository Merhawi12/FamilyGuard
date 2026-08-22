import { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  children as childrenApi, reports as reportsApi,
  alertLabel, lastLocalDays, formatMinutes, Avatar, EmptyState, Icon, StatsCard, useSocket,
} from '@parentix/shared';
import PageIntro from '../components/PageIntro';

/**
 * The only thing on this screen that needs a charting library, kept out of the
 * page's own chunk.
 *
 * Recharts is 390 kB, and importing it here made every other card on the
 * dashboard — the four tiles, the child list, the alert feed — wait for it
 * before any of them could paint. This is the screen a parent lands on after
 * signing in, and none of what they came for is the bar chart.
 */
const WeeklyUsageChart = lazy(() => import('../components/WeeklyUsageChart'));

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Held by the placeholder too, so the card does not jump as the chart lands. */
const CHART_HEIGHT = 180;

const SEVERITY_DOT = { high: 'bg-danger', medium: 'bg-warning', low: 'bg-success' };

export default function Dashboard() {
  const [childList, setChildList] = useState([]);
  // Shared with the bell and the Alerts page, so the counts here cannot drift
  // from what the rest of the dashboard shows — and it saves a second fetch.
  const { alerts: alertList } = useSocket();
  const [weeklyUsage, setWeeklyUsage] = useState([]);
  const [todayMinutes, setTodayMinutes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  /**
   * Two requests, side by side, and neither waits on the other.
   *
   * This screen used to list the children, then fan out one `/reports/:id/weekly`
   * call per child and sum the results here — so the chart could not begin
   * loading until the child list had arrived, and a family with four children
   * paid five serial round trips to draw seven bars. `/reports/weekly` returns
   * the same sum from one query, and it does not need the child list to do it,
   * so both requests now leave together and the screen renders when the slower
   * one lands rather than after a chain of them.
   */
  useEffect(() => {
    Promise.all([
      childrenApi.list(),
      // The chart is the least important thing here: a parent opens this screen
      // for the alert count and the child list. So a failed report is absorbed
      // rather than failing the whole screen, and the week draws flat — which is
      // exactly what happened before, when each of the per-child calls carried
      // its own `.catch(() => null)`.
      reportsApi.familyWeekly().catch(() => null),
    ])
      .then(([childResponse, weeklyResponse]) => {
        const children = Array.isArray(childResponse.data) ? childResponse.data : [];
        setChildList(children);

        // An account with no children has no week to draw. Left as an empty
        // array so the card below keeps showing its empty state rather than
        // seven bars of zero, which reads as "nothing happened this week"
        // instead of "there is nobody to report on yet".
        if (children.length === 0) return;

        const minutesByDay = weeklyResponse?.data?.dailyBreakdown || {};

        /**
         * Keyed on the local calendar day, not the UTC one.
         *
         * This built each key with `toISOString()`, which is UTC — so every
         * evening after about 20:00 local the key for "today" was tomorrow's
         * date, and the tile below reported 0 minutes for the rest of the night
         * while the whole chart slid one label to the left. The server files a
         * day's usage under the local midnight the device reported, so a local
         * key is the one that matches it. See shared/dates.js.
         */
        const days = lastLocalDays(7).map(({ key, date }) => ({
          day: DAY_LABELS[date.getDay()],
          minutes: minutesByDay[key] || 0,
        }));
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
            // The fallback is empty rather than a spinner, and exactly the
            // chart's height: this card sits above the child list, so anything
            // that changed size here would shove the rest of the page down as
            // the chunk lands. An empty box for a fraction of a second reads as
            // a chart still drawing; a jumping page does not.
            <Suspense fallback={<div style={{ height: CHART_HEIGHT }} aria-hidden="true" />}>
              <WeeklyUsageChart data={weeklyUsage} height={CHART_HEIGHT} />
            </Suspense>
          )}
        </div>

        <div className="card">
          <div className="flex items-center justify-between gap-3 mb-4">
            <h2 className="section-title">Children</h2>
            <Link to="/dashboard/children" className="link-action">
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
          <Link to="/dashboard/alerts" className="link-action">
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
