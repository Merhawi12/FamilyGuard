/**
 * Shared Tailwind theme for the Parentix web apps. Each app extends this preset
 * so the Admin Dashboard and Family App stay visually consistent.
 *
 * The `safe-*` spacing and the `dvh` sizes exist for the phone layouts: a
 * bottom navigation bar has to clear the iOS home indicator, and `100vh` on a
 * mobile browser is taller than the space actually visible while the URL bar is
 * on screen — which is what leaves a "full height" pane scrolled under it.
 */
const safe = (side) => `env(safe-area-inset-${side}, 0px)`;

module.exports = {
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
        },
        danger: '#ef4444',
        success: '#22c55e',
        warning: '#f59e0b',
        /* The admin console's chrome: a dark navy rail against a light working
           area. Only the console draws on these, but they live here so the one
           blue the two apps share stays the same blue. */
        navy: {
          50: '#eef3fb',
          200: '#c2d4f0',
          300: '#9db8e4',
          400: '#7492cc',
          600: '#1f4c9e',
          700: '#163b7d',
          800: '#0f2c60',
          900: '#0b2451',
          950: '#071835',
        },
        /* Slightly cooler than gray-50 — it reads as a working surface under the
           navy rail rather than as unpainted white. */
        canvas: '#f4f6fb',
      },
      fontFamily: {
        sans: [
          'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto',
          'Helvetica Neue', 'Arial', 'Noto Sans', 'sans-serif',
          'Apple Color Emoji', 'Segoe UI Emoji',
        ],
      },
      spacing: {
        'safe-t': safe('top'),
        'safe-b': safe('bottom'),
        'safe-l': safe('left'),
        'safe-r': safe('right'),
        // Height of the phone bottom navigation, plus the home indicator. Pages
        // pad their scroll container by this so the last row is never covered.
        'nav-b': `calc(4rem + ${safe('bottom')})`,
      },
      height: { dvh: '100dvh' },
      minHeight: { dvh: '100dvh' },
      maxHeight: { dvh: '100dvh' },
      boxShadow: {
        card: '0 1px 2px 0 rgb(16 24 40 / 0.04), 0 1px 3px 0 rgb(16 24 40 / 0.06)',
        pop: '0 12px 32px -8px rgb(16 24 40 / 0.18), 0 4px 12px -4px rgb(16 24 40 / 0.08)',
        nav: '0 -1px 3px 0 rgb(16 24 40 / 0.06)',
      },
      keyframes: {
        'slide-up': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(.97)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'slide-up': 'slide-up .22s cubic-bezier(.32,.72,0,1)',
        'fade-in': 'fade-in .15s ease-out',
        'scale-in': 'scale-in .14s ease-out',
      },
    },
  },
  plugins: [],
};
