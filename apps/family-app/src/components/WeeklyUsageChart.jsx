import { BarChart } from '@parentix/shared';
import { PRIMARY } from '../brand';

/**
 * The dashboard's "Screen time this week" bars.
 *
 * This lives in its own file so it can be `lazy()`-loaded — see Dashboard.jsx.
 * That mattered a great deal more when the chart was Recharts: 390 kB had to
 * arrive before the stat tiles, the child list and the alert feed could paint,
 * none of which use a charting library. The chart is a few hundred bytes of
 * shared code now (see packages/shared/src/charts/BarChart.jsx), but the split
 * is kept because it still costs nothing and the ordering is still right — the
 * chart is the least urgent thing on this screen.
 *
 * Two rules keep that working. Nothing else belongs in this file. And `height`
 * is a prop rather than a constant exported from here, because the placeholder
 * Dashboard shows while this chunk is loading has to reserve the same height.
 */
export default function WeeklyUsageChart({ data, height }) {
  return (
    <BarChart
      data={data}
      xKey="day"
      yKey="minutes"
      height={height}
      color={PRIMARY}
      maxBarSize={40}
      /*
        Wide enough for a whole day: "1440m" is the longest label possible.

        This is the number the old Recharts axis got wrong. `width={44}` with a
        negative left margin left the labels 24px, so a week running to 140
        minutes drew "140m, 105m, 70m, 35m, 0m" as "0m, 5m, 0m, 5m, 0m" — not a
        clipped label but a wrong number, in the same shape as a right one, on
        the screen a parent uses to judge how long their child has been on a
        phone. The labels are real text in the document flow now, so a value too
        wide for this box overflows visibly instead of being silently cropped.
      */
      yWidth={46}
      unit="m"
      formatValue={(v) => `${v} min`}
      valueLabel="Screen time"
      ariaLabel="Screen time per day this week, in minutes"
    />
  );
}
