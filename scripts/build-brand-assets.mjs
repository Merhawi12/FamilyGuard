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
      w: IOS_ICON_PX, h: IOS_ICON_PX, share: ICON_SHARE, kind: 'icon',
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
      w: IOS_ICON_PX, h: IOS_ICON_PX, share: ADAPTIVE_SHARE, kind: 'icon', transparent: true,
    }] : []),
  ]),

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
const render = async ({ w, h, share, kind, transparent }) => {
  const key = `${kind}:${w}x${h}@${share}${transparent ? ':a' : ''}`;
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
  console.log(`Every brand asset matches the current logo and brand teal (${TARGETS.length} files).`);
}
