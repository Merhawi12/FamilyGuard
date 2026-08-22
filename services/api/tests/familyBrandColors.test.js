/**
 * The family app's teal is stated in three places that cannot import each other,
 * and this is what stops them drifting.
 *
 * Tailwind reads a config, Recharts and the Google Maps marker need a literal
 * hex from a plain module, and the child app declares the same ramp for React
 * Native. None of the three can be the single source for the others — Tailwind
 * config is consumed by a build, `brand.js` is browser ESM, `theme.js` is
 * Metro's — so the palette is restated and the agreement is asserted here
 * instead.
 *
 * The failure this guards is silent and ugly rather than loud: nothing throws
 * when a shade is changed in one file, the parent simply gets a chart in last
 * season's blue beside a teal button, or a sibling app half a tone off. That is
 * exactly the state this app was found in.
 *
 * Read as text, not imported, for the same reason as sharedConstants.test.js:
 * this suite is CommonJS and all three files are ESM. Three regexes beat a
 * build step.
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '../../..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const tailwindConfig = read('apps/family-app/tailwind.config.js');
const brand = read('apps/family-app/src/brand.js');
const childTheme = read('apps/child-app/shared/src/theme.js');

/** `600: '#0E7C86',` → `#0e7c86`, searched from `after` so the two ramps in the
 *  Tailwind config can be told apart — both declare a `50`. */
const shade = (source, key, after = '') => {
  const from = after ? source.indexOf(after) : 0;
  if (from === -1) throw new Error(`no block ${after} found`);
  const match = new RegExp(`\\b${key}:\\s*'(#[0-9a-fA-F]{6})'`).exec(source.slice(from));
  if (!match) throw new Error(`no shade ${key} found`);
  return match[1].toLowerCase();
};

/** Relative luminance, per WCAG. */
const luminance = (hexColor) => {
  const channels = [1, 3, 5].map((i) => {
    const s = parseInt(hexColor.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * Only what ships.
 *
 * Explaining a colour migration means naming the colour it moved off, so the
 * source checks below would otherwise fail on their own documentation — and a
 * check that does that teaches people to delete the documentation.
 */
const code = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every shipped .js/.jsx/.css file under a directory, as [path, code] pairs. */
const sourcesUnder = (dir, out = []) => {
  for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sourcesUnder(rel, out);
    else if (/\.(jsx?|css)$/.test(entry.name)) out.push([rel, code(read(rel))]);
  }
  return out;
};

/** `export const NAME = '#0E7C86';` → `#0e7c86` */
const constant = (source, name) => {
  const match = new RegExp(`export const ${name} = '(#[0-9a-fA-F]{6})'`).exec(source);
  if (!match) throw new Error(`no export ${name} found`);
  return match[1].toLowerCase();
};

describe('the family app is drawn in one teal', () => {
  it('brand.js states the same hex Tailwind resolves bg-primary-600 to', () => {
    // The charts and the map pin cannot use a class, so they read PRIMARY. If
    // these two disagree, every button on the page is one colour and every bar
    // of the chart beside it is another.
    expect(constant(brand, 'PRIMARY')).toBe(shade(tailwindConfig, '600'));
    expect(constant(brand, 'PRIMARY_LIGHT')).toBe(shade(tailwindConfig, '500'));
  });

  it('leads the categorical series with the brand colour', () => {
    const series = /export const SERIES = \[([^\]]+)\]/.exec(brand);
    expect(series).toBeTruthy();
    const first = /(#[0-9a-fA-F]{6})|PRIMARY/.exec(series[1])[0];
    // Either spelling is fine as long as it resolves to the brand teal.
    expect(first === 'PRIMARY' ? constant(brand, 'PRIMARY') : first.toLowerCase())
      .toBe(constant(brand, 'PRIMARY'));
  });

  /**
   * Not a coincidence to be re-derived: the ramp *is* the child app's, so a
   * parent and their child are looking at one palette rather than two that
   * happen to be close. Whoever changes one is meant to change both.
   */
  it('uses the same ramp the child app ships', () => {
    for (const [primary, teal] of [['600', 'teal700'], ['500', 'teal600'], ['700', 'teal800'], ['800', 'teal900']]) {
      expect(shade(tailwindConfig, primary)).toBe(shade(childTheme, teal));
    }
  });

  /**
   * The neutrals are the half that makes the two apps actually look alike.
   *
   * An accent in common is not a look in common: with stock cool grey around it
   * the same teal reads as "grey app with teal buttons" beside the child app's
   * tinted one. These five stops are the child app's own surface colours, so
   * whoever retints one screen has to retint both.
   */
  it('takes its neutral surfaces from the child app as well', () => {
    for (const [gray, token] of [['50', 'canvas'], ['100', 'line'], ['400', 'muted'], ['700', 'body'], ['900', 'ink']]) {
      expect(shade(tailwindConfig, gray, 'const tealGray')).toBe(shade(childTheme, token));
    }
  });

  /**
   * Tinting the neutrals moves every text pairing in the app at once, so the
   * ratios are asserted rather than trusted. `gray-500` over `gray-50` is the
   * one that caught a real regression: straight interpolation between the child
   * app's `muted` and `body` lands on 4.34:1, under AA and worse than the stock
   * grey it replaced.
   *
   * `gray-400` is excluded deliberately — it is hint and placeholder text and
   * was already under AA on the stock ramp. It is not made worse here, and
   * pinning it would assert a floor the design has never met.
   */
  it('keeps AA for body text on the tinted surfaces', () => {
    const g = (key) => shade(tailwindConfig, key, 'const tealGray');
    const pairs = [
      ['900', '#ffffff'], ['900', g('50')], ['700', '#ffffff'],
      ['600', '#ffffff'], ['600', g('100')], ['500', '#ffffff'], ['500', g('50')],
    ];
    for (const [stop, background] of pairs) {
      expect(contrast(g(stop), background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps white legible on the primary button, and primary legible on the page', () => {
    const primary = shade(tailwindConfig, '600');
    expect(contrast('#ffffff', primary)).toBeGreaterThanOrEqual(4.5);
    // `Manage`, `View all` — brand-coloured links sit on the page background.
    expect(contrast(primary, shade(tailwindConfig, '50', 'const tealGray'))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the neutral ramp monotonic, so a higher stop is always darker', () => {
    const stops = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'];
    const lums = stops.map((s) => luminance(shade(tailwindConfig, s, 'const tealGray')));
    for (let i = 1; i < lums.length; i += 1) expect(lums[i]).toBeLessThan(lums[i - 1]);
  });

  /**
   * The hex check below could not see this one, and it shipped.
   *
   * The signed-out shell painted itself `from-blue-50 via-white to-indigo-50`.
   * No token, no hex — just a gradient built from a stock hue — so retinting the
   * palette went straight past it and every signed-out screen kept a lavender
   * background behind a teal product. It was the first page anyone saw.
   *
   * Gradient stops are always chrome; nothing categorical is ever expressed as
   * one. That makes them safe to ban outright, unlike `bg-blue-100`, which
   * Contacts uses legitimately to tell one relationship from another.
   */
  it('builds gradients from brand tokens rather than a stock hue', () => {
    const offenders = sourcesUnder('apps/family-app/src')
      .map(([file, source]) => [file, source.match(/\b(?:from|via|to)-(?:blue|indigo|violet|sky|cyan|purple)-\d+/g)])
      .filter(([, hits]) => hits)
      .map(([file, hits]) => `${file}: ${[...new Set(hits)].join(' ')}`);

    expect(offenders).toEqual([]);
  });

  it('has no unconverted blue left in the family app', () => {
    // `#2563eb` was the old primary-600. A stray one is a chart or a pin that
    // did not come along, which is precisely how the app ended up mixed.
    const stragglers = sourcesUnder('apps/family-app/src')
      .filter(([, source]) => /#2563eb/i.test(source))
      .map(([file]) => file);

    expect(stragglers).toEqual([]);
  });

  /**
   * The marketing pages are not under src/, and that is the whole reason this
   * exists.
   *
   * `public/landing.html` and `public/contact.html` are hand-written and copied
   * verbatim into the bundle, so every check above walked straight past them.
   * Both kept `theme-color: #2563eb` through the entire rebrand — on Android the
   * address bar and task switcher stayed business blue above a page whose own
   * `--current` is teal, on the first URL anyone visits.
   *
   * Read raw rather than through `sourcesUnder`, which only collects js/jsx/css.
   */
  /**
   * The child app has a native half, and nothing in `src/` can reach it.
   *
   * `android/app/src/main/res/values/colors.xml` and `app.json` are read by
   * Android and by Expo's config plugins before a line of JavaScript runs, so
   * every check above walked past them — and all four values stayed `#2563eb`
   * through the entire rebrand. The result was a *blue* splash screen on every
   * launch, fading into a teal app, and a blue accent on every notification
   * Parentix raised. It is the first thing a child sees and the only thing they
   * see when the app is closed.
   *
   * Compared against `theme.js` rather than a literal, so the ramp stays the one
   * source and whoever retints the app has to bring the native side along.
   */
  it('paints the child app’s native chrome in the same teal its screens use', () => {
    const nativeColors = read('apps/child-app/android/android/app/src/main/res/values/colors.xml');
    // The Android project's Expo config. A CommonJS module since the platform
    // split, so that it and the iOS one can share a base — see
    // apps/child-app/shared/app.config.base.js.
    const appConfig = require(path.join(REPO, 'apps/child-app/android/app.config.js'));

    const xml = (name) =>
      new RegExp(`<color name="${name}">(#[0-9a-fA-F]{6})</color>`).exec(nativeColors)?.[1]?.toLowerCase();

    const primary = shade(childTheme, 'teal700');
    const deepest = shade(childTheme, 'teal900');

    expect(xml('splashscreen_background')).toBe(primary);
    expect(xml('notification_icon_color')).toBe(primary);
    expect(xml('colorPrimaryDark')).toBe(deepest);

    // Expo writes the splash and the notification accent from app.json on a
    // prebuild, so a mismatch here would silently undo the XML above.
    expect(appConfig.expo.splash.backgroundColor.toLowerCase()).toBe(primary);
    const notifications = appConfig.expo.plugins.find(
      (p) => Array.isArray(p) && p[0] === 'expo-notifications',
    );
    expect(notifications[1].color.toLowerCase()).toBe(primary);
  });

  /**
   * And the family app has a native half too.
   *
   * Its `styles.xml` binds `AppTheme` to `@color/colorPrimary`,
   * `colorPrimaryDark` and `colorAccent`, and no `colors.xml` existed at all —
   * so Android resolved all three from the Capacitor library, whose defaults are
   * stock Material indigo and pink. Every part of the shell Android draws for
   * itself was therefore untouched by the rebrand: a parent typing their
   * password got pink text-selection handles inside a teal app.
   */
  it('paints the family app’s native chrome in the same teal its screens use', () => {
    const nativeColors = read('apps/family-app/android/app/src/main/res/values/colors.xml');
    const xml = (name) =>
      new RegExp(`<color name="${name}">(#[0-9a-fA-F]{6})</color>`).exec(nativeColors)?.[1]?.toLowerCase();

    expect(xml('colorPrimary')).toBe(shade(tailwindConfig, '600'));
    expect(xml('colorPrimaryDark')).toBe(shade(tailwindConfig, '800'));
    expect(xml('colorAccent')).toBe(shade(tailwindConfig, '600'));
  });

  it('has no unconverted blue left in the child app either', () => {
    // The foreground-service notification and the Android channel's light both
    // carried the old primary as a bare hex, outside anything theme.js governs.
    const stragglers = sourcesUnder('apps/child-app/shared/src')
      .filter(([, source]) => /#2563eb/i.test(source))
      .map(([file]) => file);

    expect(stragglers).toEqual([]);
  });

  it('tints the browser chrome on the static pages to match the page', () => {
    const offenders = ['landing.html', 'contact.html']
      .map((name) => [name, read(`apps/family-app/public/${name}`)])
      .map(([name, html]) => {
        const themeColor = /<meta name="theme-color" content="(#[0-9a-fA-F]{6})"/.exec(html)?.[1];
        const current = /--current:\s*(#[0-9a-fA-F]{6})/.exec(html)?.[1];
        return [name, themeColor?.toLowerCase(), current?.toLowerCase()];
      })
      .filter(([, themeColor, current]) => !themeColor || !current || themeColor !== current)
      .map(([name, themeColor, current]) => `${name}: theme-color ${themeColor} ≠ --current ${current}`);

    expect(offenders).toEqual([]);
  });
});
