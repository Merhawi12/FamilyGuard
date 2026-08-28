import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { PRIMARY } from '../brand';

/**
 * The dashboard's "Screen time this week" bars.
 *
 * This lives in its own file so it can be `lazy()`-loaded — see Dashboard.jsx.
 * Recharts is 390 kB in its own chunk, and while the page imported it directly
 * nothing on the dashboard could paint until all of it had arrived: the stat
 * tiles, the child list and the alert feed all waited on a charting library
 * none of them use. Splitting it here is what lets those render first.
 *
 * Two rules keep that working. Nothing else belongs in this file — anything
 * added alongside the chart is pulled behind the same 390 kB this exists to
 * defer. And `height` is a prop rather than a constant exported from here,
 * because the placeholder Dashboard shows while this chunk is loading has to
 * reserve the same height, and importing it from this module would drag recharts
 * back into the page's own chunk for the sake of one number.
 */
export default function WeeklyUsageChart({ data, height }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      {/*
        `left: 0`, not the negative margin that was here.

        A negative left margin is the usual recharts trick for closing the gap
        between the axis and the bars, and it does it by moving the whole chart
        left — including the tick labels, which are then cut off by the edge of
        the SVG. With `width={44}` and `left: -20` the labels had 24px, so a
        four-figure value lost its leading digits *silently*: a week where the
        axis ran to 140 minutes drew "140m, 105m, 70m, 35m, 0m" as
        "0m, 5m, 0m, 5m, 0m". Not a clipped label — a wrong number, in the same
        shape as a right one, on the screen a parent uses to judge how long their
        child has been on a phone.
      */}
      <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9ca3af' }} />
        {/* Wide enough for a whole day: "1440m" is the longest label possible. */}
        <YAxis unit="m" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9ca3af' }} width={46} />
        <Tooltip
          cursor={{ fill: '#f3f4f6' }}
          formatter={(v) => [`${v} min`, 'Screen time']}
          contentStyle={{ borderRadius: 12, border: '1px solid #f3f4f6', fontSize: 12 }}
        />
        <Bar dataKey="minutes" fill={PRIMARY} radius={[6, 6, 0, 0]} maxBarSize={40} />
      </BarChart>
    </ResponsiveContainer>
  );
}
