/**
 * How both web apps split their vendor code, in one place.
 *
 * ── Why this is a function and not the object Rollup also accepts ────────────
 *
 * `manualChunks: { react: ['react'], maps: ['@react-google-maps/api'] }` reads
 * better and is quietly wrong. Rollup fills each group with the named module
 * *and* every dependency of it that no earlier group has claimed, so a module
 * two packages share lands in whichever group is listed first — and once a
 * manual assignment has moved a module out of the chunk Rollup would have
 * chosen, every chunk that needs it gains a static import of the chunk it was
 * moved into.
 *
 * That is not theoretical. `react/jsx-runtime` is a separate entry point that
 * the `react` package does not itself import, so listing `'react'` never
 * claimed it. `@react-google-maps/api` is compiled against the automatic JSX
 * transform (recharts is not — it still calls `React.createElement`), so the
 * runtime was pulled into the `maps` group instead. Every component in the app
 * calls the JSX factory, so the entry chunk ended up with a hard static import
 * of `maps`, Vite emitted a `<link rel="modulepreload">` for it, and 147 kB of
 * the Google Maps wrapper was fetched and parsed on the sign-in screen — the
 * precise thing the `lazy()` calls in App.jsx exist to prevent.
 *
 * Naming `'react/jsx-runtime'` in the array does not fix it either, which is the
 * second reason this is a function. `react/jsx-runtime` is CommonJS; Vite's
 * interop layer gives it a synthetic proxy module whose id carries a `\0`
 * prefix, and the object form matches resolved real modules, so the proxy — the
 * module the app actually imports — stays unassigned and is absorbed again.
 * A function sees every id, proxies included, so `packageOf` below can map both
 * halves back to the one package they came from.
 *
 * ── The rule for editing this ────────────────────────────────────────────────
 *
 * Only ever name a package that belongs to exactly one group. Anything left
 * unassigned falls through to Rollup, which places it by which entry points can
 * reach it — the conservative answer, and never the source of a surprise static
 * edge like the one above. Shared-by-two-groups packages (`lodash`,
 * `invariant`, `eventemitter3`) are deliberately absent for that reason.
 */

/** The npm package an arbitrary Rollup module id belongs to, or `null`. */
const packageOf = (id) => {
  // Virtual ids look like `\0commonjs-proxy:/abs/path/…`; the real path is what
  // carries the package name, so the prefix is stripped before anything else.
  const filePath = id.replace(/^\0[^:]*:/, '').replace(/\\/g, '/');
  const marker = '/node_modules/';
  const at = filePath.lastIndexOf(marker);
  if (at === -1) return null;

  const [first, second] = filePath.slice(at + marker.length).split('/');
  // Scoped packages are two segments deep: `@googlemaps/js-api-loader`.
  return first?.startsWith('@') ? `${first}/${second}` : first || null;
};

const groups = {
  react: [
    'react', 'react-dom', 'react-is', 'scheduler',
    'react-router', 'react-router-dom', '@remix-run/router',
  ],
  charts: [
    'recharts', 'recharts-scale', 'victory-vendor', 'react-smooth',
    'internmap', 'decimal.js-light',
    'd3-array', 'd3-color', 'd3-ease', 'd3-format', 'd3-interpolate',
    'd3-path', 'd3-scale', 'd3-shape', 'd3-time', 'd3-time-format', 'd3-timer',
  ],
  maps: [
    '@react-google-maps/api', '@react-google-maps/infobox',
    '@react-google-maps/marker-clusterer',
    '@googlemaps/js-api-loader', '@googlemaps/markerclusterer',
  ],
};

/**
 * `manualChunks` for one app.
 *
 * @param {string[]} names which groups this app has — the Admin Dashboard has no
 *   map, and listing a group whose packages it never imports would emit nothing
 *   but is worth not claiming, so the intent of each config stays readable.
 */
export const vendorChunks = (names) => {
  const chunkOf = new Map();
  for (const name of names) {
    for (const pkg of groups[name] || []) chunkOf.set(pkg, name);
  }
  return (id) => chunkOf.get(packageOf(id));
};

export { packageOf };
