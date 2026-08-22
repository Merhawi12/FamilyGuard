# Child App — two platform projects

The monitored device agent, as **two independent Expo projects that share one
body of JavaScript**.

```
apps/child-app/
├── shared/        @parentix/child-shared — every screen, service and native
│                  bridge, plus the Expo config both platforms spread
├── android/       Expo project root · Kotlin native modules · Play
└── ios/           Expo project root · no native project · App Store
```

Each platform owns its `package.json`, `app.config.js`, `eas.json`,
`metro.config.js`, `index.js`, `.env`, `assets/` and **its own lockfile and
`node_modules`**. Neither owns any business logic. `shared/` owns no
dependencies — it declares all 19 as `peerDependencies`, so the copy in a bundle
is always the platform project's.

---

## 1. Why the native directory is one level down

`apps/child-app/android/android/` looks like a mistake and is not.

The outer `android/` is the **Expo project root**. React Native requires a
project's native code to sit in `<projectRoot>/android`, so once the project
root is named after its platform, the Gradle project lands one level in. The iOS
side is the same shape: `ios/ios/` is where
[`ios-child-prebuild.yml`](../../.github/workflows/ios-child-prebuild.yml)
writes an Xcode project, on the rare occasions one is committed at all.

Nothing had to change inside the Gradle project. Its paths are resolved through
`node --print require.resolve(…)` rather than by counting `../`, so moving the
project root and the native directory together left every one of them pointing
at the same place.

## 2. Why these are not npm workspaces

Do not add them to the root `workspaces` array. It has been tried.

The web tier at the repo root resolves **react 18.3.1**; React Native 0.73.6
pins **18.2.0**. Adding these projects to the workspaces makes `npm install`
fail outright with `ERESOLVE`. Each project therefore installs on its own, links
`shared/` with `file:`, and its `metro.config.js` sets
`disableHierarchicalLookup` plus an explicit `nodeModulesPaths`, so Metro can
never climb to the root and find the wrong React.

That last part matters more than it reads: two Reacts in one bundle is not a
build error. It is an "invalid hook call" crash at runtime that names no file
and no package.

## 3. Where each thing is configured

`shared/app.config.base.js` holds what must be identical in both stores — name,
version, slug, URL scheme, splash, EAS project id. Both platform configs spread
it, so there is still one place to change a version.

Everything genuinely platform-specific is stated separately, and the *native*
source of truth differs by platform:

| | Android | iOS |
| --- | --- | --- |
| Expo config | `android/app.config.js` — **largely inert** | `ios/app.config.js` — **the whole configuration** |
| Native project | `android/android/`, committed source | none; EAS prebuilds it |
| Permissions | `android/android/…/AndroidManifest.xml` | `ios/app.config.js` → `ios.infoPlist` |
| Launcher icon | `android/android/…/res/mipmap-*` | `ios/app.config.js` → `icon` |
| Launch screen | `res/drawable/splashscreen.xml` | `ios/app.config.js` → `splash` |

`expo prebuild` would delete `android/android/` and the accessibility, VPN,
usage-stats and DNS modules with it, so it is **never run for Android** — the
Android project deliberately has no `prebuild` script. Only the iOS project has
one, where there is nothing to lose.

[`childAppPlatforms.test.js`](../../services/api/tests/childAppPlatforms.test.js)
asserts the pairs that must agree, because nothing throws when they drift.
Full detail: [docs/CHILD-APP-PLATFORMS.md](../../docs/CHILD-APP-PLATFORMS.md).

## 4. One EAS project, two release trains

Both configs carry the same `slug` and `projectId`
(`@familyguard/familyguard-child`) — one product in two stores, with the build
history, Play listing and store credentials all already filed under it. Each
project builds only its own platform.

EAS uploads from the git root rather than the project directory, which is what
makes the `file:`-linked `shared/` package part of the build context.

## 5. Working on it

```bash
# Install — each project separately; there is no hoisted root install.
npm --prefix apps/child-app/android install
npm --prefix apps/child-app/ios install
npm run install:all                    # both, plus the API, via `npm ci`

# Dev server
npm run dev:child                      # Android
npm run dev:child:ios                  # iOS

# Builds
npm run apk:child                      # release APK
npm run apk:child -- --bundle          # .aab for Play
npm run ios:child                      # EAS, builds on Expo's macOS workers

# Tests
npm run lint                           # covers shared/src — the only JS there is
npm run test:e2e:child                 # 173 checks against a real API
npm run assets                         # regenerate icons into both projects
```

A change to a screen or a service is made once, in `shared/`, and both platforms
have it. A change to a permission, an icon or a build setting is made in the
platform project that owns it — and the table in §3 is which one that is.
