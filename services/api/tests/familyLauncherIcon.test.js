/**
 * The family app's Android launcher icon, which nothing checked and nothing drew.
 *
 * `scripts/build-brand-assets.mjs` generates every launch screen and icon in the
 * repo from committed sources, and `npm run assets:check` fails the moment one
 * of them stops matching. That guard has a hole in exactly the shape of this
 * bug: it only verifies files the script already lists. The family app's
 * per-density `ic_launcher` bitmaps were never listed, so `assets:check` passed
 * for months while the app shipped Capacitor's scaffolded placeholder — a blue
 * "X" on white graph paper — to the Play Store on every release. The script's
 * own header named that placeholder as one of three faults it had fixed; only
 * the other two ever had targets written for them.
 *
 * So the assertions here are of two kinds. The files must exist at the sizes
 * Android will look for, and the generator must be the thing producing them —
 * because a hand-placed PNG passes the first kind forever and drifts the moment
 * the artwork changes.
 *
 * Read as text and by PNG header rather than decoded: this suite is CommonJS and
 * there is no image library in it, matching familyBrandColors.test.js.
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '../../..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const FAMILY_RES = 'apps/family-app/android/app/src/main/res';

/** PNG header: width at byte 16, height at 20, colour type at 25. */
const png = (p) => {
  const b = fs.readFileSync(path.join(REPO, p));
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colourType: b[25] };
};
const HAS_ALPHA = 6;

/**
 * Capacitor scaffolds the legacy bitmaps at the 48dp launcher size and the
 * adaptive layers on the 108dp canvas, and unlike Expo's set the two are not
 * interchangeable — a 48dp file in a 108dp slot is a quarter-size mark.
 */
const LEGACY = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const ADAPTIVE = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

describe('the family app has a launcher icon of its own', () => {
  test.each(Object.entries(LEGACY))('mipmap-%s carries both legacy bitmaps at %ddp', (density, px) => {
    for (const name of ['ic_launcher', 'ic_launcher_round']) {
      const file = `${FAMILY_RES}/mipmap-${density}/${name}.png`;
      expect({ file, ...png(file) }).toEqual({ file, width: px, height: px, colourType: HAS_ALPHA });
    }
  });

  test.each(Object.entries(ADAPTIVE))('mipmap-%s carries both adaptive layers at %dpx', (density, px) => {
    for (const name of ['ic_launcher_foreground', 'ic_launcher_monochrome']) {
      const file = `${FAMILY_RES}/mipmap-${density}/${name}.png`;
      // Both layers are composited over something else, so both need alpha.
      // Either one flattened to opaque becomes a solid tile over the ground.
      expect({ file, ...png(file) }).toEqual({ file, width: px, height: px, colourType: HAS_ALPHA });
    }
  });

  /**
   * The themed-icon layer keeps only its alpha channel and is filled with one
   * colour from the wallpaper, so it has to be a silhouette. The foreground is
   * the full-colour app icon, whose alpha is a solid rounded square: pointing
   * `<monochrome>` at it would tint a blank tile, visible only on a phone with
   * themed icons turned on.
   */
  test('the adaptive icon layers the artwork over teal, with a silhouette for themed icons', () => {
    for (const name of ['ic_launcher', 'ic_launcher_round']) {
      const xml = read(`${FAMILY_RES}/mipmap-anydpi-v26/${name}.xml`);
      expect(xml).toMatch(/<foreground android:drawable="@mipmap\/ic_launcher_foreground"\s*\/>/);
      expect(xml).toMatch(/<monochrome android:drawable="@mipmap\/ic_launcher_monochrome"\s*\/>/);
      expect(xml).toMatch(/<background android:drawable="@color\/ic_launcher_background"\s*\/>/);
    }

    // Scaffolded as #FFFFFF. The launcher shows the middle 72dp of the 108dp
    // canvas and slides the layers against each other, so this is what appears
    // along the leading edge of the tile during the wobble — a white frame.
    const background = /<color name="ic_launcher_background">(#[0-9A-Fa-f]{6})<\/color>/
      .exec(read(`${FAMILY_RES}/values/ic_launcher_background.xml`));
    expect(background).not.toBeNull();
    expect(background[1].toLowerCase()).not.toBe('#ffffff');
  });

  test.each(['ic_launcher_foreground', 'ic_launcher_monochrome'])(
    'the %s is a different image from its neighbour at every density',
    (name) => {
      const other = name === 'ic_launcher_monochrome' ? 'ic_launcher_foreground' : 'ic_launcher_monochrome';
      for (const density of Object.keys(ADAPTIVE)) {
        const a = fs.readFileSync(path.join(REPO, `${FAMILY_RES}/mipmap-${density}/${name}.png`));
        const b = fs.readFileSync(path.join(REPO, `${FAMILY_RES}/mipmap-${density}/${other}.png`));
        expect({ density, same: a.equals(b) }).toEqual({ density, same: false });
      }
    },
  );

  /**
   * The assertion that would have caught the original fault. Every other test
   * here passes just as well against a PNG someone dropped in by hand, which is
   * what the child app's icons were before the generator existed and is how they
   * went stale. `assets:check` is the guard, and it can only guard a file the
   * script names.
   */
  test('the generator writes these files, so assets:check covers them', () => {
    const script = read('scripts/build-brand-assets.mjs');
    for (const name of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground', 'ic_launcher_monochrome']) {
      const target = new RegExp(`path\\.join\\(FAMILY_RES, \`mipmap-\\$\\{density\\}\`, '${name}\\.png'\\)`);
      expect({ name, generated: target.test(script) }).toEqual({ name, generated: true });
    }
  });

  test('the icon sources are committed where the generator looks for them', () => {
    for (const app of ['family', 'child']) {
      const file = `brand/${app}-app-icon.png`;
      expect({ file, exists: fs.existsSync(path.join(REPO, file)) }).toEqual({ file, exists: true });
    }
  });
});
