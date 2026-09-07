import { useState } from 'react';
import { niceTicks, formatTick } from './ticks.js';

/**
 * The categorical bar chart all four of this platform's bar charts are drawn
 * with — screen time by day, signups by day, revenue by period.
 *
 * ── Why this is not Recharts ─────────────────────────────────────────────────
 *
 * It was. Recharts is 390 kB (105 kB gzipped) in its own chunk, and it was the
 * largest thing either web app shipped: bigger than React, the router, the API
 * client and every screen in the product put together. What it was drawing is
 * on this page — rectangles, two rows of text and a tooltip. The dependency
 * brought d3-scale, d3-shape, d3-array, d3-time, react-smooth, victory-vendor
 * and lodash with it to do that, and the Admin Dashboard paid the whole cost on
 * its landing screen.
 *
 * The precedent was already here: `MiniChart.jsx` in the console and
 * `PlanDistribution` on the Billing screen were both hand-drawn for exactly this
 * reason, each with a comment explaining that a sparkline should not cost 390 kB.
 * This finishes that argument rather than starting it.
 *
 * ── Why CSS boxes and not an SVG ─────────────────────────────────────────────
 *
 * An SVG chart has to know its own pixel width before it can place anything, so
 * it needs a ResizeObserver and a measure-then-paint pass — which is what
 * Recharts' `ResponsiveContainer` is, and why a chart in a flex row renders once
 * at the wrong size and then jumps. Percentage heights inside a flex row need no
 * measurement at all: the browser does the layout, the chart is correct on the
 * first paint, and it stays correct through a resize with no JavaScript running.
 *
 * It also keeps the labels honest. Both axes are real text in the document flow,
 * at their natural size, so they cannot be clipped by an SVG viewport — which is
 * the failure that made this app's screen-time axis draw "105m" as "5m" for a
 * year. A label that does not fit now wraps or ellipsises where it can be seen.
 */

/** Height reserved for the row of category labels under the plot. */
const X_AXIS_HEIGHT = 18;

/** Recharts' tick colour and size, kept so this swap is invisible. */
const TICK_STYLE = { fontSize: 11, color: '#9ca3af' };

/**
 * A bar chart.
 *
 * @param {object} props
 * @param {object[]} props.data one entry per bar, in the order they are drawn.
 * @param {string} props.xKey the field holding a bar's category label.
 * @param {string} props.yKey the field holding a bar's value.
 * @param {number|string} [props.height] any CSS height. Defaults to filling the
 *   parent, which is what the Billing card wants — it sits beside the plan mix
 *   and a fixed height would leave a band of empty card under whichever is
 *   shorter.
 * @param {string|((entry: object, index: number) => string)} [props.color] the
 *   bar fill. A function is called per bar, which is how the revenue trend picks
 *   the most recent period out in navy.
 * @param {number} [props.maxBarSize] widest a single bar may be drawn.
 * @param {number} [props.yWidth] width reserved for the value axis. Must fit the
 *   longest label it will produce; see the note on clipping above.
 * @param {string} [props.unit] appended to every value-axis label, e.g. `'m'`.
 * @param {(value: number) => string} [props.formatY] overrides `unit` for the
 *   axis labels — the revenue chart formats them as compact money.
 * @param {(value: number) => string} [props.formatValue] the value as it appears
 *   in the tooltip. Defaults to the axis formatting.
 * @param {string} [props.valueLabel] the tooltip's caption for the value.
 * @param {boolean} [props.allowDecimals] see `niceTicks`.
 * @param {number} [props.tickInterval] draw every (n+1)th category label, in
 *   Recharts' `interval` numbering: 0 is all of them, 1 is every other. A
 *   30-bucket axis cannot show 30 labels at any width a phone has.
 * @param {string} [props.ariaLabel] what the chart says as a whole.
 */
export default function BarChart({
  data,
  xKey,
  yKey,
  height = '100%',
  color = '#2563eb',
  maxBarSize = 40,
  yWidth = 46,
  unit = '',
  formatY,
  formatValue,
  valueLabel,
  allowDecimals = true,
  tickInterval = 0,
  ariaLabel,
}) {
  // Which bar the pointer or keyboard is on, as an index. `null` is "none", and
  // 0 is a real bar — so every check here is against null explicitly.
  const [active, setActive] = useState(null);

  const values = data.map((entry) => Number(entry[yKey]) || 0);
  const { ticks, axisMax } = niceTicks(Math.max(0, ...values), { allowDecimals });

  const labelFor = (value) => (formatY ? formatY(value) : `${formatTick(value)}${unit}`);
  const valueFor = (value) => (formatValue ? formatValue(value) : labelFor(value));

  const fillFor = (entry, i) => (typeof color === 'function' ? color(entry, i) : color);

  return (
    <div
      style={{ height }}
      className="relative w-full select-none"
      role="img"
      aria-label={
        ariaLabel
        || `${valueLabel || 'Value'} by ${xKey}, ${data.length} ${data.length === 1 ? 'bar' : 'bars'}`
      }
    >
      <div className="flex h-full w-full">
        {/* ── Value axis ──────────────────────────────────────────────────── */}
        <div
          // Hooked so the browser harness can measure whether a label fits the
          // box reserved for it — the failure that drew "105m" as "5m".
          data-chart-axis
          className="relative shrink-0"
          style={{ width: yWidth, marginBottom: X_AXIS_HEIGHT }}
          aria-hidden="true"
        >
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-1.5 tabular-nums whitespace-nowrap"
              style={{
                ...TICK_STYLE,
                bottom: `${(tick / axisMax) * 100}%`,
                // Half the line-height, so the label's centre sits on its
                // gridline rather than its baseline — the same alignment
                // Recharts uses, and the reason the 0 label is not cut off by
                // the bottom of the box.
                transform: 'translateY(50%)',
              }}
            >
              {labelFor(tick)}
            </span>
          ))}
        </div>

        {/* ── Plot ────────────────────────────────────────────────────────── */}
        <div className="relative min-w-0 flex-1">
          {/* Gridlines, one per tick, behind the bars. Recharts drew none by
              default and the axis labels floated unanchored beside the plot;
              these are what tie a label to the height it describes. */}
          <div
            className="absolute inset-x-0 top-0"
            style={{ bottom: X_AXIS_HEIGHT }}
            aria-hidden="true"
          >
            {ticks.map((tick) => (
              <span
                key={tick}
                className="absolute inset-x-0 border-t border-gray-100"
                style={{ bottom: `${(tick / axisMax) * 100}%` }}
              />
            ))}
          </div>

          <div className="flex h-full items-stretch">
            {data.map((entry, i) => {
              const value = Number(entry[yKey]) || 0;
              const label = String(entry[xKey] ?? '');
              // Recharts' `interval` numbering, so the call sites keep the value
              // they already worked out.
              const showLabel = tickInterval === 0 || i % (tickInterval + 1) === 0;

              return (
                <div
                  // Positional by nature: these are days and periods, not
                  // identified things, and two of them can carry the same label.
                  // eslint-disable-next-line react/no-array-index-key
                  key={i}
                  className="relative flex min-w-0 flex-1 flex-col"
                  onPointerEnter={() => setActive(i)}
                  onPointerLeave={() => setActive((current) => (current === i ? null : current))}
                >
                  {/* The hover band. Recharts drew this as `cursor={{ fill }}`
                      and it is the thing that makes a narrow bar hittable: the
                      whole column responds, not the few pixels of the bar. */}
                  <span
                    className="absolute inset-x-0 top-0 transition-colors"
                    style={{
                      bottom: X_AXIS_HEIGHT,
                      backgroundColor: active === i ? '#f3f4f6' : 'transparent',
                    }}
                    aria-hidden="true"
                  />

                  <div className="relative flex min-h-0 flex-1 items-end justify-center px-px">
                    <span
                      // A deliberate hook for scripts/browser-e2e.mjs, which has
                      // to be able to assert that a chart drew something. It used
                      // to look for `.recharts-bar-rectangle` — a third party's
                      // internal class name, which is a test that silently stops
                      // meaning anything the moment the library is replaced.
                      data-chart-bar
                      className="w-full rounded-t-md transition-[height]"
                      style={{
                        maxWidth: maxBarSize,
                        backgroundColor: fillFor(entry, i),
                        // A real zero draws nothing rather than a 1px smudge
                        // that reads as a small value.
                        height: value > 0 ? `${Math.max((value / axisMax) * 100, 0.5)}%` : 0,
                      }}
                    />
                  </div>

                  <div
                    className="flex shrink-0 items-start justify-center overflow-hidden"
                    style={{ height: X_AXIS_HEIGHT, ...TICK_STYLE }}
                    aria-hidden="true"
                  >
                    {showLabel && <span className="truncate px-0.5 pt-1">{label}</span>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── Tooltip ───────────────────────────────────────────────────── */}
          {active !== null && data[active] && (
            <div
              className="pointer-events-none absolute top-1 z-10 rounded-xl border border-gray-100
                         bg-white px-2.5 py-1.5 text-xs shadow-pop"
              style={{
                // Centred on its column, then pulled inside the plot at both
                // ends: the first and last bars are exactly where a centred
                // tooltip would hang off the edge of the card.
                left: `${((active + 0.5) / data.length) * 100}%`,
                transform: `translateX(${
                  active === 0 ? '-8%' : active === data.length - 1 ? '-92%' : '-50%'
                })`,
              }}
              // Hidden from assistive tech on purpose. The chart is one `role="img"`
              // whose `aria-label` already states the whole series, so announcing
              // each column again as the pointer crosses it would be the same
              // information a second time, interrupting itself.
              aria-hidden="true"
            >
              <p className="font-medium text-gray-900">{String(data[active][xKey] ?? '')}</p>
              <p className="text-gray-500">
                {valueLabel ? `${valueLabel}: ` : ''}
                <span className="font-semibold text-gray-900 tabular-nums">
                  {valueFor(Number(data[active][yKey]) || 0)}
                </span>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
