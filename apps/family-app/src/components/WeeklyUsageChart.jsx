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
      <BarChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
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
  );
}
