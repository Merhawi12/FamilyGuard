import preset from '../../packages/shared/tailwind-preset.cjs';

/**
 * The family app is teal; the admin console stays blue.
 *
 * Everything a parent sees was already teal except this app: the marketing site
 * at the apex is built on `--current: #0C6478` → `--tide: #15B8C9`, and the
 * child app ships the full ramp in `apps/child-app/src/theme.js`. The dashboard
 * was the one surface still on the preset's business blue, so a parent moved
 * from a teal landing page, signed in, and arrived somewhere that looked like a
 * different product.
 *
 * The shades below are not a new palette — they are the child app's own
 * `teal50…teal900`, lifted unchanged, so the two apps a family uses are drawn
 * from one set of colours rather than two that merely agree. `primary-600` is
 * the brand teal (`teal700` there) because 600 is what `.btn-primary`, the
 * active nav item and every chip resolve to; 700 and 800 are its hover and
 * active states and so must keep getting darker.
 *
 * This overrides rather than edits `tailwind-preset.cjs` deliberately. That file
 * is shared with the admin console, whose navy rail is built to sit against the
 * same blue — see the `navy` scale beside it. Staff tooling looking like staff
 * tooling is the intent there, not an oversight.
 *
 * White on `#0E7C86` measures 4.94:1, so primary buttons and chips keep AA for
 * normal text. Do not lighten 600 without re-checking that.
 */
const teal = {
  50: '#EEFBFC',
  100: '#D6F6F9',
  200: '#A8ECF2',
  500: '#12909C',
  600: '#0E7C86',
  700: '#0A6B76',
  800: '#06525B',
};

/**
 * The neutrals are teal-tinted too, and that is the half that actually makes
 * the two apps match.
 *
 * Sharing an accent is not sharing a look. The child app is a tinted world —
 * `canvas`, `ink`, `body`, `muted` and `line` in its `theme.js` are all teal-
 * leaning, and 64 places read them — while this app was drawing the same teal
 * buttons on Tailwind's stock cool grey. Side by side that reads as two
 * products: one teal, one grey with teal bits.
 *
 * Five stops are the child app's own values, so the surfaces a family sees on
 * the phone and on the web are the same colour rather than nearly:
 *
 *   50  canvas   the page behind everything
 *   100 line     hairlines and dividers
 *   400 muted    captions, placeholders, inactive
 *   700 body     body copy
 *   900 ink      headings
 *
 * The five in between are interpolated to keep the ramp monotonic, except 500,
 * which is pulled darker than interpolation gives. It is `.page-subtitle` over
 * `bg-gray-50`, and the interpolated value measured 4.34:1 there — a real
 * regression from the stock grey's 4.63:1. At `#52737C` that pair is 4.85:1,
 * better than what it replaces. Every other text pairing keeps AA as well;
 * `gray-400` stays below it, as it did before, because it is only ever hint and
 * placeholder text. Re-check with the ratios in the header of the colour test
 * before moving any of these.
 */
const tealGray = {
  50: '#F3FAFB',
  100: '#DEEFF1',
  200: '#C8E1E6',
  300: '#A3C4CC',
  400: '#7FA0A7',
  500: '#52737C',
  600: '#47666E',
  700: '#3B5C63',
  800: '#26454B',
  900: '#0E2F35',
};

/**
 * Two breakpoints keyed on the height of the viewport rather than its width.
 *
 * The launch screen is a photograph stacked above a sheet, and that shape has a
 * floor: below roughly 520px of height the picture and the copy cannot both have
 * room, and a splash that scrolls is not a splash. A phone held sideways is
 * 390px tall, so this is not a corner case — it is what happens when someone
 * opens the app while their phone is lying on a desk.
 *
 * `wide` is the query for "lay this out as two columns", and it is deliberately
 * one screen rather than two variants written side by side: a desktop and a
 * phone in landscape want the same arrangement for opposite reasons, and
 * spelling that as `lg:flex-row short:flex-row` on a dozen elements is where the
 * two quietly drift apart. `short` is the compaction that only the phone needs —
 * a smaller tile, smaller type, a shorter button.
 *
 * Height queries, not `landscape`: a tall phone rotated is still tall enough for
 * the stacked layout, and an orientation check would rearrange it for no reason.
 * Declared here rather than in the shared preset because no other app has a
 * screen whose whole design is bounded by height.
 */
const screens = {
  wide: { raw: '(min-width: 1024px), (max-height: 520px)' },
  short: { raw: '(max-height: 520px)' },
};

export default {
  presets: [preset],
  content: ['./index.html', './src/**/*.{js,jsx}', '../../packages/shared/src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: { primary: teal, gray: tealGray },
      screens,
    },
  },
};
