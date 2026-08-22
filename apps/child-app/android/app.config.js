/**
 * The Android project's Expo config.
 *
 * ── Read this before editing anything below ──────────────────────────────────
 *
 * **Most of this file is inert.** `android/` (the Gradle project one level down)
 * is committed source holding the accessibility service, the VPN service, the
 * usage-stats module and the DNS reporter, and `expo prebuild` would delete all
 * of it — so prebuild is never run here and `AndroidManifest.xml` is what
 * actually ships. Editing `permissions` below changes nothing on a device.
 *
 * It is kept, and kept correct, for three reasons: `expo start` and the dev
 * client read it; `blockedPermissions` is what would stop Expo's defaults
 * reintroducing the storage permissions if anyone ever did prebuild; and
 * `childAppPlatforms.test.js` compares it against the manifest, so a
 * disagreement between the two fails a test run rather than a store review.
 *
 * The table in docs/CHILD-APP-PLATFORMS.md §1 says which file owns what.
 */
const { base, BUNDLE_ID } = require('../shared/app.config.base');

module.exports = {
  expo: {
    ...base,

    // This project builds one platform. The iOS half lives in ../ios.
    platforms: ['android'],

    android: {
      package: BUNDLE_ID,
      versionCode: 1,
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#0E7C86',
      },
      /**
       * Nothing in the app uses these, and on a product that monitors children
       * they are exactly the kind of over-broad request that draws Play review
       * scrutiny. They are already absent from the committed manifest; this is
       * what keeps them from coming back through Expo's defaults.
       */
      blockedPermissions: [
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
      ],
      permissions: [
        'ACCESS_FINE_LOCATION',
        'ACCESS_COARSE_LOCATION',
        'ACCESS_BACKGROUND_LOCATION',
        'FOREGROUND_SERVICE',
        'FOREGROUND_SERVICE_LOCATION',
        'RECEIVE_BOOT_COMPLETED',
        'POST_NOTIFICATIONS',
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.ACCESS_FINE_LOCATION',
      ],
    },
  },
};
