/**
 * The family app's brand colours, for the places a Tailwind class cannot reach.
 *
 * Recharts takes `fill` as a literal, the Google Maps marker is an inline SVG
 * encoded into a data URI, and a safe-zone circle is drawn by the Maps API — so
 * three screens need the same hex that `bg-primary-600` resolves to. They each
 * carried their own copy of `#2563eb`, which is how the charts stayed blue when
 * the rest of the app moved.
 *
 * These mirror `tailwind.config.js`. If a value changes there it changes here,
 * and the pairing is asserted so the two cannot drift apart unnoticed.
 */

/** `primary-600` — the brand teal. Buttons, active nav, the primary series. */
export const PRIMARY = '#0E7C86';

/** `primary-500`. A second teal for a chart that needs two related series. */
export const PRIMARY_LIGHT = '#12909C';

/**
 * Categorical series colours, primary first.
 *
 * Only the first is a brand colour; the rest are chosen to stay distinguishable
 * beside it, including for the commonest colour-vision deficiencies — which is
 * why green and red are never adjacent in the order.
 */
export const SERIES = [PRIMARY, '#F59E0B', '#8B5CF6', '#10B981', '#EC4899', '#EF4444'];
