/**
 * The child app ships to two stores from one codebase, and the two halves of its
 * configuration live in files that cannot see each other.
 *
 * `app.json` is the source of truth for iOS, because there is no committed
 * `ios/` directory and EAS runs `expo prebuild` on its own machines. It is
 * *not* the source of truth for Android: `apps/child-app/android` is committed
 * source holding the accessibility, VPN and usage-stats modules, and prebuild
 * would delete it, so it is never run there and `AndroidManifest.xml` is what
 * actually ships. Two files, one app, no build step that reconciles them.
 *
 * Everything asserted here is something that drifts silently. Nothing throws
 * when a bundle identifier stops matching a package name or a URL scheme is
 * changed on one side — the app builds, installs, launches, and one platform
 * quietly stops doing something the other still does. Several of these failures
 * only surface at an App Store upload, which is the most expensive place to find
 * out.
 *
 * Read as text rather than imported, matching familyBrandColors.test.js: this
 * suite is CommonJS and reaching into another workspace's tooling to parse XML
 * would cost more than four regexes.
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '../../..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const CHILD_RES = 'apps/child-app/android/app/src/main/res';

const appConfig = JSON.parse(read('apps/child-app/app.json')).expo;
const manifest = read('apps/child-app/android/app/src/main/AndroidManifest.xml');

/** PNG header: width at byte 16, height at 20, colour type at 25. */
const png = (p) => {
  const b = fs.readFileSync(path.join(REPO, p));
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colourType: b[25] };
};
const HAS_ALPHA = 6;
const NO_ALPHA = 2;

const DENSITIES = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];

describe('child app — Android and iOS agree', () => {
  test('the iOS bundle identifier is the Android package name', () => {
    // Not required by either platform, and deliberately held anyway: every
    // support conversation, every Firebase app registration and every push
    // credential is filed under one of these two strings, and having them differ
    // buys nothing while making all three ambiguous.
    expect(appConfig.ios.bundleIdentifier).toBe(appConfig.android.package);
  });

  test('both platforms are declared buildable', () => {
    expect(appConfig.platforms).toEqual(expect.arrayContaining(['android', 'ios']));
  });

  test('both platforms are locked to portrait', () => {
    // The child app is a phone agent with a fixed layout. Android states this on
    // the activity; iOS gets it from app.json, and Expo's default would also
    // allow upside-down.
    expect(appConfig.orientation).toBe('portrait');
    expect(manifest).toMatch(/android:screenOrientation="portrait"/);
    expect(appConfig.ios.infoPlist.UISupportedInterfaceOrientations)
      .toEqual(['UIInterfaceOrientationPortrait']);
  });
});

describe('child app — deep links', () => {
  /**
   * The scheme is written twice: by hand in the manifest's intent filter, and as
   * `scheme` in app.json for the iOS project EAS generates. If they diverge, a
   * link works on one platform and silently does nothing on the other — the app
   * still opens, just on whatever screen it would have opened on anyway, which
   * is why this is easy to miss.
   */
  test('the URL scheme is the same on both platforms', () => {
    /**
     * Scoped to MainActivity rather than searched for across the manifest.
     *
     * `<queries>` also declares `android:scheme="https"` — that is package
     * visibility, the declaration that lets the usage-stats reporter resolve
     * other apps' names on Android 11+, and it has nothing to do with linking.
     * A manifest-wide search finds it first and compares the app's URL scheme
     * against the string "https", which is how this assertion first failed.
     */
    const activity = /<activity[^>]*\.MainActivity[\s\S]*?<\/activity>/.exec(manifest);
    expect(activity).not.toBeNull();

    const androidScheme = /<data android:scheme="([^"]+)"\s*\/>/.exec(activity[0]);
    expect(androidScheme).not.toBeNull();
    expect(appConfig.scheme).toBe(androidScheme[1]);
  });

  test('the app actually consumes the scheme it registers', () => {
    // A registered scheme with no linking config is the state this was found in:
    // declared on Android since the project was scaffolded, and wired to nothing.
    const app = read('apps/child-app/App.js');
    expect(app).toMatch(/prefixes:/);
    expect(app).toContain(`${appConfig.scheme}://`);
  });
});

describe('child app — icons and launch screens', () => {
  /**
   * The one with a hard rejection attached: App Store Connect refuses an icon
   * with an alpha channel and names the file rather than the reason. The source
   * this replaced was a 500×500 RGBA lockup, so it would have been rejected on
   * the first upload and blurry if it had not been.
   */
  test('the iOS icon is 1024 square with no alpha channel', () => {
    expect(png('apps/child-app/assets/icon.png')).toEqual({
      width: 1024, height: 1024, colourType: NO_ALPHA,
    });
  });

  test('the assets that must keep an alpha channel have one', () => {
    // Android throws away every colour in a notification icon and tints the
    // silhouette, so only the alpha channel carries the shape. An adaptive
    // foreground is composited over a separate background layer for the same
    // reason. Either one flattened to opaque becomes a solid teal square.
    expect(png('apps/child-app/assets/adaptive-icon.png').colourType).toBe(HAS_ALPHA);
    expect(png('apps/child-app/assets/notification-icon.png').colourType).toBe(HAS_ALPHA);
  });

  test('every Android density has all three launcher icons', () => {
    for (const density of DENSITIES) {
      for (const name of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground']) {
        const file = `${CHILD_RES}/mipmap-${density}/${name}.png`;
        expect(fs.existsSync(path.join(REPO, file))).toBe(true);
      }
      expect(png(`${CHILD_RES}/mipmap-${density}/ic_launcher_foreground.png`).colourType).toBe(HAS_ALPHA);
    }
  });

  /**
   * The adaptive icon is what Android 8 and later draws, and it went missing in
   * a way that left no trace: the per-density `ic_launcher_foreground.png` files
   * existed from the day the project was scaffolded and nothing referenced them,
   * so the launcher silently fell back to the legacy square bitmap.
   */
  test('the adaptive icon references the foreground, on a ground it can be seen against', () => {
    for (const name of ['ic_launcher', 'ic_launcher_round']) {
      const xml = read(`${CHILD_RES}/mipmap-anydpi-v26/${name}.xml`);
      expect(xml).toMatch(/<foreground android:drawable="@mipmap\/ic_launcher_foreground"\s*\/>/);
      expect(xml).toMatch(/<background android:drawable="@color\/iconBackground"\s*\/>/);
    }

    // The foreground is a *white* shield on transparent, so a white ground makes
    // the icon a blank tile. This was #FFFFFF while nothing referenced the
    // foreground, which is exactly why it was never noticed.
    const iconBackground = /<color name="iconBackground">(#[0-9A-Fa-f]{6})<\/color>/
      .exec(read(`${CHILD_RES}/values/colors.xml`));
    expect(iconBackground).not.toBeNull();
    expect(iconBackground[1].toLowerCase()).not.toBe('#ffffff');
  });

  test('the Android launch screen draws the mark, not just the ground', () => {
    // A layer-list with only a colour is a blank teal screen, which is what a
    // cold launch of this app used to be.
    const splash = read(`${CHILD_RES}/drawable/splashscreen.xml`);
    expect(splash).toMatch(/@drawable\/splashscreen_logo/);
    for (const density of DENSITIES) {
      expect(fs.existsSync(path.join(REPO, `${CHILD_RES}/drawable-${density}/splashscreen_logo.png`))).toBe(true);
    }
  });

  test('iOS is given a launch image rather than a bare colour', () => {
    expect(appConfig.splash.image).toBeTruthy();
    expect(fs.existsSync(path.join(REPO, 'apps/child-app', appConfig.splash.image))).toBe(true);
  });
});

/* ── The committed iOS project, if there is one ───────────────────────────────
 *
 * There is normally no `apps/child-app/ios`: EAS prebuilds it from app.json on
 * its own machines, because `expo prebuild --platform ios` refuses to run on the
 * Windows development machine at all.
 *
 * If one is committed — .github/workflows/ios-child-prebuild.yml generates,
 * compiles and commits it on a macOS runner — the trade changes in a way that is
 * silent and expensive. EAS decides a platform's workflow by looking for its
 * native directory, so a committed `ios/` means EAS stops prebuilding and builds
 * what is in the repo. **From that point app.json's iOS keys stop taking effect
 * on their own.** Change a permission string, a background mode or the URL
 * scheme and nothing happens: the build is made from a project generated before
 * the edit, and the only evidence is a store submission behaving like the old
 * configuration.
 *
 * So these run only when the directory exists, and they assert the generated
 * Info.plist still says what app.json says. Regenerating is the fix, and the
 * failure names that.
 */
const IOS_DIR = path.join(REPO, 'apps/child-app/ios');
const iosInfoPlist = (() => {
  if (!fs.existsSync(IOS_DIR)) return null;
  // Prebuild writes one Info.plist, but the app directory's name follows the
  // Expo `name`, so it is found rather than assumed.
  const found = fs.readdirSync(IOS_DIR)
    .map((entry) => path.join(IOS_DIR, entry, 'Info.plist'))
    .find((candidate) => fs.existsSync(candidate));
  return found ? fs.readFileSync(found, 'utf8') : null;
})();

/** `<key>K</key><string>V</string>` → `V`. Also handles `<true/>` / `<false/>`. */
const plistValue = (xml, key) => {
  const at = xml.indexOf(`<key>${key}</key>`);
  if (at === -1) return undefined;
  const rest = xml.slice(at + `<key>${key}</key>`.length);
  const scalar = /^\s*<(string|true|false|integer)\s*\/?>([^<]*)/.exec(rest);
  if (!scalar) return undefined;
  if (scalar[1] === 'true') return true;
  if (scalar[1] === 'false') return false;
  return scalar[2];
};

/** The `<string>` entries of the `<array>` following a key. */
const plistArray = (xml, key) => {
  const at = xml.indexOf(`<key>${key}</key>`);
  if (at === -1) return undefined;
  const block = /<array>([\s\S]*?)<\/array>/.exec(xml.slice(at));
  if (!block) return undefined;
  return [...block[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
};

const describeCommittedIos = iosInfoPlist ? describe : describe.skip;

describeCommittedIos('child app — the committed iOS project agrees with app.json', () => {
  const regenerate = 'Re-run .github/workflows/ios-child-prebuild.yml and commit the result.';

  test(`the URL scheme matches — ${regenerate}`, () => {
    expect(plistArray(iosInfoPlist, 'CFBundleURLSchemes')).toContain(appConfig.scheme);
  });

  test(`the background modes match — ${regenerate}`, () => {
    expect(plistArray(iosInfoPlist, 'UIBackgroundModes').sort())
      .toEqual([...appConfig.ios.infoPlist.UIBackgroundModes].sort());
  });

  test(`App Transport Security is still locked down — ${regenerate}`, () => {
    expect(plistValue(iosInfoPlist, 'NSAllowsArbitraryLoads')).toBe(false);
  });

  test(`the location strings match — ${regenerate}`, () => {
    // These come from the expo-location plugin rather than `infoPlist`, which is
    // the pairing most likely to drift: the plugin's config and the generated
    // plist are two files apart with a build step between them.
    const plugin = appConfig.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-location')[1];
    expect(plistValue(iosInfoPlist, 'NSLocationWhenInUseUsageDescription'))
      .toBe(plugin.locationWhenInUsePermission);
    expect(plistValue(iosInfoPlist, 'NSLocationAlwaysAndWhenInUseUsageDescription'))
      .toBe(plugin.locationAlwaysAndWhenInUsePermission);
  });
});

describe('child app — transport security', () => {
  /**
   * Expo's default Info.plist sets `NSAllowsArbitraryLoads: true`, which turns
   * App Transport Security off for every host. This app talks to exactly one
   * origin over HTTPS, so the only thing that default buys is a weaker app and a
   * question from App Store review.
   *
   * Local networking stays on so a LAN dev build against
   * `EXPO_PUBLIC_API_URL=http://10.0.0.x:5000` still works — that is a private
   * address, which is the case the exemption exists for.
   */
  test('App Transport Security is not disabled wholesale', () => {
    const ats = appConfig.ios.infoPlist.NSAppTransportSecurity;
    expect(ats).toBeDefined();
    expect(ats.NSAllowsArbitraryLoads).toBe(false);
    expect(ats.NSAllowsLocalNetworking).toBe(true);
  });

  test('the storage permissions removed from the manifest cannot come back', () => {
    // Nothing in the app uses them, and on a product that monitors children they
    // are exactly the kind of over-broad request that draws Play review
    // scrutiny. They are absent from the committed manifest; `blockedPermissions`
    // is what stops Expo's defaults reintroducing them if anyone ever prebuilds.
    expect(manifest).not.toMatch(/EXTERNAL_STORAGE/);
    expect(appConfig.android.blockedPermissions).toEqual(expect.arrayContaining([
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
    ]));
  });
});
