import { BarChart, DonutChart } from '@parentix/shared';

/**
 * The Overview screen's two growth charts: signups over the last thirty days,
 * and the plan mix.
 *
 * In its own file so Overview can `lazy()` it — the console opens on the alert
 * panel, and these sit below it. Nothing else belongs here, or it is deferred
 * behind the charts for no reason.
 *
 * The colours are the console's own, not the family app's teal series: this is
 * the navy product, and `#2563eb` is what every other blue on these screens
 * resolves to.
 */
const COLORS = ['#2563eb', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export default function GrowthCharts({ signups, byPlan, height }) {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-5">
      <div className="card">
        <h2 className="section-title mb-4">Signups (last 30 days)</h2>
        {/* `yWidth` has to fit the widest count the axis will print. When this
            was Recharts a negative left margin moved the tick labels off the
            edge of the SVG, where they were cut rather than shrunk, and a
            three-figure signup count drew as its last two digits. Same trap as
            the family app's screen-time chart. */}
        <BarChart
          data={signups}
          xKey="date"
          yKey="count"
          height={height}
          color="#2563eb"
          maxBarSize={32}
          yWidth={40}
          allowDecimals={false}
          valueLabel="Signups"
          ariaLabel="New signups per day over the last 30 days"
        />
      </div>

      <div className="card">
        <h2 className="section-title mb-4">Users by plan</h2>
        <DonutChart
          data={byPlan}
          dataKey="count"
          nameKey="plan"
          colors={COLORS}
          height={height}
          formatValue={(v) => v.toLocaleString()}
          centerLabel="Users"
          ariaLabel="Users by plan"
        />
      </div>
    </div>
  );
}
