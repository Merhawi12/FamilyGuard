# Child App — Android and iOS

Two Expo projects, one shared body of JavaScript, two stores. This is what
differs between them, where each platform's configuration actually lives, and
how to build both.

For what the app *can* do on each platform — which is a much sharper difference
than anything here — see [IOS.md §2](IOS.md). This document is about
configuration; that one is about capability.

---

## 0. The layout

```
apps/child-app/
├── shared/        @parentix/child-shared — every screen, service and native
│                  bridge, plus app.config.base.js
├── android/       Expo project root; its Gradle project is android/android/
└── ios/           Expo project root; EAS prebuilds its native project
```

Each platform owns its `package.json`, `app.config.js`, `eas.json`,
`metro.config.js`, `assets/`, lockfile and `node_modules`. Neither owns business
logic; `shared/` owns no dependencies. The doubled `android/android/` is not a
typo — React Native requires a project's native code at `<projectRoot>/android`,
so naming the project root after its platform puts the Gradle project one level
in. [`apps/child-app/README.md`](../apps/child-app/README.md) covers the
mechanics, including why these cannot be npm workspaces.

---

## 1. The thing that surprises everyone

**The Expo config is the source of truth for iOS and is mostly inert for
Android.**

`apps/child-app/android/android/` is committed source. It holds the
accessibility service, the VPN service, the usage-stats module and the DNS
reporter, and `expo prebuild` would delete all of it — so prebuild is **never
run for Android**, and `AndroidManifest.xml` is what actually ships. Editing
`android.permissions` in `android/app.config.js` changes nothing on a device.
That project has no `prebuild` script at all, deliberately.

There is no committed native project on the iOS side, so EAS *does* run prebuild
for iOS on its own machines, and `ios/app.config.js` is the whole of the iOS
configuration.

What both configs share — name, version, slug, URL scheme, splash, EAS project
id — comes from `shared/app.config.base.js`, which both spread. Change a version
in one place; change a permission in the platform that owns it.

| Change | Android | iOS |
| --- | --- | --- |
| Permissions | `AndroidManifest.xml` | `ios/app.config.js` → `ios.infoPlist` |
| Deep-link scheme | `AndroidManifest.xml` intent filter | `shared/app.config.base.js` → `scheme` |
| Launcher icon | `android/android/…/res/mipmap-*` | `shared/app.config.base.js` → `icon` |
| Launch screen | `res/drawable/splashscreen.xml` + `res/drawable-*` | `shared/app.config.base.js` → `splash` |
| Notification icon | `res/drawable-*/notification_icon.png` | n/a — iOS uses the app icon |
| Orientation | activity `android:screenOrientation` | `shared/app.config.base.js` → `orientation` |

Get that backwards and a change appears on one platform only, silently. The
pairs that must agree are asserted in
[`childAppPlatforms.test.js`](../services/api/tests/childAppPlatforms.test.js) —
bundle identifier vs package name, URL scheme on both sides, portrait on both
sides — because nothing throws when they drift.

> **Never run `expo prebuild` in `apps/child-app/android`.** It deletes that
> project's `android/`, and the Kotlin modules with it. There is no `prebuild`
> script there for exactly this reason; only the iOS project has one. On Windows
> prebuild refuses to generate iOS at all ("run again from macOS or Linux"),
> which is fine: EAS does it.

### Committing a native iOS project instead

The default above — no native project in the repo, EAS prebuilds it — is not the only
option, and [`ios-child-prebuild.yml`](../.github/workflows/ios-child-prebuild.yml)
is the other one. It runs on a macOS runner, generates the project with
`--clean`, installs Pods, **compiles it for the Simulator**, and only then
commits. Compiling before committing is the entire point: a generated native
project nobody has built is a liability, not an asset.

It has to be CI rather than a script because `expo prebuild --platform ios` will
not run on Windows, and WSL is not installed on the development machine either.

It writes `apps/child-app/ios/ios/` — the Xcode project inside the iOS *project
root*, the same shape as `android/android/`.

Understand the trade before running it. EAS decides a platform's workflow by
looking for its native directory, so **a committed `ios/ios/` stops EAS
prebuilding** and it builds what is in the repo. From then on `ios/app.config.js`
is inert until the workflow is re-run: change a permission string, a background
mode or the URL scheme and the next build still carries the old one, with nothing
to say so.

`childAppPlatforms.test.js` covers exactly that gap. The four
`the committed iOS project agrees with app.json` tests skip while there is no
`ios/ios/` and start asserting the moment one appears — comparing the generated
Info.plist's URL scheme, background modes, ATS setting and location strings
against the config that is supposed to own them. Their failure message is the
fix: re-run the workflow.

Re-run it whenever `ios/app.config.js` or the shared `app.config.base.js`
changes, or the Expo SDK moves.

---

## 2. Icons and launch screens

All of it is generated from three committed sources:

| Source | Feeds |
| --- | --- |
| `apps/family-app/public/logo.png` | launch screens, notification icons, themed-icon silhouettes, the web logo — everything drawn as one colour |
| `brand/family-app-icon.png` | the family app's launcher icon |
| `brand/child-app-icon.png` | the child app's launcher icon |

```bash
npm run assets          # write them
npm run assets:check    # verify they are current, write nothing
```

[`scripts/build-brand-assets.mjs`](../scripts/build-brand-assets.mjs) draws 78
files across all four apps — the child app's `assets/` is written into each
platform project, because Expo resolves those paths from the project root. Four
rules it encodes, each of which was a live bug:

- **The two apps have different launcher icons, and neither is the lockup.** A
  parent's dashboard and a child's own app are two products to the person holding
  the phone, and one white shield for both made them indistinguishable in the one
  place they are always seen together. The artwork is a composed tile — its own
  ground, its own colours, its own rounded corners — so nothing filters it and
  nothing crops a wordmark off it. The crop is *measured* at build time rather
  than written down, which is what makes replacing either PNG a file swap.
- **A pre-composed tile has to be fitted to three different ideas of an icon.**
  Full bleed for iOS and the Android adaptive foreground, where the OS applies its
  own mask and a transparent corner becomes a notch cut out of the artwork;
  the artwork's own rounded corners for the legacy `ic_launcher.png`, which
  nothing masks; an actual circle for `ic_launcher_round.png`, whose name is a
  promise that the file already is one. The corners of the first are filled with
  ground colour sampled from the artwork, per corner.
- **Alpha is required in some files and fatal in others.** App Store Connect
  rejects an app icon with an alpha channel. Android notification icons are the
  opposite: the system discards the colour and tints the silhouette, so only
  alpha carries the shape. The generator paints an opaque ground where alpha must
  be absent and uses `omitBackground` where it must be present.
- **The adaptive foreground needs a ground it can be seen against.** It was a
  white shield on transparent; `iconBackground` was `#FFFFFF`. Nobody noticed
  because there was no `mipmap-anydpi-v26/ic_launcher.xml`, so the foreground was
  never drawn at all and Android fell back to the legacy square. The foreground is
  now the artwork itself, sized to exactly the 72dp of the 108dp canvas that the
  launcher shows, so the colour behind it is only what the parallax uncovers.
- **`<monochrome>` must not point at the foreground.** Both XMLs did, correctly,
  while the foreground was a silhouette — a themed icon keeps only the alpha
  channel and fills it with one colour from the wallpaper. Now that the foreground
  is full-colour artwork, its alpha is a solid rounded square, and the same
  reference would put a blank tile on every home screen with themed icons turned
  on. There is a separate `ic_launcher_monochrome.png`, still drawn from the
  lockup's shield.

---

## 3. Deep links

Scheme: **`com.parentix.child://`**, registered on Android in the manifest's
intent filter and on iOS via `scheme` in `shared/app.config.base.js`.

It was declared on Android from the day the project was scaffolded and consumed
by nothing — the app opened on whatever screen it would have opened on anyway.
[`App.js`](../apps/child-app/shared/App.js) now maps it:

| Link | Goes to |
| --- | --- |
| `com.parentix.child://link/ABC12345` | Link screen, code prefilled |
| `com.parentix.child://home` | My Day |
| `com.parentix.child://messages` | Messages |
| `com.parentix.child://settings` | Settings |
| `com.parentix.child://permissions` | Permissions |

**Everything except `link` is gated on the device being linked.** The other
screens assume credentials in the keystore — `Home` reads monitoring state,
`Messages` opens a socket — so on an unlinked phone only `Link` is routable and
anything else falls through to it. No wildcard is used for that: an unmatched
path does not navigate at all, and a `'*'` would swallow `link/ABC12345` as an
unnamed parameter and lose the code.

The code-prefill link is the one that earns its keep. The API used to mint a QR
and it was removed because nothing could scan it without adding a camera
permission to a monitoring app; a link needs no camera and no new permission.

Universal links (`https://app.parentix.ca/…` opening the app) are **not**
configured. That needs an `apple-app-site-association` file served from the host
and `assetlinks.json` for Android, plus the Associated Domains entitlement on the
App ID — an entitlement present in the build but not on the App ID fails signing.
The prefix is already listed in `App.js`, so it is a hosting change away.

---

## 4. Notifications

Both platforms use **Expo push tokens** (`platform: 'expo'` server-side), which
reach APNs and FCM through Expo's service. No server change was needed for iOS.

- Android needs a channel before anything can be delivered; `ensureAndroidChannel`
  creates it and no-ops elsewhere.
- Android needs `POST_NOTIFICATIONS` from API 33. It is in the manifest.
- iOS needs `remote-notification` in `UIBackgroundModes` and the `aps-environment`
  entitlement — both come from `ios/app.config.js`, the entitlement automatically.
- **Upload the APNs key to EAS** or iOS registers a token and never receives
  anything: `npx eas-cli credentials` → iOS → Push Notifications.

Tapping a notification routes through `SCREEN_FOR` in `App.js`, including from a
cold start — the tap is held until the navigator is ready rather than dropped.
That was already cross-platform.

---

## 5. Building

### Android

```bash
API_URL=https://api.parentix.ca bash scripts/build-apk.sh child            # APK
API_URL=https://api.parentix.ca bash scripts/build-apk.sh child --bundle   # AAB for Play
```

Three traps, all real, all Windows:

- **`npm run apk:child` does not work from Git Bash on Windows.** npm runs it
  through cmd.exe, which cannot execute a `.sh` and **exits 0 without building**.
  Call it with `bash` — which is what `npm run ios:child` does.
- **A clean build on Windows fails inside Metro until `postinstall` has run.**

  ```
  ENOENT: no such file or directory, mkdir '…\.expo\metro\externals\node:sea'
  ```

  `@expo/cli` writes one shim directory per Node standard-library module, named
  after the module, and its list is `module.builtinModules` filtered to drop
  anything containing a `/`. That filter predates the builtins reachable *only*
  through the `node:` prefix — Node 24 reports `node:sea`, `node:sqlite`,
  `node:test` and `node:test/reporters`, and only the last is dropped. The rest
  become directory names containing a colon, which NTFS reads as an
  alternate-data-stream separator rather than part of a filename.

  [`scripts/patch-expo-windows.mjs`](../scripts/patch-expo-windows.mjs) adds `:`
  to that filter in the installed copy. It runs from this app's `postinstall`,
  no-ops off Windows, and warns rather than rewrites if the upstream line moves.
  Dropping those three modules costs nothing — they cannot be imported from a
  React Native bundle in any case.

  Worth knowing *why it looked fine for years*: the shim is written only when
  missing and Gradle caches the bundle task, so a warm tree never runs that code.
  It surfaces on the first genuinely clean build, which is when a toolchain bug
  is least expected. A fresh clone on Windows could not build an APK at all.
- **Gradle will package a stale JS bundle.** Verify what shipped rather than
  trusting the build:

  ```bash
  unzip -p .../app-release.apk assets/index.android.bundle | grep -c api.parentix.ca
  ```

  Hermes prefix-shares strings, so `https://api.parentix.ca` appearing once
  inside `…/api` is normal, not a missing socket URL.

There is **no release keystore**, so the artefact is signed `CN=Android Debug`
and Play will reject it. `android/generate-release-keystore.sh` makes one.

### iOS

No Mac needed — EAS builds on Expo's.

**The EAS project is `@familyguard/familyguard-child`,** not `parentix-anything`.
The config claimed `owner: "parentix"` and `slug: "parentix-child"` — the product
rename reached the config and never reached Expo — and the two mismatches
together made *every* EAS command fail before it started, Android included:

```
Owner of project identified by "extra.eas.projectId" (familyguard) does not
match owner specified in the "owner" field (parentix)
```

Nobody had hit it because Android releases are built locally with Gradle. The
`owner` and `slug` now match the project that `extra.eas.projectId` actually
points at, which EAS reports itself — they were not guessed. `name` is still
`"Parentix"`, so nothing user-facing changed; the slug is internal, and Expo
updates are disabled. Renaming the project on the Expo dashboard would let both
go back to Parentix branding, and keeps the same project ID.

```bash
scripts/build-ios.sh child                        # signed, production profile
EAS_PROFILE=simulator scripts/build-ios.sh child  # unsigned .app, no Apple account
EAS_PROFILE=preview   scripts/build-ios.sh child  # ad-hoc, registered devices
```

`API_URL` defaults to `https://api.parentix.ca` and is inlined at build time, so
a build made against the wrong API stays wrong until it is replaced. Installed
copies never pick up a change.

`eas.json` carries **no `submit` block**. Submitting needs an Apple ID, a team ID
and an App Store Connect app ID — none of which belong in the repository, and all
of which `eas submit` will prompt for on first run and then store. Adding a
half-filled block only risks a schema error on a command that would otherwise
have worked.

---

## 6. Running it from VS Code

`.vscode/tasks.json` carries every build and test command — **Ctrl+Shift+P →
Tasks: Run Task**. It is git-ignored, so it is a local convenience rather than
something a teammate inherits.

The task worth knowing about is **iOS · Run on iPhone (Expo Go, live reload)**.
There is no iOS Simulator on Windows and there cannot be — it ships inside Xcode
— but the child app runs in **Expo Go on a physical iPhone**, which is a real
live-reload loop from this machine. That works because the app has *no custom
native code on iOS*: `AppBlocker`, `UsageStats` and `VpnControl` are Android
Kotlin modules whose JS bridges fall back to stubs, so everything left is a
package Expo Go already carries.

The phone and the machine must share a network; if the QR connects and hangs,
press `s` in the terminal for tunnel mode.

The other two iOS paths are EAS builds: **preview** installs a signed app on a
registered iPhone (needs an Apple account, no Mac), and **simulator** is a
compile check whose artefact only launches on a Mac.

### `npx expo-doctor`

15 of 16 checks pass. The one that fails is expected and is the arrangement in §1:

> When the android/ios folders are present, EAS Build will not sync … orientation,
> icon, scheme, backgroundColor, userInterfaceStyle, splash, android, ios, plugins

That phrasing is generic and reads worse than the reality. The rule is
per-platform: `android/` exists so those keys do not reach Android — which is why
`AndroidManifest.xml` and `res/` are edited directly — while `ios/` does not
exist, so prebuild does sync them. That is not an assumption; the built
`Info.plist` in §8 carries `arm64`, the ATS setting, portrait and the URL scheme,
all of which come from the Expo config.

Committing `ios/` is what would make the warning true for both halves.

## 7. Testing

```bash
npm run test:e2e:child   # 173 checks, headless, no device
npm test                 # includes childAppPlatforms.test.js
npm run assets:check     # icons and launch screens still match the logo
npm run lint
```

The e2e harness drives the real service layer — linking, rules, monitoring,
contacts, unlink and relink — against a stubbed native layer, so it runs
anywhere. It does **not** exercise the Kotlin modules or anything iOS; those need
a device.

---

## 8. The iOS build is real — what it proved

**Build `b964e32a`, simulator profile, finished 2026-08-16 in 6m 16s.** The app
compiles for iOS on Apple hardware; this is no longer a configuration claim.
Downloading the artefact and reading the generated `Info.plist` out of
`Parentix.app` confirms every decision in this document survived prebuild:

| Key | Built value |
| --- | --- |
| `CFBundleIdentifier` | `com.parentix.child` — matches the Android package |
| `UIRequiredDeviceCapabilities` | `["arm64"]` — the override held, not Expo's `armv7` |
| `UISupportedInterfaceOrientations` | `["UIInterfaceOrientationPortrait"]` |
| `UIBackgroundModes` | `location`, `fetch`, `remote-notification` |
| `NSAppTransportSecurity` | `NSAllowsArbitraryLoads: false`, `NSAllowsLocalNetworking: true` |
| `CFBundleURLTypes` | `com.parentix.child` — deep links registered |
| `ITSAppUsesNonExemptEncryption` | `false` |
| Usage descriptions | all four, in the child-facing wording |

The shipped `main.jsbundle` carries `https://api.parentix.ca` and
`com.parentix.child://`, so the API origin and the linking config are really in
there rather than merely configured.

Two caveats on that artefact:

- It was uploaded **before** the `pausesUpdatesAutomatically` fix below, so that
  one line is not in this build. It is a pure-JS change and cannot affect the
  compile the build was run to validate; the next build picks it up.
- `AppIcon60x60@2x.png` inside the bundle has an **alpha channel**, even though
  the 1024 source does not. Simulator builds do not validate icons, so this is
  unresolved rather than known-broken — check it at the first TestFlight upload,
  where App Store Connect will say so plainly. The source asset is correct, so
  any fix belongs in Expo's icon generation, not in `assets/`.

## 9. Still needs a device

Nothing below has been run on real hardware, and none of it can be from Windows.

- [x] ~~An iOS build of any kind~~ — done, see §8
- [ ] Push on iOS end to end, after the APNs key is uploaded to EAS
- [ ] Background location on iOS with `Always` authorisation
- [ ] Deep links on both platforms (`npx uri-scheme open com.parentix.child://link/ABC12345 --ios`)
- [ ] The new launcher icon and launch screen on an Android handset
- [ ] Everything in [IOS.md §2](IOS.md) that iOS cannot do — confirm the app says
      so honestly rather than showing a permanent "off"
