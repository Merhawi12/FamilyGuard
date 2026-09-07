/**
 * The "nice" numbers a value axis is labelled with.
 *
 * Split out of BarChart.jsx so the axis arithmetic can be reasoned about — and
 * tested — without a renderer around it. Nothing here touches React.
 */

/**
 * A step at or above `rough` that a person would choose: 1, 2, 5 or 10 times a
 * power of ten.
 *
 * The 2/5/10 ladder is what makes an axis readable. A step of 3 is arithmetically
 * fine and gives ticks of 0, 3, 6, 9, 12 — legible only if you are reading the
 * numbers rather than the shape, which is the opposite of what an axis is for.
 */
const niceStep = (rough) => {
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  if (normalized <= 1) return magnitude;
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 5) return 5 * magnitude;
  return 10 * magnitude;
};

/**
 * Tick values from 0 up to at or above `max`, and the axis maximum they imply.
 *
 * Always anchored at zero. A bar chart whose baseline is not zero misstates
 * every comparison on it by the size of the offset, and these charts are read
 * for exactly that comparison — "was yesterday worse than today".
 *
 * `allowDecimals: false` is for counts. Signups cannot be 2.5, and an axis that
 * says they can is a rounding error rendered as a fact; when the whole range is
 * smaller than the tick count the step is clamped to 1 instead.
 *
 * @param {number} max the largest value plotted.
 * @param {object} [options]
 * @param {number} [options.count] how many intervals to aim for.
 * @param {boolean} [options.allowDecimals]
 * @returns {{ ticks: number[], axisMax: number }}
 */
export const niceTicks = (max, { count = 4, allowDecimals = true } = {}) => {
  // An all-zero series still needs an axis, and `log10(0)` is -Infinity. One is
  // the smallest top that leaves the 0 label meaning what it says.
  if (!Number.isFinite(max) || max <= 0) return { ticks: [0, 1], axisMax: 1 };

  let step = niceStep(max / count);
  if (!allowDecimals) step = Math.max(1, Math.round(step));

  const axisMax = Math.ceil(max / step) * step;
  const ticks = [];
  // Accumulated by index rather than by repeated addition: adding 0.1 five times
  // gives 0.5000000000000001, which formats as a label no one would type.
  for (let i = 0; i * step <= axisMax + step / 1e6; i += 1) ticks.push(i * step);

  return { ticks, axisMax };
};

/**
 * A tick value as text, with the trailing noise of binary floating point
 * removed. `formatTick(0.30000000000000004)` is `'0.3'`.
 */
export const formatTick = (value) => {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(12)));
};
