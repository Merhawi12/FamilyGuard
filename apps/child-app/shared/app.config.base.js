/**
 * The half of the Expo config that must be identical in both stores.
 *
 * Splitting the app into `../android` and `../ios` gave each platform its own
 * `app.config.js`, and that trade has a cost: the pairs that have to agree —
 * bundle identifier vs. package name, the URL scheme registered on both sides,
 * the version a support conversation refers to — became two strings instead of
 * one, with nothing between them. `childAppPlatforms.test.js` was written to
 * catch exactly that drift, back when it was a real possibility.
 *
 * This file removes the possibility instead. Both platform configs spread
 * `base` and both read `BUNDLE_ID`, so there is still only one place to change
 * a version or a scheme. What each platform config adds is only the part that
 * genuinely differs — permissions, launcher icons, Info.plist keys — and those
 * are the parts that *should* be stated separately, because they are what the
 * split was for.
 *
 * Asset paths stay relative (`./assets/…`). Expo resolves them from the project
 * root — which is `../android` or `../ios`, never this directory — so each
 * project supplies its own copy of the files named here. See
 * `scripts/build-brand-assets.mjs`, which writes both.
 */

/**
 * One string, two stores. Neither platform requires it to match the other, and
 * they are held equal anyway: every support conversation, Firebase app
 * registration and push credential is filed under one of these, and letting
 * them differ buys nothing while making all three ambiguous.
 */
const BUNDLE_ID = 'com.parentix.child';

const base = {
  /**
   * The name on both stores and on the child's launcher. The parent's half of
   * the product ships separately as "Parentix Family", so neither app can be
   * called plain "Parentix" without one of the two being the wrong download.
   */
  name: 'Parentix Child',
  slug: 'familyguard-child',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  scheme: BUNDLE_ID,
  backgroundColor: '#0E7C86',
  userInterfaceStyle: 'light',
  splash: {
    image: './assets/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#0E7C86',
  },
  assetBundlePatterns: ['assets/*'],
  plugins: [
    [
      'expo-notifications',
      {
        icon: './assets/notification-icon.png',
        color: '#0E7C86',
      },
    ],
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission: 'Parentix shares this phone\'s location with your parent so they can see you are safe. Location is sent while the app is open and in the background.',
        locationAlwaysPermission: 'Parentix shares this phone\'s location with your parent so they can see you are safe, including when the app is in the background.',
        locationWhenInUsePermission: 'Parentix shares this phone\'s location with your parent so they can see you are safe.',
        isIosBackgroundLocationEnabled: true,
      },
    ],
    'expo-font',
  ],
  /**
   * One EAS project for both platforms, deliberately: this is one product with
   * one release train, and the build history, Play listing and store
   * credentials all already hang off this id. Each platform project builds only
   * its own platform from it.
   */
  extra: {
    eas: {
      projectId: 'b9ba998c-af61-4f0c-a1ce-3b13cde4311f',
    },
  },
  owner: 'familyguard',
};

module.exports = { base, BUNDLE_ID };
