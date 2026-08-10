/**
 * The child app's design tokens.
 *
 * This app is used by a child, on one device, usually in a hurry — so it is
 * built from a small, warm, high-contrast set rather than the parent app's
 * business blue. Every screen imports from here; nothing hard-codes a hex.
 *
 * Teal carries meaning as well as tone: the deeper shades are "this is your
 * device working normally", amber is "you are close to your limit", and red is
 * only ever used for something the child chose (the SOS) or a real stop.
 */
export const colors = {
  teal900: '#06525B',
  teal800: '#0A6B76',
  teal700: '#0E7C86', // primary — headers, hero cards, primary buttons
  teal600: '#12909C',
  teal500: '#19A8B4',
  teal400: '#3FC6D2', // accent — active nav, highlights
  teal300: '#6FDDE6',
  teal200: '#A8ECF2',
  teal100: '#D6F6F9',
  teal50: '#EEFBFC',

  ink: '#0E2F35', // headings
  body: '#3B5C63', // body copy
  muted: '#7FA0A7', // captions, inactive
  line: '#DEEFF1', // hairlines

  canvas: '#F3FAFB', // screen background
  surface: '#FFFFFF',
  white: '#FFFFFF',

  danger: '#E04B4F',
  dangerSoft: '#FDEDED',
  success: '#22A06B',
  successSoft: '#E8F7F0',
  warning: '#E9922E',
  warningSoft: '#FDF2E3',
};

export const radius = {
  sm: 12,
  md: 16,
  lg: 22,
  xl: 28,
  pill: 999,
};

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
};

/**
 * Two elevations only. A child's screen is small; more depth than this reads as
 * clutter rather than hierarchy.
 */
export const shadow = {
  card: {
    shadowColor: '#0E2F35',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  lifted: {
    shadowColor: '#0E2F35',
    shadowOpacity: 0.16,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
};

export const type = {
  eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1.6, color: colors.teal600 },
  display: { fontSize: 26, fontWeight: '800', color: colors.ink, letterSpacing: -0.4 },
  title: { fontSize: 19, fontWeight: '800', color: colors.ink },
  section: { fontSize: 15, fontWeight: '800', color: colors.ink },
  body: { fontSize: 15, fontWeight: '500', color: colors.body },
  small: { fontSize: 13, fontWeight: '500', color: colors.body },
  caption: { fontSize: 12, fontWeight: '600', color: colors.muted },
};

/** Anything a child taps is at least this tall. Small fingers, moving target. */
export const TAP = 48;
