/**
 * The three small shapes the console's stat tiles draw: a trend line, a row of
 * daily bars, and a share meter.
 *
 * Hand-drawn rather than handed to Recharts. The chart library is already in the
 * bundle for the Overview screen's real charts, but it is 390kB in its own chunk
 * and these are a polyline, thirty `div`s and a rounded bar — a directory screen
 * should not pull a charting library across the wire to draw a 40px sparkline.
 *
 * All three are decorative summaries of a number that is also written out beside
 * them, so they are `aria-hidden` and carry no axes, ticks or tooltips.
 */

/**
 * A trend line with the area under it filled.
 *
 * `preserveAspectRatio="none"` lets one SVG stretch to any tile width, which
 * would also stretch the stroke — `vector-effect` is what keeps the line 1.5px
 * wide instead of 1.5px times whatever the horizontal scale turned out to be.
 */
export function Sparkline({ values, className = 'text-primary-500' }) {
  if (values.length < 2) return null;

  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const x = (i) => (i / (values.length - 1)) * 100;
  const y = (value) => 100 - ((value - min) / span) * 92 - 4;

  const line = values.map((value, i) => `${x(i).toFixed(2)},${y(value).toFixed(2)}`).join(' ');

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className={`w-full h-10 sm:h-12 ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      <polygon points={`0,100 ${line} 100,100`} fill="currentColor" opacity="0.12" />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * One bar per day, the most recent picked out in navy.
 *
 * Every bar keeps a visible stub at zero: a day with no signups is a fact worth
 * showing, and a row of gaps reads as a broken chart rather than a quiet week.
 */
export function DayBars({ values }) {
  const max = Math.max(...values, 1);

  return (
    <div className="flex items-end gap-px h-10 sm:h-12" aria-hidden="true">
      {values.map((value, i) => (
        <span
          // Positional by nature — these are "n days ago", not identified things.
          // eslint-disable-next-line react/no-array-index-key
          key={i}
          className={`flex-1 rounded-t-sm ${i === values.length - 1 ? 'bg-navy-900' : 'bg-primary-200'}`}
          style={{ height: `${Math.max(8, (value / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

/** A share of a whole, as one bar. */
export function Meter({ percent }) {
  return (
    <div className="h-2 rounded-full bg-gray-100 overflow-hidden" aria-hidden="true">
      <div
        className="h-full rounded-full bg-primary-600"
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </div>
  );
}
