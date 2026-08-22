/**
 * The child-facing design tokens, shared with the mobile app.
 *
 * Same palette, deliberately: a family that sets up a phone and a laptop is
 * looking at one product, and the teal is the only thing on either screen that
 * says so before a word is read. Teal carries meaning as well as tone — the
 * deeper shades are "this device is working normally", amber is "you are close
 * to your limit", and red is only ever used for something the child chose (the
 * SOS) or a real stop.
 *
 * `styles.css` reads these through custom properties rather than repeating the
 * hexes, so this file stays the one place a colour is decided.
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

  ink: '#0E2F35',
  body: '#3B5C63',
  muted: '#7FA0A7',
  line: '#DEEFF1',

  canvas: '#F3FAFB',
  surface: '#FFFFFF',
  white: '#FFFFFF',

  danger: '#E04B4F',
  dangerSoft: '#FDEDED',
  success: '#22A06B',
  successSoft: '#E8F7F0',
  warning: '#E9922E',
  warningSoft: '#FDF2E3',
};

export const radius = { sm: 12, md: 16, lg: 22, xl: 28, pill: 999 };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 };

/** `teal700` → `--teal-700`, so the stylesheet never repeats a hex. */
const kebab = (key) => key.replace(/([a-z])([0-9])/g, '$1-$2').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

export function cssVariables() {
  const lines = Object.entries(colors).map(([key, value]) => `  --${kebab(key)}: ${value};`);
  for (const [key, value] of Object.entries(radius)) lines.push(`  --radius-${key}: ${value}px;`);
  for (const [key, value] of Object.entries(space)) lines.push(`  --space-${key}: ${value}px;`);
  return `:root {\n${lines.join('\n')}\n}`;
}
