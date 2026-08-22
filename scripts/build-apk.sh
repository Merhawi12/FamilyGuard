#!/usr/bin/env bash
#
# Builds a release APK.
#
#   npm run apk:child     # the monitored device agent (Expo + native modules)
#   npm run apk:family    # the parent app (React, wrapped by Capacitor)
#   npm run apk:family -- --debug
#   npm run apk:child -- --bundle    # .aab for a Play upload
#
# Both are signed with the release keystore when one is present and with the
# DEBUG key when it is not — installable either way, publishable only in the
# first case. `apps/child-app/android/android/generate-release-keystore.sh`
# makes one.
#
# Neither app is built by `npm run build`, which only produces the two web
# bundles. An Android release is deliberately a separate, explicit step: it
# needs the SDK, it takes minutes rather than seconds, and old versions stay
# installed on real devices long after a web deploy has moved on.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TARGET="${1:-}"
VARIANT="Release"

# An APK is what you sideload onto a handset to test; an Android App Bundle is
# what Google Play accepts for a new listing, and it has been the only accepted
# format for new apps since 2021. Both come out of the same Gradle project and
# differ only in the task and the output folder, so this is a flag rather than a
# second script — but only one of the two can actually be published, which is
# why `--bundle` exists at all.
GRADLE_VERB="assemble"
ARTIFACT_DIR="apk"
ARTIFACT_EXT="apk"

shift || true
for arg in "$@"; do
  case "$arg" in
    --debug)  VARIANT="Debug" ;;
    --bundle) GRADLE_VERB="bundle"; ARTIFACT_DIR="bundle"; ARTIFACT_EXT="aab" ;;
    *) die "Unknown option '${arg}'. Use: --debug, --bundle" ;;
  esac
done

case "$TARGET" in
  child|family) ;;
  *) die "Usage: $(basename "$0") <child|family> [--debug] [--bundle]" ;;
esac

# The Gradle project, which is not in the same place for the two apps.
#
# The child app was split into a project per platform, so `apps/child-app/android`
# is an Expo *project root* — package.json, app.config.js, eas.json — and the
# Gradle project it owns is the `android/` inside it, the ordinary React Native
# arrangement one level down. The family app is Capacitor and unsplit, so its
# Gradle project sits directly under the app.
#
# Everything below reads this rather than assembling the path inline: the
# keystore check at the end used to do that, and got it wrong in a way that
# reported one app's signing state while building the other.
if [ "$TARGET" = "child" ]; then
  ANDROID_ROOT="${REPO_ROOT}/apps/child-app/android/android"
  EXPO_ROOT="${REPO_ROOT}/apps/child-app/android"
else
  ANDROID_ROOT="${REPO_ROOT}/apps/family-app/android"
  EXPO_ROOT="${REPO_ROOT}/apps/family-app"
fi

# The JDK Android Studio installs alongside the SDK. Gradle 8 needs 17; the JDK
# that happens to be first on PATH is frequently 8 or 11, and the failure that
# produces ("Unsupported class file major version") does not mention Java.
: "${ANDROID_HOME:=${LOCALAPPDATA:-$HOME}/Android/Sdk}"
export ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"
[ -d "$ANDROID_HOME" ] || die "No Android SDK at ${ANDROID_HOME}. Set ANDROID_HOME."

if [ -z "${JAVA_HOME:-}" ]; then
  for candidate in "${LOCALAPPDATA:-$HOME}/Android/jdk17" "/usr/lib/jvm/java-17-openjdk"; do
    [ -d "$candidate" ] && { export JAVA_HOME="$candidate"; break; }
  done
fi
[ -n "${JAVA_HOME:-}" ] || warn "JAVA_HOME is unset — Gradle needs JDK 17."

# The API hostname is compiled in, so a build is pinned to one backend. Read from
# Terraform when it is reachable, falling back to production: a mobile build is
# often made on a machine that never runs terraform.
# Remembered before the default lands, so the .env lookup below can tell "the
# caller asked for this backend" from "nobody said, so we guessed".
API_URL_EXPLICIT="${API_URL:-}"
API_URL="${API_URL:-$(terraform -chdir="$TF_DIR" output -raw api_url 2>/dev/null || echo 'https://api.parentix.ca')}"

# `apps/child-app/android/.env` is where a developer points the app at their own
# machine, and it is the file the app's own comments tell you to edit and rebuild
# after. Per-platform since the split: an Android build reads the Android
# project's, and an iOS build cannot read one at all (see build-ios.sh).
#
# It has no effect here, and that silence cost an afternoon. Expo's env loader
# does not overwrite variables that are already set, and the export below sets
# them — so `npm run apk:child` produced an APK pinned to production no matter
# what the file said. The parent app runs on localhost, the codes it issues live
# in the localhost database, and the phone asked api.parentix.ca, which had
# genuinely never heard of them. Every attempt came back "That code was not
# recognised", pointing at a typo, with nothing wrong anywhere in the code.
#
# Read here so the file wins for a local build, since that is the only reason to
# have written it. An explicit `API_URL=... npm run apk:child` still overrides it,
# and CI sets neither, so a release build is unaffected.
CHILD_ENV="${EXPO_ROOT}/.env"
if [ "$TARGET" = "child" ] && [ -z "${API_URL_EXPLICIT:-}" ] && [ -f "$CHILD_ENV" ]; then
  ENV_API_URL="$(sed -n 's/^[[:space:]]*EXPO_PUBLIC_API_URL[[:space:]]*=[[:space:]]*//p' "$CHILD_ENV" | tail -1 | tr -d '"'"'"'\r')"
  # The variable carries the `/api` suffix; API_URL everywhere else is the origin.
  ENV_ORIGIN="${ENV_API_URL%/api}"
  if [ -n "$ENV_ORIGIN" ] && [ "$ENV_ORIGIN" != "$API_URL" ]; then
    warn "${CHILD_ENV} points at ${ENV_ORIGIN}, not ${API_URL} — building against the .env."
    warn "Run 'API_URL=${API_URL} npm run apk:child' to override it, or comment the line out."
    API_URL="$ENV_ORIGIN"
  fi
fi

if [ "$TARGET" = "child" ]; then
  log "Building the Child App (${VARIANT}) against ${API_URL}"

  # A LAN address in a release APK is a build that only works on one Wi-Fi
  # network. Fine for a handset on the desk, wrong for anything handed out, and
  # impossible to tell apart afterwards without unzipping the APK.
  case "$API_URL" in
    http://10.*|http://192.168.*|http://172.1[6-9].*|http://172.2*|http://172.3[01].*|http://localhost*|http://127.*)
      warn "${API_URL} is a local address. This APK works only on that network — do not publish it."
      ;;
  esac

  # Push rides on FCM, and FCM needs this file. Without it the app still builds,
  # still asks for notification permission and still reports itself set up — and
  # then getExpoPushTokenAsync() throws at runtime, which push.js catches and
  # records as a warning nobody reads. Said here because the alternative is
  # finding out from a device that never buzzes.
  if [ ! -f "${ANDROID_ROOT}/app/google-services.json" ]; then
    warn "No google-services.json in apps/child-app/android/android/app/ — this APK cannot receive push notifications."
    warn "See docs/DEPLOYMENT.md §2.3a. Everything else works; only notifications are affected."
  fi

  # Expo inlines EXPO_PUBLIC_* at bundle time. A new API hostname therefore means
  # a new build and a new Play release — installed copies never pick it up.
  export EXPO_PUBLIC_API_URL="${API_URL}/api"
  export EXPO_PUBLIC_SOCKET_URL="${API_URL}"

  # Never `expo prebuild`: this Gradle project is committed source holding the
  # accessibility, VPN, usage-stats and DNS modules, and prebuild would delete it.
  # The Android project's package.json deliberately has no `prebuild` script for
  # that reason; only the iOS one does, where there is nothing to lose.
  ( cd "$ANDROID_ROOT" && ./gradlew "${GRADLE_VERB}${VARIANT}" --no-daemon )
  OUT="${ANDROID_ROOT}/app/build/outputs/${ARTIFACT_DIR}/$(echo "$VARIANT" | tr '[:upper:]' '[:lower:]')"
else
  log "Building the Family App (${VARIANT}) against ${API_URL}"
  require_web_dependencies

  # VITE_BUILD_TARGET=capacitor keeps the SPA shell named index.html and points
  # `/` at the app rather than the marketing page — see apps/family-app/vite.config.js.
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

  # Same FCM requirement as the child app, for the same reason: the wrapper is a
  # WebView, WebView has no Push API, so FCM is the only way this app is ever
  # notified. Capacitor's android/app/build.gradle applies the google-services
  # plugin only when the file is there, so its absence is silent by default.
  if [ ! -f "${ANDROID_ROOT}/app/google-services.json" ]; then
    warn "No google-services.json in apps/family-app/android/app/ — this APK cannot receive push notifications."
    warn "Register ca.parentix.family in the Firebase console and download it. See docs/DEPLOYMENT.md §2.3b."
  fi

  ( cd "$EXPO_ROOT" && npx cap sync android )
  ( cd "$ANDROID_ROOT" && ./gradlew "${GRADLE_VERB}${VARIANT}" --no-daemon )
  OUT="${ANDROID_ROOT}/app/build/outputs/${ARTIFACT_DIR}/$(echo "$VARIANT" | tr '[:upper:]' '[:lower:]')"
fi

ARTIFACT="$(ls "$OUT"/*."${ARTIFACT_EXT}" 2>/dev/null | head -1 || true)"
[ -n "$ARTIFACT" ] || die "No .${ARTIFACT_EXT} was produced in ${OUT}"

log "Built $(basename "$ARTIFACT") ($(du -h "$ARTIFACT" | cut -f1))"
log "  ${ARTIFACT}"
# Each app reads its own git-ignored keystore.properties from its own Gradle
# root, so the signing question has to be asked about the app that was actually
# built. This checked the child app's path unconditionally, which meant a family
# build reported the child app's signing state — silence (implying a release key)
# whenever the child had one, and a spurious debug warning whenever it did not.
# It is $ANDROID_ROOT now rather than an inline path, which is what let the two
# drift apart in the first place.
[ -f "${ANDROID_ROOT}/keystore.properties" ] \
  || warn "Signed with the DEBUG key — installable for testing, rejected by Google Play."
