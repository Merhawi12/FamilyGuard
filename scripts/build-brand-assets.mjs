#!/usr/bin/env node
/**
 * Every launch screen, launcher icon and notification icon in the repo, drawn
 * from one source mark.
 *
 *   node scripts/build-brand-assets.mjs          # writes them
 *   node scripts/build-brand-assets.mjs --check  # verifies they are current
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
 * Keeping the generator in the repo rather than hand-making eighty PNGs once is
 * what makes a change to `logo.png` or to the brand teal a re-run instead of an
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
 *   child app    Expo, but *bare*: `android/` is committed source holding the
 *                accessibility, VPN and usage-stats modules, and `expo prebuild`
 *                would delete it — so prebuild is never run for Android and
 *                app.json's icon/splash keys have no effect there. Those files
 *                are written into android/res directly, exactly like the family
 *                app. iOS has no committed project, so EAS *does* prebuild it,
 *                and there app.json is the source of truth — which is why the
 *                same mark is also written to apps/child-app/assets/.
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
const CHILD_RES = path.join(REPO, 'apps/child-app/android/app/src/main/res');
const CHILD_ASSETS = path.join(REPO, 'apps/child-app/assets');
const LOGO = path.join(REPO, 'apps/family-app/public/logo.png');

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

const dataUri = `data:image/png;base64,${readFileSync(LOGO).toString('base64')}`;

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

/** Child app status-bar icons — the standard 24dp notification sizes. */
const CHILD_NOTIFY = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 };

/** Child app splash mark, sized per density for the bitmap layer in splashscreen.xml. */
const CHILD_SPLASH_LOGO = { mdpi: 160, hdpi: 240, xhdpi: 320, xxhdpi: 480, xxxhdpi: 640 };

const missingFamilyAndroid = 'has the family app\'s Android project been re-scaffolded?';
const missingFamilyIos = 'run `npx cap add ios` in apps/family-app first.';
const missingChild = 'has the child app\'s Android project been re-scaffolded?';

const TARGETS = [
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
    w: IOS_ICON_PX, h: IOS_ICON_PX, share: ICON_SHARE, kind: 'icon',
    missing: `AppIcon.appiconset does not exist — ${missingFamilyIos}`,
  },

  // ── Child app · Expo assets, which drive the iOS prebuild ──────────────────
  /**
   * The App Store icon, and the one asset here with a hard rejection attached:
   * App Store Connect refuses an icon with an alpha channel, naming the file
   * rather than the reason. Nothing strips it because nothing has to — the page
   * paints an opaque teal ground and Chromium writes colour type 2, no alpha
   * channel at all, whenever a capture is fully opaque. `transparent: true`
   * below is what produces type 6, and it is used only where alpha is required.
   *
   * 1024 also replaces a 500×500 source that iOS would have upscaled.
   */
  {
    label: 'child expo assets/icon.png',
    file: path.join(CHILD_ASSETS, 'icon.png'),
    w: IOS_ICON_PX, h: IOS_ICON_PX, share: ICON_SHARE, kind: 'icon',
  },
  {
    label: 'child expo assets/adaptive-icon.png',
    file: path.join(CHILD_ASSETS, 'adaptive-icon.png'),
    w: IOS_ICON_PX, h: IOS_ICON_PX, share: ADAPTIVE_SHARE, kind: 'icon', transparent: true,
  },
  {
    label: 'child expo assets/splash.png',
    file: path.join(CHILD_ASSETS, 'splash.png'),
    w: EXPO_SPLASH[0], h: EXPO_SPLASH[1], share: LOGO_SHARE, kind: 'splash',
  },
  {
    label: 'child expo assets/notification-icon.png',
    file: path.join(CHILD_ASSETS, 'notification-icon.png'),
    w: 96, h: 96, share: NOTIFY_SHARE, kind: 'icon', transparent: true,
  },

  // ── Child app · Android, written directly because prebuild never runs ──────
  ...Object.entries(CHILD_MIPMAP).flatMap(([density, px]) => [
    {
      label: `child android mipmap-${density}/ic_launcher.png`,
      file: path.join(CHILD_RES, `mipmap-${density}`, 'ic_launcher.png'),
      w: px, h: px, share: ICON_SHARE, kind: 'icon',
      missing: `mipmap-${density} does not exist — ${missingChild}`,
    },
    /**
     * The round variant is a separate file rather than a copy of the square one
     * because launchers that ask for `ic_launcher_round` are the ones that will
     * clip it to a circle, and the mark has to sit inside that circle. Drawn at
     * the adaptive share for exactly that reason.
     */
    {
      label: `child android mipmap-${density}/ic_launcher_round.png`,
      file: path.join(CHILD_RES, `mipmap-${density}`, 'ic_launcher_round.png'),
      w: px, h: px, share: ADAPTIVE_SHARE, kind: 'icon',
      missing: `mipmap-${density} does not exist — ${missingChild}`,
    },
    {
      label: `child android mipmap-${density}/ic_launcher_foreground.png`,
      file: path.join(CHILD_RES, `mipmap-${density}`, 'ic_launcher_foreground.png'),
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
];

const check = process.argv.includes('--check');
const browser = await chromium.launch();
const stale = [];

/** Identical geometry is drawn once — the three iOS splash files share a render. */
const renders = new Map();
const render = async ({ w, h, share, kind, transparent }) => {
  const key = `${kind}:${w}x${h}@${share}${transparent ? ':a' : ''}`;
  if (!renders.has(key)) {
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
        : iconPage(w, share, transparent);
    await tab.setContent(html);
    renders.set(key, await tab.screenshot({ type: 'png', omitBackground: !!transparent }));
    await tab.close();
  }
  return renders.get(key);
};

for (const target of TARGETS) {
  if (!existsSync(path.dirname(target.file))) throw new Error(target.missing || `${target.file} has no directory`);

  const png = await render(target);

  if (check) {
    if (!existsSync(target.file) || !readFileSync(target.file).equals(png)) stale.push(target.label);
  } else {
    writeFileSync(target.file, png);
    console.log(`${target.label}  ${target.w}×${target.h}`);
  }
}

await browser.close();

if (check) {
  if (stale.length) {
    console.error(`Out of date, re-run without --check:\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`Every brand asset matches the current logo and brand teal (${TARGETS.length} files).`);
}
