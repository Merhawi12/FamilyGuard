#!/usr/bin/env node
/**
 * Every launch screen, launcher icon and notification icon in the repo, drawn
 * from three committed sources.
 *
 *   node scripts/build-brand-assets.mjs          # writes them
 *   node scripts/build-brand-assets.mjs --check  # verifies they are current
 *
 *   apps/family-app/public/logo.png   the lockup. Launch screens, notification
 *                                     icons, themed-icon silhouettes, the web
 *                                     logo — everything drawn as one colour.
 *   brand/family-app-icon.png         the family app's launcher icon.
 *   brand/child-app-icon.png          the child app's launcher icon.
 *
 * This started as the family app's Android splash and grew, because the same
 * fault kept turning up in a different directory. Capacitor and Expo both
 * scaffold a project with *their own* artwork, nothing regenerates it, and so a
 * cold launch opened on somebody else's logo and cut to a teal app. Three
 * separate instances of that were live at once:
 *
 *   - the family app's Android launcher icon: Capacitor's light-blue "X"
 *   - the child app's launcher icon: the pre-rebrand navy lockup, wordmark and
 *     all, on white — off-brand since the teal reskin and unreadable at 48dp
 *   - the child app's launch screen: flat teal, no mark at all
 *
 * Two of those three were fixed when this was written. The family app's launcher
 * icon was not: it was named above and no target was ever added for it, so the
 * blue "X" went to the Play Store on every release afterwards, with this comment
 * saying otherwise. It is drawn now. A list of faults in a header is not a test,
 * and `npm run assets:check` only checks the files this file already knows about.
 *
 * Keeping the generator in the repo rather than hand-making eighty PNGs once is
 * what makes a change to a source or to the brand teal a re-run instead of an
 * afternoon.
 *
 * Rendered through Playwright — already a dev dependency for the browser E2E —
 * because the source mark is a PNG with an alpha channel and the white version
 * of it is one CSS filter away, the same treatment the marketing footer uses. No
 * image library, and what ships is what a browser drew.
 *
 * ── The one thing to know before editing ─────────────────────────────────────
 *
 * The two apps consume these differently, and it decides where a file must go.
 *
 *   family app   Capacitor. Both native projects are committed, so every image
 *                is written straight into android/res and ios/Assets.xcassets.
 *
 *   child app    Expo, and split into a project per platform:
 *                apps/child-app/{android,ios} are two Expo project roots. The
 *                Android one is *bare* — its own `android/` is committed source
 *                holding the accessibility, VPN and usage-stats modules, and
 *                `expo prebuild` would delete it, so prebuild is never run there
 *                and its app.config.js icon/splash keys have no effect. Those
 *                files are written into android/res directly, exactly like the
 *                family app. iOS has no committed native project, so EAS *does*
 *                prebuild it, and there app.config.js is the source of truth.
 *
 *                Both project roots get an `assets/` copy. Expo resolves
 *                `icon` and `splash.image` from the project root, so the shared
 *                app.config.base.js can name `./assets/icon.png` only because
 *                the file exists under each. Writing both from here is what
 *                keeps them the same image — they are two files on disk, and
 *                nothing else would notice if they stopped matching.
 *
 * Get that backwards and the change appears on one platform only.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAMILY_RES = path.join(REPO, 'apps/family-app/android/app/src/main/res');
const XCASSETS = path.join(REPO, 'apps/family-app/ios/App/App/Assets.xcassets');
const CHILD_RES = path.join(REPO, 'apps/child-app/android/android/app/src/main/res');
const CHILD_ANDROID_ASSETS = path.join(REPO, 'apps/child-app/android/assets');
const CHILD_IOS_ASSETS = path.join(REPO, 'apps/child-app/ios/assets');
const DESKTOP_WINDOWS = path.join(REPO, 'apps/child-desktop/windows/build');
const DESKTOP_MACOS = path.join(REPO, 'apps/child-desktop/macos/build');
const LOGO = path.join(REPO, 'apps/family-app/public/logo.png');
const FAMILY_PUBLIC = path.join(REPO, 'apps/family-app/public');
const ADMIN_PUBLIC = path.join(REPO, 'apps/admin-dashboard/public');
const BRAND = path.join(REPO, 'brand');

/** `primary-600`, the brand teal. Mirrors res/values/colors.xml and
 *  tailwind.config.js; familyBrandColors.test.js holds those two together. */
const TEAL = '#0E7C86';

/* ── The source mark ──────────────────────────────────────────────────────────
 *
 * `logo.png` is a lockup: the shield above the word "Parentix". Which half is
 * wanted depends entirely on how big the result will be drawn.
 *
 * A launch screen is a full display for a second or two, so the lockup is right
 * there. An icon is 48dp on Android and 60pt on iOS, where the wordmark is about
 * ten pixels tall, becomes a grey smear, and squeezes the shield to half the tile
 * to make room for itself. Apple's guidance is blunt about it and Android's is
 * the same in effect. So icons crop to the mark.
 *
 * These are the shield's bounds inside the 500×500 source, measured off the
 * artwork: x 160–340, y 95–295, so 180×200 centred on (250, 195). CROP is the
 * square lifted out around that centre, a little larger than the shield's height,
 * which is what leaves a ring of ground between the mark and the edge.
 */
const LOGO_PX = 500;
const MARK_CENTRE = { x: 250, y: 195 };
const MARK_CROP = 240;

/**
 * The lockup's share of the shorter edge on a launch screen.
 *
 * Held against the *shorter* edge rather than the width so a landscape sheet and
 * a portrait one of the same density put the same-sized logo on screen. A third
 * leaves the margin a launch screen wants: this is a frame nobody should notice,
 * and a logo filling it reads as an advertisement rather than the app opening.
 */
const LOGO_SHARE = 0.34;

/**
 * The mark's share of an icon tile.
 *
 * Three different answers, because three different things crop the result:
 *
 *   ICON      a plain square (iOS, and Android's legacy launcher bitmap). The OS
 *             rounds the corners and nothing else, so the mark can run close to
 *             the edge.
 *   ADAPTIVE  Android's adaptive foreground. The system may mask this to a
 *             circle, a squircle or a teardrop and animates it, so only the
 *             central 66% of the 108dp canvas is guaranteed visible. Well inside
 *             that, because a mark that merely fits the safe zone still collides
 *             with the mask during the parallax wobble.
 *   NOTIFY    Android's status-bar icon. Only the alpha channel survives — the
 *             system throws the colour away and tints the silhouette — so it is
 *             drawn large and flat.
 */
const ICON_SHARE = 0.62;
const ADAPTIVE_SHARE = 0.42;
const NOTIFY_SHARE = 0.80;

/**
 * iOS wants a much smaller share than Android, because its square gets cropped.
 *
 * iOS has one square launch image for every device and aspect-*fills* it, so on
 * a phone the visible region is a tall slice out of the middle and most of the
 * width is thrown away. Worst case is the narrowest modern phone: 1320×2868
 * covers 2732×2732 at scale 1.05, leaving 1320/1.05 ≈ 1257 of the original 2732
 * pixels of width on screen — about 46%.
 *
 * 0.18 puts a 492px mark inside that 1257px strip, reading as ~39% of the visible
 * width, near enough to Android's 34% that the two platforms open the same way.
 * Measuring against the square directly would put a mark on a phone screen nearly
 * three quarters of its width.
 */
const IOS_SPLASH_PX = 2732;
const IOS_SPLASH_LOGO_SHARE = 0.18;
const IOS_ICON_PX = 1024;

/**
 * The child app's Expo splash, which is a tall canvas rather than a square.
 *
 * `resizeMode: contain` fits the whole image on screen, so a square would scale
 * to the display's *width* and put an enormous mark in the middle. A portrait
 * canvas of roughly phone proportions scales to the height instead and keeps the
 * mark the size it was drawn. Any letterboxing is invisible because the image's
 * ground and `splash.backgroundColor` are the same teal.
 */
const EXPO_SPLASH = [1242, 2688];

/* ── The app icons, which are not the source mark ────────────────────────────
 *
 * Everything above treats `logo.png` as the one source and paints it as a white
 * silhouette. Launcher icons no longer come from it.
 *
 * The two apps are two products to the person holding the phone — a parent's
 * dashboard and a child's own app — and shipping both under the same white
 * shield made the pair indistinguishable in a launcher, which is the one place
 * they are always seen side by side. So each has its own drawn artwork:
 *
 *   brand/family-app-icon.png   the shield, lock and family, on the brand teal
 *   brand/child-app-icon.png    a child with a tablet, on the same teal
 *
 * These are *composed tiles*, not marks: each already contains its own ground,
 * its own colours and its own rounded corners. Nothing here filters them, and
 * nothing crops a wordmark off — the cropping constants above apply to the
 * lockup only. What this file still has to do is fit a tile to each platform's
 * idea of an icon, which differ enough that a single PNG cannot serve them:
 *
 *   full bleed   iOS, and Android's adaptive foreground. The OS applies its own
 *                mask — a superellipse, a circle, a squircle — so the artwork
 *                must reach every corner or the mask cuts a transparent notch
 *                out of it. `CORNER_BLEED` fills the corners the artwork itself
 *                rounds off.
 *   rounded      Android's legacy `ic_launcher.png`, drawn as-is on API 25 and
 *                below (minSdk here is 22 and 23, so this is a real device, not
 *                a formality). Nothing masks it, so the artwork's own rounded
 *                corners are what should survive.
 *   circle       Android's legacy `ic_launcher_round.png`. Same era, and the
 *                launchers that ask for it do not mask it either — the file is
 *                expected to arrive round.
 *
 * Splash screens, notification icons and the web logo still come from the
 * lockup. A status-bar icon keeps only its alpha channel, so a colour tile
 * flattens to a solid blob there; and the monochrome themed-icon layer wants a
 * silhouette by definition.
 */
const APP_ICON_SOURCES = {
  family: path.join(BRAND, 'family-app-icon.png'),
  child: path.join(BRAND, 'child-app-icon.png'),
};

/**
 * Where the ground colour behind each corner is read from.
 *
 * The artwork rounds its own corners over a transparent ground, so a tile drawn
 * edge to edge still leaves four transparent notches — fatal for the iOS icon,
 * which is rejected outright for having an alpha channel, and merely ugly
 * everywhere else. Something has to be painted behind them.
 *
 * The first attempt was the artwork itself, drawn once underneath at 1.35× so
 * the corners filled with its own gradient. It works on the family tile and is
 * badly wrong on the child's: that artwork's motif runs much closer to its
 * edges, so the enlarged copy put a magnified band of the boy's hair and hoodie
 * outside the tile, dark navy against teal, and the join was the first thing the
 * eye found. What the corners need is the *colour* there, not the picture.
 *
 * So each corner is sampled instead, at this fraction along the diagonal — far
 * enough in to be inside the rounded corner on both sources, near enough out to
 * still be ground rather than shield or child. The four samples are painted as
 * quadrants, which is exact where it matters: the only part of them that is ever
 * seen is the notch in its own corner.
 */
const CORNER_SAMPLE = 0.12;

/**
 * The tile's share of an Android adaptive layer.
 *
 * An adaptive icon is a 108dp canvas of which the launcher shows the middle
 * 72dp and animates the rest during a parallax wobble. 72/108 is exactly that
 * viewport, so the artwork fills what is drawn and the layer beneath it shows
 * only while the icon is moving. Anything larger is cropped; anything smaller
 * floats the tile on the background colour with a visible second rounding.
 */
const ADAPTIVE_TILE_SHARE = 72 / 108;

const dataUri = `data:image/png;base64,${readFileSync(LOGO).toString('base64')}`;
const appIconUris = Object.fromEntries(
  Object.entries(APP_ICON_SOURCES)
    .map(([app, file]) => [app, `data:image/png;base64,${readFileSync(file).toString('base64')}`]),
);

/**
 * `brightness(0)` flattens every colour in the mark to black and `invert(1)`
 * turns that to white, so the whole lockup comes through as one solid white
 * silhouette regardless of what it was drawn in. It works because logo.png's
 * ground is transparent rather than white; if that ever changes this produces a
 * white rectangle.
 */
const WHITE = 'filter: brightness(0) invert(1);';

/** A launch screen: the lockup, centred on the brand teal. */
const splashPage = (w, h, share) => `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; }
  body {
    width: ${w}px; height: ${h}px;
    background: ${TEAL};
    display: grid; place-items: center;
  }
  img { width: ${Math.round(Math.min(w, h) * share)}px; ${WHITE} }
</style>
<img src="${dataUri}" alt="">`;

/**
 * An icon: the shield alone, cropped out of the lockup.
 *
 * Done with a clipping window rather than by scaling, because the part being
 * removed is *below* the mark — scaling alone would shrink the shield rather than
 * drop the wordmark.
 *
 * `transparent` leaves the ground out, which is what Android's adaptive
 * foreground and notification icon both need. Everything else paints teal.
 */
const iconPage = (size, share, transparent) => {
  const window = Math.round(size * share);
  const scale = window / MARK_CROP;
  const imageSize = Math.round(LOGO_PX * scale);
  const left = Math.round(-(MARK_CENTRE.x - MARK_CROP / 2) * scale);
  const top = Math.round(-(MARK_CENTRE.y - MARK_CROP / 2) * scale);

  return `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; }
  body {
    width: ${size}px; height: ${size}px;
    background: ${transparent ? 'transparent' : TEAL};
    display: grid; place-items: center;
  }
  .window { width: ${window}px; height: ${window}px; overflow: hidden; position: relative; }
  .window img {
    position: absolute; width: ${imageSize}px; height: ${imageSize}px;
    left: ${left}px; top: ${top}px;
    ${WHITE}
  }
</style>
<div class="window"><img src="${dataUri}" alt=""></div>`;
};

/**
 * Where the composed tile sits inside its source PNG.
 *
 * Both sources arrive as artwork centred on a transparent canvas with a margin
 * around it, and the margin is not the same on the two files — nor, on the
 * child's, the same on all four sides: its tile measures 348×337 and sits ten
 * pixels above centre. Measuring at render time rather than writing the numbers
 * down keeps that from being something to notice. Replacing either PNG is then
 * genuinely a file swap: the crop follows the new artwork.
 *
 * The result is squared to the *shorter* side. The child's tile is 348×337, and
 * squaring up would leave a transparent band along the top and bottom edges —
 * where no mask ever reaches, so it would survive into the shipped icon as a
 * stripe of whatever was painted behind it. Squaring down instead trims five
 * pixels off either side of a 348-pixel tile, and those five pixels are ground.
 */
const measureTile = async (browser, uri) => {
  const tab = await browser.newPage();
  await tab.setContent('<!doctype html><meta charset="utf-8"><body></body>');
  const tile = await tab.evaluate(async ({ uri, sample }) => {
    const img = new Image();
    img.src = uri;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    const at = (x, y) => (y * img.width + x) * 4;

    // Anything the artwork actually painted. The threshold is low rather than
    // zero so the anti-aliased skirt of the drop shadow counts as edge.
    let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (data[at(x, y) + 3] < 16) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) throw new Error('the icon source is entirely transparent');

    const side = Math.min(maxX - minX + 1, maxY - minY + 1);
    const x = Math.round((minX + maxX + 1 - side) / 2);
    const y = Math.round((minY + maxY + 1 - side) / 2);

    /**
     * The ground colour at one corner. The sample point can land on a pixel the
     * artwork left soft — the corner's own anti-aliasing, or the shadow outside
     * it — so it walks along the diagonal towards the centre until it reaches
     * one the artwork painted solid, and reads that.
     */
    const corner = (fx, fy) => {
      for (let step = 0; step < side / 2; step++) {
        const px = Math.round(x + (fx * side) + (fx < 0.5 ? step : -step));
        const py = Math.round(y + (fy * side) + (fy < 0.5 ? step : -step));
        const i = at(px, py);
        if (data[i + 3] >= 250) return `rgb(${data[i]}, ${data[i + 1]}, ${data[i + 2]})`;
      }
      throw new Error('no opaque pixel on the diagonal from an icon corner');
    };

    return {
      imageW: img.width,
      imageH: img.height,
      x,
      y,
      side,
      corners: [
        corner(sample, sample),
        corner(1 - sample, sample),
        corner(sample, 1 - sample),
        corner(1 - sample, 1 - sample),
      ],
    };
  }, { uri, sample: CORNER_SAMPLE });
  await tab.close();
  return tile;
};

/** Filled once the browser is up; `appIconPage` reads it. */
const tiles = {};

/**
 * A launcher icon: one app's composed artwork, in colour, fitted to a canvas.
 *
 * `share` is the tile's fraction of that canvas — 1 for a plain icon, the
 * adaptive viewport for a foreground layer. `mask` is what the platform will
 * *not* do for itself, per the three cases at the top of this file.
 *
 * The fill copy is drawn first and clipped by the same window, so it exists
 * only where the artwork's own rounded corners leave a hole. `mask: 'rounded'`
 * skips it: that is the one target where those corners are the point.
 */
const appIconPage = (app, size, share, mask) => {
  const { imageW, imageH, x, y, side, corners } = tiles[app];
  const box = Math.round(size * share);
  const scale = box / side;

  // The tile, drawn at `box` px: scale the whole source by that factor and slide
  // the crop's top-left corner up to the window's origin.
  const art = `width: ${Math.round(imageW * scale)}px; height: ${Math.round(imageH * scale)}px;`
    + ` left: ${Math.round(-x * scale)}px; top: ${Math.round(-y * scale)}px;`;

  // Four quadrants of sampled ground, meeting in the middle so there is no seam
  // to find along an edge. The artwork covers all of it but the corner notches.
  const fill = corners
    .map((colour, i) => `<div style="`
      + `position:absolute; width:50%; height:50%;`
      + `${i % 2 ? 'right' : 'left'}:0; ${i < 2 ? 'top' : 'bottom'}:0;`
      + `background:${colour}"></div>`)
    .join('');

  const radius = mask === 'circle' ? '50%' : '0';
  return `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; }
  body {
    width: ${size}px; height: ${size}px;
    background: transparent;
    display: grid; place-items: center;
  }
  .window {
    width: ${box}px; height: ${box}px;
    overflow: hidden; position: relative; border-radius: ${radius};
  }
  .art { position: absolute; ${art} }
</style>
<div class="window">
  ${mask === 'rounded' ? '' : fill}
  <img class="art" src="${appIconUris[app]}" alt="">
</div>`;
};

/* ── Density buckets ──────────────────────────────────────────────────────────
 *
 * Transcribed from what each tool scaffolded, and kept exactly. Android picks a
 * bucket by screen density, so these are the sizes that land 1:1 on a device.
 */

/** Family app launch screens. `drawable` with no qualifier is the fallback. */
const FAMILY_SPLASH_BUCKETS = {
  drawable: [480, 320],
  'drawable-port-mdpi': [320, 480],
  'drawable-port-hdpi': [480, 800],
  'drawable-port-xhdpi': [720, 1280],
  'drawable-port-xxhdpi': [960, 1600],
  'drawable-port-xxxhdpi': [1280, 1920],
  'drawable-land-mdpi': [480, 320],
  'drawable-land-hdpi': [800, 480],
  'drawable-land-xhdpi': [1280, 720],
  'drawable-land-xxhdpi': [1600, 960],
  'drawable-land-xxxhdpi': [1920, 1280],
};

/** Child app launcher icons — Expo's sizes, which are the 108dp adaptive canvas. */
const CHILD_MIPMAP = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

/**
 * Family app launcher icons, which are scaffolded at two sizes rather than one.
 *
 * Capacitor writes the legacy bitmaps at the 48dp launcher size and the adaptive
 * layers at the 108dp canvas, so unlike Expo's set above these are not
 * interchangeable: a 48dp file in a 108dp slot is a quarter-size mark, and the
 * reverse overflows the mask. Both tables are the sizes already on disk.
 */
const FAMILY_LEGACY_MIPMAP = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const FAMILY_ADAPTIVE_MIPMAP = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

/** Child app status-bar icons — the standard 24dp notification sizes. */
const CHILD_NOTIFY = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 };

/** Child app splash mark, sized per density for the bitmap layer in splashscreen.xml. */
const CHILD_SPLASH_LOGO = { mdpi: 160, hdpi: 240, xhdpi: 320, xxhdpi: 480, xxxhdpi: 640 };

const missingFamilyAndroid = 'has the family app\'s Android project been re-scaffolded?';
const missingFamilyIos = 'run `npx cap add ios` in apps/family-app first.';
const missingChild = 'has the child app\'s Android project been re-scaffolded?';

const TARGETS = [
  /**
   * ── The web logo, in the format a browser should actually be sent ──────────
   *
   * `logo.png` is the source mark for everything in this file, and both web apps
   * were also serving that exact file to browsers: 82 kB of 500×500 RGBA, drawn
   * at heights between 36 and 80 px on the sign-in screen, the sidebar, the
   * legal pages and the marketing site. It is not a badly compressed PNG — a
   * lossless re-encode comes out a few bytes *larger*, because the mark is
   * anti-aliased over five thousand distinct colours — so there is nothing to
   * win by squeezing the PNG. The format is the cost. The same image as WebP is
   * about 25 kB.
   *
   * It is generated here, from `LOGO`, rather than committed as a second
   * hand-made file, for the reason this whole script exists: two copies of the
   * mark that nothing keeps in step will drift, and the one that drifts is the
   * one nobody is looking at.
   *
   * The PNG stays exactly where it is and keeps its job. It is the favicon and
   * the apple-touch-icon — Safari will not take a WebP for either — and it is
   * the `<img>` fallback inside the `<picture>` elements that reference this
   * file, so a browser that cannot decode WebP still gets the logo. See
   * `BrandLogo` in packages/shared.
   */
  ...[
    ['family', FAMILY_PUBLIC],
    ['admin', ADMIN_PUBLIC],
  ].map(([app, dir]) => ({
    label: `${app} public/logo.webp`,
    file: path.join(dir, 'logo.webp'),
    w: LOGO_PX, h: LOGO_PX, kind: 'webp',
  })),

  // ── Family app · Android launch screens ────────────────────────────────────
  ...Object.entries(FAMILY_SPLASH_BUCKETS).map(([bucket, [w, h]]) => ({
    label: `family android ${bucket}/splash.png`,
    file: path.join(FAMILY_RES, bucket, 'splash.png'),
    w, h, share: LOGO_SHARE, kind: 'splash',
    missing: `${bucket} does not exist — ${missingFamilyAndroid}`,
  })),

  // ── Family app · iOS ───────────────────────────────────────────────────────
  /**
   * Three files, one image. The asset catalogue declares 1x, 2x and 3x and
   * Capacitor points all three at the same 2732×2732 artwork — the square is
   * already large enough for the densest screen. Rendering is cached, so this
   * costs one draw.
   */
  ...['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'].map((name) => ({
    label: `family ios Splash.imageset/${name}`,
    file: path.join(XCASSETS, 'Splash.imageset', name),
    w: IOS_SPLASH_PX, h: IOS_SPLASH_PX, share: IOS_SPLASH_LOGO_SHARE, kind: 'splash',
    missing: `Splash.imageset does not exist — ${missingFamilyIos}`,
  })),
  {
    label: 'family ios AppIcon-512@2x.png',
    file: path.join(XCASSETS, 'AppIcon.appiconset', 'AppIcon-512@2x.png'),
    w: IOS_ICON_PX, h: IOS_ICON_PX, share: 1, kind: 'appIcon', app: 'family', mask: 'none',
    missing: `AppIcon.appiconset does not exist — ${missingFamilyIos}`,
  },

  // ── Family app · Android launcher icons ────────────────────────────────────
  /**
   * These are new here, and the reason is worth writing down: they were the one
   * set of icons this script did not draw, and nothing else drew them either.
   * The family app shipped Capacitor's scaffolded placeholder — a pale blue "X"
   * on white graph paper — to the Play Store, for every release. The header of
   * this file has claimed since it was written that the fault was fixed; only
   * the child app's copy of it ever was, and a comment is not a target.
   *
   * `ic_launcher_background.xml` is teal rather than the scaffolded #FFFFFF for
   * the same reason the child app's is: it is what shows in the sliver the
   * parallax reveals, and white there frames the tile.
   */
  ...Object.entries(FAMILY_LEGACY_MIPMAP).flatMap(([density, px]) => [
    {
      label: `family android mipmap-${density}/ic_launcher.png`,
      file: path.join(FAMILY_RES, `mipmap-${density}`, 'ic_launcher.png'),
      w: px, h: px, share: 1, kind: 'appIcon', app: 'family', mask: 'rounded', transparent: true,
      missing: `mipmap-${density} does not exist — ${missingFamilyAndroid}`,
    },
    {
      label: `family android mipmap-${density}/ic_launcher_round.png`,
      file: path.join(FAMILY_RES, `mipmap-${density}`, 'ic_launcher_round.png'),
      w: px, h: px, share: 1, kind: 'appIcon', app: 'family', mask: 'circle', transparent: true,
      missing: `mipmap-${density} does not exist — ${missingFamilyAndroid}`,
    },
  ]),

  ...Object.entries(FAMILY_ADAPTIVE_MIPMAP).flatMap(([density, px]) => [
    {
      label: `family android mipmap-${density}/ic_launcher_foreground.png`,
      file: path.join(FAMILY_RES, `mipmap-${density}`, 'ic_launcher_foreground.png'),
      w: px, h: px, share: ADAPTIVE_TILE_SHARE, kind: 'appIcon', app: 'family', mask: 'none',
      transparent: true,
      missing: `mipmap-${density} does not exist — ${missingFamilyAndroid}`,
    },
    {
      label: `family android mipmap-${density}/ic_launcher_monochrome.png`,
      file: path.join(FAMILY_RES, `mipmap-${density}`, 'ic_launcher_monochrome.png'),
      w: px, h: px, share: ADAPTIVE_SHARE, kind: 'icon', transparent: true,
      missing: `mipmap-${density} does not exist — ${missingFamilyAndroid}`,
    },
  ]),

  // ── Child app · Expo assets, which drive the iOS prebuild ──────────────────
  /**
   * The App Store icon, and the one asset here with a hard rejection attached:
   * App Store Connect refuses an icon with an alpha channel, naming the file
   * rather than the reason. Nothing strips it because nothing has to — the tile
   * is drawn edge to edge over sampled ground, so the capture is fully opaque
   * and Chromium writes colour type 2, no alpha channel at all. That is what
   * `mask: 'none'` at `share: 1` buys, and why the corner fill is not optional
   * here: a transparent notch in one corner would flip the whole file to type 6.
   *
   * Known soft spot, and the one thing worth fixing with a better file rather
   * than better code: `brand/child-app-icon.png` is 500×500 with a 337-pixel
   * tile inside it, so this 1024 is a 3× upscale. It is legible, and it is the
   * largest anything draws the icon. A re-export of the artwork at 1024 drops
   * straight in — the crop is measured, not written down.
   */
  /**
   * Written once per platform project, because Expo resolves these paths from
   * the project root and there are two roots now. Same source mark and the same
   * shares on both — the duplication is on disk, not in this file, which is the
   * point: a change lands in both or in neither.
   */
  ...[
    ['android', CHILD_ANDROID_ASSETS],
    ['ios', CHILD_IOS_ASSETS],
  ].flatMap(([platform, dir]) => [
    {
      label: `child ${platform} assets/icon.png`,
      file: path.join(dir, 'icon.png'),
      w: IOS_ICON_PX, h: IOS_ICON_PX, share: 1, kind: 'appIcon', app: 'child', mask: 'none',
    },
    {
      label: `child ${platform} assets/splash.png`,
      file: path.join(dir, 'splash.png'),
      w: EXPO_SPLASH[0], h: EXPO_SPLASH[1], share: LOGO_SHARE, kind: 'splash',
    },
    {
      label: `child ${platform} assets/notification-icon.png`,
      file: path.join(dir, 'notification-icon.png'),
      w: 96, h: 96, share: NOTIFY_SHARE, kind: 'icon', transparent: true,
    },
    /**
     * Android only. An adaptive icon is a foreground layer the launcher
     * composites over a separate background; iOS has no equivalent, and
     * ios/app.config.js never names one, so writing it there would leave a file
     * nothing reads.
     */
    ...(platform === 'android' ? [{
      label: `child ${platform} assets/adaptive-icon.png`,
      file: path.join(dir, 'adaptive-icon.png'),
      w: IOS_ICON_PX, h: IOS_ICON_PX, share: ADAPTIVE_TILE_SHARE, kind: 'appIcon', app: 'child',
      mask: 'none', transparent: true,
    }] : []),
  ]),

  // ── Child app · Android, written directly because prebuild never runs ──────
  ...Object.entries(CHILD_MIPMAP).flatMap(([density, px]) => [
    {
      label: `child android mipmap-${density}/ic_launcher.png`,
      file: path.join(CHILD_RES, `mipmap-${density}`, 'ic_launcher.png'),
      w: px, h: px, share: 1, kind: 'appIcon', app: 'child', mask: 'rounded', transparent: true,
      missing: `mipmap-${density} does not exist — ${missingChild}`,
    },
    /**
     * The round variant is a separate file rather than a copy of the square one
     * because a launcher that asks for `ic_launcher_round` draws it as it finds
     * it — the name is a promise that the file is already round, not a request
     * for something to be masked. It was previously the square tile with the
     * mark shrunk enough to survive being clipped, which is the same idea
     * arrived at without a circle; now the tile is genuinely cut to one.
     */
    {
      label: `child android mipmap-${density}/ic_launcher_round.png`,
      file: path.join(CHILD_RES, `mipmap-${density}`, 'ic_launcher_round.png'),
      w: px, h: px, share: 1, kind: 'appIcon', app: 'child', mask: 'circle', transparent: true,
      missing: `mipmap-${density} does not exist — ${missingChild}`,
    },
    {
      label: `child android mipmap-${density}/ic_launcher_foreground.png`,
      file: path.join(CHILD_RES, `mipmap-${density}`, 'ic_launcher_foreground.png'),
      w: px, h: px, share: ADAPTIVE_TILE_SHARE, kind: 'appIcon', app: 'child', mask: 'none',
      transparent: true,
      missing: `mipmap-${density} does not exist — ${missingChild}`,
    },
    /**
     * The themed-icon layer, which the launcher fills with one colour from the
     * wallpaper and therefore reads only as a silhouette. That is why it stays
     * the lockup's shield: the artwork flattened to its alpha channel is a
     * rounded square and nothing else, so pointing `<monochrome>` at the
     * foreground — which is what both XMLs used to do, back when the foreground
     * *was* the shield — would now put a blank tile on the home screen of every
     * phone with themed icons turned on.
     */
    {
      label: `child android mipmap-${density}/ic_launcher_monochrome.png`,
      file: path.join(CHILD_RES, `mipmap-${density}`, 'ic_launcher_monochrome.png'),
      w: px, h: px, share: ADAPTIVE_SHARE, kind: 'icon', transparent: true,
      missing: `mipmap-${density} does not exist — ${missingChild}`,
    },
  ]),

  ...Object.entries(CHILD_NOTIFY).map(([density, px]) => ({
    label: `child android drawable-${density}/notification_icon.png`,
    file: path.join(CHILD_RES, `drawable-${density}`, 'notification_icon.png'),
    w: px, h: px, share: NOTIFY_SHARE, kind: 'icon', transparent: true,
    missing: `drawable-${density} does not exist — ${missingChild}`,
  })),

  ...Object.entries(CHILD_SPLASH_LOGO).map(([density, px]) => ({
    label: `child android drawable-${density}/splashscreen_logo.png`,
    file: path.join(CHILD_RES, `drawable-${density}`, 'splashscreen_logo.png'),
    w: px, h: px, share: 1, kind: 'splashLogo', transparent: true,
    missing: `drawable-${density} does not exist — ${missingChild}`,
  })),

  // ── Child desktop · Windows and macOS ──────────────────────────────────────
  /**
   * Two files per platform project, and one of them is not what it looks like.
   *
   * `build/icon.png` is a *source*: electron-builder converts it to `.ico` for
   * the Windows installer and `.icns` for the Mac bundle at package time, which
   * is why there is no committed icon in either of those formats. It has to be
   * at least 512×512 or the conversion is refused, and opaque — the same alpha
   * rule the App Store icon above is drawn for, arrived at from the other
   * direction.
   *
   * `build/tray.png` is drawn on the brand teal rather than transparent, which
   * is a deliberate difference from every other icon here. A white silhouette on
   * nothing is the right answer for Android's status bar, where the system tints
   * it — and the wrong one for a desktop tray, where the same file has to be
   * legible against a black Windows taskbar in dark mode and a white one in
   * light mode without either platform touching it. A small teal tile is visible
   * on both.
   */
  ...[
    ['windows', DESKTOP_WINDOWS],
    ['macos', DESKTOP_MACOS],
  ].flatMap(([platform, dir]) => [
    {
      label: `child-desktop ${platform} build/icon.png`,
      file: path.join(dir, 'icon.png'),
      w: IOS_ICON_PX, h: IOS_ICON_PX, share: ICON_SHARE, kind: 'icon',
    },
    {
      label: `child-desktop ${platform} build/tray.png`,
      file: path.join(dir, 'tray.png'),
      w: 32, h: 32, share: 0.78, kind: 'icon',
    },
  ]),
];

const check = process.argv.includes('--check');
const browser = await chromium.launch();
const stale = [];

for (const [app, uri] of Object.entries(appIconUris)) tiles[app] = await measureTile(browser, uri);

/**
 * The WebP copy of the source mark.
 *
 * Not a screenshot: Playwright only writes PNG and JPEG, and a JPEG has no alpha
 * channel, so the transparent ground the whole brand depends on would come back
 * as a black square. The canvas encoder is the only route to WebP here, and it
 * keeps the alpha.
 *
 * Quality 0.92 rather than lossless — lossless WebP of this mark is barely
 * smaller than the PNG, and the artefacts of a lossy encode at this quality are
 * not visible on a logo displayed at 80 px, which is the largest anything in
 * either app draws it.
 */
const WEBP_QUALITY = 0.92;

const encodeWebp = async (w, h) => {
  const tab = await browser.newPage();
  await tab.setContent('<!doctype html><meta charset="utf-8"><body></body>');
  const base64 = await tab.evaluate(async ({ uri, width, height, quality }) => {
    const img = new Image();
    img.src = uri;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, width, height);
    const url = canvas.toDataURL('image/webp', quality);
    if (!url.startsWith('data:image/webp')) throw new Error('this Chromium cannot encode WebP');
    return url.slice(url.indexOf(',') + 1);
  }, { uri: dataUri, width: w, height: h, quality: WEBP_QUALITY });
  await tab.close();
  return Buffer.from(base64, 'base64');
};

/** Identical geometry is drawn once — the three iOS splash files share a render. */
const renders = new Map();
const render = async ({ w, h, share, kind, transparent, app, mask }) => {
  const key = `${kind}:${app || ''}:${w}x${h}@${share}:${mask || ''}${transparent ? ':a' : ''}`;
  if (!renders.has(key)) {
    if (kind === 'webp') {
      renders.set(key, await encodeWebp(w, h));
      return renders.get(key);
    }
    const tab = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const html = kind === 'splash'
      ? splashPage(w, h, share)
      // The Android splash bitmap is the lockup on nothing: splashscreen.xml
      // paints the teal underneath it as a separate layer, so painting it here
      // too would draw a teal rectangle over the whole screen.
      : kind === 'splashLogo'
        ? `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0}body{width:${w}px;height:${h}px;display:grid;place-items:center;background:transparent}
img{width:${w}px;${WHITE}}</style><img src="${dataUri}" alt="">`
        : kind === 'appIcon'
          ? appIconPage(app, w, share, mask)
          : iconPage(w, share, transparent);
    await tab.setContent(html);
    renders.set(key, await tab.screenshot({ type: 'png', omitBackground: !!transparent }));
    await tab.close();
  }
  return renders.get(key);
};

for (const target of TARGETS) {
  if (!existsSync(path.dirname(target.file))) throw new Error(target.missing || `${target.file} has no directory`);

  // PNG for all but the two `kind: 'webp'` targets — see `encodeWebp`.
  const image = await render(target);

  if (check) {
    if (!existsSync(target.file) || !readFileSync(target.file).equals(image)) stale.push(target.label);
  } else {
    writeFileSync(target.file, image);
    console.log(`${target.label}  ${target.w}×${target.h}`);
  }
}

await browser.close();

if (check) {
  if (stale.length) {
    console.error(`Out of date, re-run without --check:\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`Every brand asset matches its source and the brand teal (${TARGETS.length} files).`);
}
