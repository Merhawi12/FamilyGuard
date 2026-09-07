import { useState } from 'react';

/**
 * A share-of-the-whole ring: the console's plan mix, the family app's screen
 * time by category.
 *
 * Hand-drawn for the reason set out at the top of BarChart.jsx — and drawn the
 * way the Billing screen's plan ring already was, with `stroke-dasharray`
 * arithmetic on concentric circles. Two or three segments is a subtraction; it
 * does not need an arc generator, and it certainly does not need d3-shape.
 *
 * ── The centre, instead of a floating tooltip ────────────────────────────────
 *
 * Recharts put the hovered segment in a tooltip that followed the pointer. The
 * hole in the middle of a donut is a better place for it: it is already empty,
 * it never covers the segment being read, and it gives the chart something to
 * say when nothing is hovered at all — the total, which was previously written
 * nowhere. On a touch screen this matters more than a nicety, since there is no
 * hover state to show a tooltip with; tapping a segment holds it there.
 */

/** The ring's geometry, in the 100×100 user space of the viewBox below. */
const CENTER = 50;
/** Midway between the 45% inner and 75% outer radii the Recharts version used. */
const RADIUS = 30;
const THICKNESS = 15;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** The gap between segments, as the 2° of `paddingAngle` this replaces. */
const GAP = (2 / 360) * CIRCUMFERENCE;

/**
 * @param {object} props
 * @param {object[]} props.data one entry per segment.
 * @param {string} props.dataKey the field holding a segment's value.
 * @param {string} props.nameKey the field holding a segment's label.
 * @param {string[]} props.colors cycled if there are more segments than colours.
 * @param {number|string} [props.height] the whole control, ring and legend.
 * @param {(value: number) => string} [props.formatValue] the value as text.
 * @param {string} [props.centerLabel] the caption under the total in the middle.
 * @param {string} [props.ariaLabel]
 */
export default function DonutChart({
  data,
  dataKey,
  nameKey,
  colors,
  height = 220,
  formatValue = (value) => String(value),
  centerLabel = 'Total',
  ariaLabel,
}) {
  const [active, setActive] = useState(null);

  const segments = data
    .map((entry, i) => ({
      name: String(entry[nameKey] ?? ''),
      value: Number(entry[dataKey]) || 0,
      color: colors[i % colors.length],
    }))
    // A zero-value segment has no arc to draw and would still take a gap out of
    // the ring, leaving a notch that looks like a rendering fault.
    .filter((segment) => segment.value > 0);

  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  if (total === 0) return null;

  // Only worth separating the segments when there is more than one; a single
  // full-circle segment with a gap in it reads as 98% of something.
  const gap = segments.length > 1 ? GAP : 0;

  let offset = 0;
  const arcs = segments.map((segment) => {
    const length = (segment.value / total) * CIRCUMFERENCE;
    const arc = { ...segment, length: Math.max(length - gap, 0.5), offset };
    offset += length;
    return arc;
  });

  const shown = active !== null ? arcs[active] : null;

  return (
    <div style={{ height }} className="flex w-full flex-col items-center gap-3">
      <div className="relative min-h-0 flex-1">
        <svg
          viewBox="0 0 100 100"
          className="h-full"
          role="img"
          aria-label={
            ariaLabel
            || `${segments.length} ${segments.length === 1 ? 'category' : 'categories'}: ${
              segments.map((s) => `${s.name} ${formatValue(s.value)}`).join(', ')
            }`
          }
        >
          {/* -90° so the first segment starts at twelve o'clock, which is where
              a reader expects a ring to begin. */}
          <g transform={`rotate(-90 ${CENTER} ${CENTER})`}>
            {arcs.map((arc, i) => (
              <circle
                key={arc.name}
                cx={CENTER}
                cy={CENTER}
                r={RADIUS}
                fill="none"
                stroke={arc.color}
                strokeWidth={THICKNESS}
                strokeDasharray={`${arc.length} ${CIRCUMFERENCE - arc.length}`}
                strokeDashoffset={-arc.offset}
                className="cursor-pointer transition-opacity"
                // Dimmed rather than highlighted: raising one segment changes
                // its apparent size, and the whole point of the shape is that
                // areas are comparable.
                opacity={active === null || active === i ? 1 : 0.35}
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive((current) => (current === i ? null : current))}
              />
            ))}
          </g>
        </svg>

        {/* The middle. `pointer-events-none` so it never steals the hover from
            the segment underneath it — the ring is only 15 units thick and the
            text box overlaps it at the corners. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
          <span className="text-base font-bold leading-tight text-gray-900 tabular-nums">
            {formatValue(shown ? shown.value : total)}
          </span>
          <span className="mt-0.5 line-clamp-2 text-[11px] leading-tight text-gray-500">
            {shown ? shown.name : centerLabel}
          </span>
        </div>
      </div>

      <ul className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1">
        {segments.map((segment, i) => (
          <li
            key={segment.name}
            className="flex cursor-default items-center gap-1.5 text-xs text-gray-600"
            onPointerEnter={() => setActive(i)}
            onPointerLeave={() => setActive((current) => (current === i ? null : current))}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: segment.color }}
              aria-hidden="true"
            />
            {segment.name}
          </li>
        ))}
      </ul>
    </div>
  );
}
