# iOS

The two client apps on Apple platforms: what exists, what it can do, and — the
part that matters most for planning — what it cannot do and why.

The two apps reach iOS by completely different routes, and their outcomes are
completely different too. Read §2 before promising anything to a customer.

---

## 1. The short version

| | Family App (parent) | Child App (device agent) |
| --- | --- | --- |
| Built with | Capacitor 6 wrapping the React SPA | Expo / React Native + native modules |
| iOS parity | **Full.** Every feature the Android app has | **Partial.** Core monitoring is not possible |
| Build needs a Mac? | Yes — Xcode. CI covers it | **No.** EAS builds on Expo's Macs |
| Push | FCM → APNs (`platform: 'fcm'`) | Expo push → APNs (`platform: 'expo'`) |
| Bundle ID | `ca.parentix.family` | `com.parentix.child` |

The Family App is a genuine port: it is a web app in a native shell, the shell
exists on both platforms, and nothing it does is Android-specific.

The Child App is not, and cannot be made into one without either an entitlement
Apple grants by application or a supervised-device deployment. §2 is the detail.

---

## 2. Child App capability matrix

The Android agent has seven jobs. Four cross to iOS unchanged; three do not.

| Capability | Android | iOS | Why |
| --- | --- | --- | --- |
| Device linking, unlink, revocation | ✅ | ✅ | Plain HTTPS |
| Realtime (Socket.IO) — rules, chat, remote unlink | ✅ | ✅ | Plain WebSocket |
| Parent ⇄ child messaging | ✅ | ✅ | — |
| Approved-contacts list | ✅ | ✅ | Server-pushed allow-list; never reads device contacts |
| Location, including background | ✅ | ✅ | `expo-location` + `UIBackgroundModes: location` |
| Push notifications | ✅ | ✅ | Expo push relays to APNs |
| Device health / heartbeat | ✅ | ✅ | — |
| **Screen-time measurement** | ✅ | ❌ | No API returns per-app usage to your process |
| **App blocking** | ✅ | ⚠️ | Possible only on Apple's terms — see below |
| **Website filtering** | ✅ | ⚠️ | Safari-only, or supervised devices |
| **Web history** | ✅ | ❌ | Not readable by any app |
| **Restart after reboot** | ✅ | ❌ | iOS apps cannot self-start |
| **Resist uninstall** | ⚠️ | ❌ | Needs supervision/MDM |

Each of the three stubbed native modules carries the same explanation at the top
of its file — [`UsageStats.js`](../apps/child-app/src/native/UsageStats.js),
[`AppBlocker.js`](../apps/child-app/src/native/AppBlocker.js),
[`VpnControl.js`](../apps/child-app/src/native/VpnControl.js).

### Why screen time cannot be reported

Apple's `DeviceActivity` framework is not a read API. It renders your numbers
inside a system-drawn `DeviceActivityReport` view hosted in an app extension that
your process cannot read back. You may show a child their own usage; you cannot
obtain the figure, so you cannot upload it. No entitlement changes this — it is
the privacy guarantee itself, not a gate in front of one.

The practical consequence: **the parent's Reports and Screen Time screens will
have no data from an iPhone.** Rendering a confident `0m` would be worse than
saying so, which is why `UsageStats.supported` is false rather than the module
returning zeros.

### Why app blocking cannot work the way it does on Android

Android names apps by package: the parent picks Instagram, the rule travels as
`com.instagram.android`, and the agent acts on it.

iOS blocks apps by `ApplicationToken` — an opaque value that only exists once the
**user of that device** taps the app in Apple's own `FamilyActivityPicker`. A
token cannot be built from a bundle ID, cannot be turned back into one, and means
nothing off the device that minted it.

So a faithful iOS implementation is not a port, it is a different product rule:

- an adult picks the managed apps **once, on the child's iPhone**, in Apple's
  picker;
- the tokens stay on that device;
- the parent's rules act on *"the managed set"* — pause it, schedule it, allow it
  — rather than on apps chosen by name.

That is implementable. It needs Apple's `com.apple.developer.family-controls`
entitlement, which is requested through a form and granted per-account, and it
needs the rule model above agreed as a product decision. It is not currently
built; the stubs are honest placeholders, not TODOs left by accident.

### Why website filtering and web history cannot cross

Android runs a loopback `VpnService` that answers DNS itself — which gives both
blocking and the history feed. The iOS equivalents, `NEDNSProxyProvider` and
`NEFilterDataProvider`, are refused at install time unless the device is
*supervised* (enrolled via Apple Configurator or Apple Business/School Manager
and managed by an MDM server). A phone set up at home is not supervised and
cannot become so without erasing it.

`ManagedSettings.webContent` can restrict **Safari only**, under the same Family
Controls entitlement, and reports nothing. That yields weak blocking and no
history.

### What the UI already does about it

[`PermissionsScreen.jsx`](../apps/child-app/src/screens/PermissionsScreen.jsx)
filters its steps on `<module>.supported`, so an iPhone shows two rows — Location
and Notifications — instead of five, three of which could never turn green and
whose instructions name Android settings screens. `monitoring.js` needed no
change: every one of its guards already reads a permission that the stubs answer
`false`.

---

## 3. One-time setup

### 3a. Apple Developer

1. An Apple Developer Program membership (US$99/yr). Required for any device
   install, TestFlight or App Store release. Not required for a Simulator build.
2. Register both App IDs: `ca.parentix.family` and `com.parentix.child`.
3. On `ca.parentix.family`, enable the **Push Notifications** capability.
4. Create an **APNs auth key** (Keys ▸ ✚ ▸ Apple Push Notifications service).
   Download the `.p8` — Apple allows this **once**. It does not expire. Note the
   Key ID and your Team ID.

### 3b. Firebase, for the Family App's push

The Family App receives push through FCM on both platforms so the server needs no
APNs transport of its own — see the header of
[`AppDelegate.swift`](../apps/family-app/ios/App/App/AppDelegate.swift).

1. Firebase console → project `parentix-4be0d` → Add app → iOS.
2. Bundle ID `ca.parentix.family`.
3. Download `GoogleService-Info.plist` into `apps/family-app/ios/App/App/`.
   It is git-ignored, exactly like `google-services.json` on Android.
4. Project settings → Cloud Messaging → **Apple app configuration** → upload the
   `.p8`, with its Key ID and your Team ID.

Skipping step 4 is the quiet failure: registration succeeds, a token is stored,
and nothing is ever delivered.

### 3c. EAS, for the Child App's push

Expo's push service relays to APNs and needs the same key:

```bash
cd apps/child-app
npx eas-cli credentials        # Platform: iOS → Push Notifications → upload the .p8
```

---

## 4. Building

### Family App

```bash
# Anywhere — builds the bundle and stages the Xcode project
scripts/build-ios.sh family

# On a Mac, all the way to an .ipa
scripts/build-ios.sh family --archive
```

Off macOS the script stops after `cap copy` and says so: `pod install` needs
CocoaPods and `xcodebuild` needs Xcode. To finish on a Mac:

```bash
cd apps/family-app/ios/App && pod install && open App.xcworkspace
```

Or run the **iOS — Family App** workflow in GitHub Actions
([`ios-family.yml`](../.github/workflows/ios-family.yml)), which does all of it on
a `macos-14` runner. With no Apple secrets configured it still does an unsigned
Simulator build — enough to compile the Swift, link Firebase and prove the Xcode
project is intact.

### Child App

No Mac needed at any point; EAS builds on Expo's:

```bash
scripts/build-ios.sh child                      # signed, production profile
EAS_PROFILE=simulator scripts/build-ios.sh child  # unsigned .app, no Apple account
EAS_PROFILE=preview   scripts/build-ios.sh child  # ad-hoc, for registered devices
```

`API_URL` defaults to `https://api.parentix.ca` and is inlined at build time, so a
build made against the wrong API stays wrong until it is replaced.

---

## 5. ExportOptions.plist

Not committed — it names a team and a distribution method, which belong to
whoever is shipping. `scripts/build-ios.sh family --archive` expects it at
`apps/family-app/ios/ExportOptions.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store</string>
  <key>teamID</key><string>YOUR_TEAM_ID</string>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
```

Use `ad-hoc` instead of `app-store` for a build aimed at registered test devices.

---

## 6. Configuration worth knowing

**The WebView origin is `https://app.parentix.ca`.** `capacitor.config.json` sets
`iosScheme: https` with that hostname, matching Android. This is load-bearing
twice over: the API's CORS list already contains it, and it is one of the
Authorised JavaScript Origins on the Google sign-in client. A default Capacitor
build would serve from `capacitor://localhost` and be refused by both.

**`contentInset: never`.** The app already handles the notch in CSS with
`env(safe-area-inset-*)` and `viewport-fit=cover`. Letting iOS inset the WebView
as well would pad everything twice.

**`FirebaseAppDelegateProxyEnabled` is false.** Firebase would otherwise swizzle
`didRegisterForRemoteNotificationsWithDeviceToken` to grab the APNs token, and
`AppDelegate.swift` needs to own that method — it is where the APNs token is
traded for an FCM one and posted to Capacitor. Two owners of one delegate method
is a load-order race whose losing case is a registration that never completes,
silently. Nothing is lost by disabling it: the swizzled path also forwards
receipts for FCM *topic* messaging, and this app subscribes to no topics.

**Launch art and icons** come from `scripts/build-brand-assets.mjs` (`npm run
assets`, or `npm run assets:check` to verify without writing), which draws every
launch screen, launcher icon and notification icon in the repo from one source
mark. Icons crop to the shield alone: the full lockup's wordmark is unreadable at
60pt, and Apple's guidance is against text in icons. Chromium writes an opaque
PNG with no alpha channel, which is what App Store Connect requires — a
transparent ground would fail the upload. See [CHILD-APP-PLATFORMS.md](CHILD-APP-PLATFORMS.md)
for how the same script feeds two apps that consume assets differently.

**Known gap — the Family App's Android launcher icon is still Capacitor's blue
"X".** The splash was rebranded; `mipmap-*/ic_launcher.png` was not, so the
shipped Android Family App has Capacitor's logo on the home screen. The Child App
had the same class of bug and is now fixed; the Family App's needs the
adaptive-icon pair adding to a Capacitor project rather than an Expo one, so it
is called out here rather than half-done.

---

## 7. Before the first submission

- [ ] APNs key uploaded to **both** Firebase (family) and EAS (child)
- [ ] `GoogleService-Info.plist` in place — otherwise push silently never arrives
- [ ] Privacy nutrition labels: both apps collect Location; the child app is a
      monitoring app and Apple reviews those closely
- [ ] Child App review notes must explain the parental-control purpose and that
      linking requires a parent-issued code; supply a demo account and a code
- [ ] Age rating and a public privacy-policy URL
- [ ] Verify on a **physical device**: the Simulator has no APNs and no real
      background location

---

## 8. Not yet done

Everything in this file is written and configured, but **no iOS build has been
compiled or run** — the development machine is Windows, and Xcode is macOS-only.
The Swift, the Podfile, the entitlements and the project changes are unverified
by a compiler. First task on a Mac (or on the CI workflow) is a Simulator build,
which is exactly what `ios-family.yml` does without needing an Apple account.

Also outstanding:

- Family Controls implementation for the Child App (§2), pending the entitlement
  and the rule-model decision
- Universal links — deliberately omitted; the entitlement fails signing unless the
  App ID carries it, and the password-reset flow is code-based rather than
  link-based, so nothing depends on it
- The Android launcher icon (§6)
