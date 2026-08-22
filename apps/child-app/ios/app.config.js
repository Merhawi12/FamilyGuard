/**
 * The iOS project's Expo config.
 *
 * ── The mirror image of ../android/app.config.js ─────────────────────────────
 *
 * Where the Android config is mostly inert, **this file is the entire iOS
 * configuration**. There is no committed `ios/` native directory, so EAS runs
 * `expo prebuild` on its own macOS machines and generates the Xcode project
 * from what is below. Nothing else on disk describes the iOS app.
 *
 * That flips the moment a native project is committed here — see
 * .github/workflows/ios-child-prebuild.yml, which generates, compiles and
 * commits one. EAS decides a platform's workflow by looking for its native
 * directory, so from then on it builds what is in the repo and **the keys below
 * stop taking effect on their own**. `childAppPlatforms.test.js` starts
 * asserting the generated Info.plist against this file the moment the directory
 * appears, so the drift fails a test run rather than a store submission.
 *
 * `expo prebuild --platform ios` refuses to run on Windows, which is why that
 * workflow is CI rather than a script.
 */
const { base, BUNDLE_ID } = require('../shared/app.config.base');

module.exports = {
  expo: {
    ...base,

    // This project builds one platform. The Android half lives in ../android.
    platforms: ['ios'],

    ios: {
      bundleIdentifier: BUNDLE_ID,
      buildNumber: '1',
      supportsTablet: false,
      config: {
        usesNonExemptEncryption: false,
      },
      infoPlist: {
        UIBackgroundModes: ['location', 'fetch', 'remote-notification'],
        UIRequiredDeviceCapabilities: ['arm64'],
        UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait'],
        /**
         * Expo's default plist sets `NSAllowsArbitraryLoads: true`, turning App
         * Transport Security off for every host. This app talks to exactly one
         * origin over HTTPS, so that default buys nothing but a weaker app and a
         * question from App Store review.
         *
         * Local networking stays on so a LAN dev build against
         * `EXPO_PUBLIC_API_URL=http://10.0.0.x:5000` still works — a private
         * address is the case the exemption exists for.
         */
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: false,
          NSAllowsLocalNetworking: true,
        },
        NSUserNotificationsUsageDescription: 'Parentix uses notifications to pass on messages from your parent and to tell you when screen time is nearly up.',
      },
    },
  },
};
