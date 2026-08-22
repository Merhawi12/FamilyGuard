#!/usr/bin/env bash
#
# Builds the iOS apps, or prepares as much of them as this machine can.
#
#   scripts/build-ios.sh family            # web assets + cap sync (+ archive on a Mac)
#   scripts/build-ios.sh family --archive  # insist on producing an .ipa; macOS only
#   scripts/build-ios.sh child             # hands off to EAS, which builds on a Mac in the cloud
#
# Two apps, two completely different pipelines, which is why this is not a flag
# on build-apk.sh:
#
#   family  Capacitor. The web bundle is built here, copied into the Xcode
#           project, and archived by xcodebuild — and xcodebuild is macOS-only.
#           Everything up to the archive works anywhere, so a Windows or Linux
#           machine can still produce a project that is ready to open on a Mac.
#
#   child   Expo. `eas build` uploads the project and builds it on Expo's own
#           macOS workers, so a full signed .ipa can be produced from any
#           operating system. This is the reason the child app has a route to the
#           App Store from this repo's usual development machine and the family
#           app does not.
#
#           It builds from `apps/child-app/ios`, which is a whole Expo project —
#           not the native Xcode directory the name suggests. The child app is
#           split into a project per platform; see apps/child-app/README.md.
#           EAS uploads from the git root, so the `file:`-linked shared package
#           one directory over is included in the build context.
#
# The Android equivalents live in build-apk.sh and are unaffected.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TARGET="${1:-}"
ARCHIVE=0

shift || true
for arg in "$@"; do
  case "$arg" in
    --archive) ARCHIVE=1 ;;
    *) die "Unknown option '${arg}'. Use: --archive" ;;
  esac
done

case "$TARGET" in
  child|family) ;;
  *) die "Usage: $(basename "$0") <child|family> [--archive]" ;;
esac

API_URL="${API_URL:-https://api.parentix.ca}"
IS_MAC=0
[ "$(uname -s 2>/dev/null || echo unknown)" = "Darwin" ] && IS_MAC=1

# ── Child: Expo Application Services ─────────────────────────────────────────
if [ "$TARGET" = "child" ]; then
  require_tool npx

  # Same reasoning as the Android build: these are inlined into the JS bundle at
  # build time, so a build made against the wrong API is wrong until it is
  # replaced — installed copies never pick up a change.
  export EXPO_PUBLIC_API_URL="${API_URL}/api"
  export EXPO_PUBLIC_SOCKET_URL="${API_URL}"

  PROFILE="${EAS_PROFILE:-production}"

  log "Building the Child App for iOS via EAS (profile: ${PROFILE}, API: ${API_URL})"
  warn "This runs on Expo's servers and needs an Apple Developer account for a"
  warn "signed build. EAS_PROFILE=simulator produces an unsigned .app instead,"
  warn "which needs no Apple account and runs only in the iOS Simulator."

  # Run from the iOS project, which owns the iOS half of the config and its own
  # eas.json. `--platform ios` is still passed explicitly: the profile names in
  # that file are not reserved, and being wrong here would mean an EAS build of
  # the wrong platform rather than an error.
  ( cd "${REPO_ROOT}/apps/child-app/ios" && npx eas-cli build --platform ios --profile "$PROFILE" )
  exit 0
fi

# ── Family: Capacitor ────────────────────────────────────────────────────────
require_web_dependencies
require_tool npx

[ -d "${REPO_ROOT}/apps/family-app/ios" ] \
  || die "apps/family-app/ios does not exist. Create it once with:
       cd apps/family-app && npx cap add ios"

log "Building the Family App web bundle for iOS against ${API_URL}"

# VITE_BUILD_TARGET=capacitor keeps the SPA shell named index.html and points `/`
# at the app rather than the marketing page — the WebView loads a file, and there
# is no rewrite layer to send `/` anywhere. Identical to the Android path.
VITE_BUILD_TARGET=capacitor \
VITE_API_URL="${API_URL}" \
VITE_ADMIN_URL="${VITE_ADMIN_URL:-}" \
VITE_GOOGLE_MAPS_KEY="${VITE_GOOGLE_MAPS_KEY:-}" \
VITE_GOOGLE_CLIENT_ID="${VITE_GOOGLE_CLIENT_ID:-}" \
VITE_MAP_TILE_URL="${VITE_MAP_TILE_URL:-}" \
VITE_MAP_TILE_ATTRIBUTION="${VITE_MAP_TILE_ATTRIBUTION:-}" \
  npm --prefix "${REPO_ROOT}" run build:family

[ -f "${REPO_ROOT}/apps/family-app/dist/index.html" ] \
  || die "The native build must emit index.html — Capacitor's WebView loads that name and has no rewrite layer."

# The iOS counterpart of the google-services.json check in build-apk.sh, and the
# same failure: silence. Firebase is what turns the APNs token into an FCM one
# (see ios/App/App/AppDelegate.swift), and without this file the app runs fine
# and is simply never notified.
if [ ! -f "${REPO_ROOT}/apps/family-app/ios/App/App/GoogleService-Info.plist" ]; then
  warn "No GoogleService-Info.plist in apps/family-app/ios/App/App/ — this build cannot receive push notifications."
  warn "Register ca.parentix.family as an iOS app in the Firebase console and download it. See docs/IOS.md §3."
fi

if [ "$IS_MAC" = "0" ]; then
  # `cap sync` = copy + update. `update` runs `pod install`, which needs
  # CocoaPods and therefore macOS; `copy` is just a file copy and works here.
  log "Copying web assets into the Xcode project"
  ( cd "${REPO_ROOT}/apps/family-app" && npx cap copy ios )

  warn "Not macOS — stopping after the copy."
  warn "Xcode and CocoaPods do not exist off macOS, so the archive cannot happen here."
  warn ""
  warn "The project is ready. On a Mac, finish with:"
  warn "  cd apps/family-app/ios/App && pod install"
  warn "  open App.xcworkspace        # then Product ▸ Archive"
  warn ""
  warn "Or build the whole thing in CI — .github/workflows/ios-family.yml does"
  warn "exactly these steps on a macOS runner."
  exit 0
fi

log "Syncing the Xcode project (pod install included)"
( cd "${REPO_ROOT}/apps/family-app" && npx cap sync ios )

if [ "$ARCHIVE" = "0" ]; then
  log "Project is ready: apps/family-app/ios/App/App.xcworkspace"
  log "Open it in Xcode, or re-run with --archive to produce an .ipa."
  exit 0
fi

require_tool xcodebuild

ARCHIVE_PATH="${REPO_ROOT}/apps/family-app/ios/App/build/App.xcarchive"
EXPORT_PATH="${REPO_ROOT}/apps/family-app/ios/App/output"

log "Archiving"
xcodebuild -workspace "${REPO_ROOT}/apps/family-app/ios/App/App.xcworkspace" \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE_PATH" \
  archive

# ExportOptions is not committed: it names a team ID and a distribution method,
# which belong to whoever is shipping rather than to the repository.
EXPORT_OPTIONS="${EXPORT_OPTIONS:-${REPO_ROOT}/apps/family-app/ios/ExportOptions.plist}"
[ -f "$EXPORT_OPTIONS" ] || die "No export options at ${EXPORT_OPTIONS}.
       Create one naming your team and method — docs/IOS.md §5 has a template —
       or point EXPORT_OPTIONS at your own."

log "Exporting .ipa"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -exportPath "$EXPORT_PATH"

IPA="$(ls "${EXPORT_PATH}"/*.ipa 2>/dev/null | head -1 || true)"
[ -n "$IPA" ] || die "No .ipa was produced in ${EXPORT_PATH}"

log "Built $(basename "$IPA") ($(du -h "$IPA" | cut -f1))"
log "  ${IPA}"
