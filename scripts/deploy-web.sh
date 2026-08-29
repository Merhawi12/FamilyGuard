#!/usr/bin/env bash
#
# Builds the two web apps and publishes them to Firebase Hosting.
#
#   ENV_NAME=prod ./scripts/deploy-web.sh              # both apps
#   ENV_NAME=prod ./scripts/deploy-web.sh family       # one app
#   ENV_NAME=prod CHANNEL=preview ./scripts/deploy-web.sh   # a preview channel
#
# Hosting handles what the deploy script used to: an atomic release, a CDN, the
# cache headers from firebase.json, and a rollback that does not need a rebuild.
# What is left here is getting the right values into the bundle before it ships.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_tool npm
require_tool firebase
require_web_dependencies
require_gcloud_auth
require_project
select_workspace

# Firebase keeps its own credentials, entirely separate from gcloud's.
#
# `require_tool firebase` only proves the binary is on PATH, and a stale login
# looks identical to a good one until something asks Hosting to do work — which
# is after two full Vite builds and a Terraform read. The failure then arrives as
#
#   Authentication Error: Your credentials are no longer valid.
#
# with a couple of minutes already spent and nothing published. `projects:list`
# is a real API call, so it catches an expired token rather than merely a
# missing one, which `login:list` would not: that reads the cached credential
# file and reports an account that Google has since stopped honouring.
require_firebase_auth() {
  firebase projects:list --project "$PROJECT_ID" >/dev/null 2>&1 && return 0
  die "firebase is not authenticated (or the token has expired).

       In Cloud Shell there is no localhost callback, so:
         firebase login --reauth --no-localhost

       Elsewhere:
         firebase login --reauth

       Hosting credentials are separate from gcloud's — being logged into
       gcloud, even as the project owner, does not authenticate this."
}
require_firebase_auth

TARGET="${1:-all}"
CHANNEL="${CHANNEL:-}"

case "$TARGET" in
  all|family|admin) ;;
  *) die "Unknown target '${TARGET}'. Use: all | family | admin" ;;
esac

# ── Build-time values ────────────────────────────────────────────────────────
#
# Vite inlines these, so they are fixed at build time and a wrong one is only
# visible in the browser. All three come from Terraform or Secret Manager rather
# than from whoever happens to be running the release.

# The API is a different origin now that Firebase Hosting serves the apps — no
# same-origin /api path to fall back on — so this must be a real hostname, and
# the API must list the app's origin in CORS_ORIGINS. Both come from the same
# Terraform run, so they cannot drift apart.
API_URL="$(tf_output api_url)"
ADMIN_URL="$(tf_output admin_url)"

# The Google Maps browser key is baked into the bundle at build time. It is
# optional: without one the Location page draws its map from OpenStreetMap tiles
# and geocodes against Nominatim, so a release with no key ships a working map
# rather than the "Map unavailable" placeholder it used to.
#
# It is read from Secret Manager when it exists there, so a release does not
# depend on whoever runs it having the right variable exported. This is a
# browser key: it is public the moment the bundle ships, and is secured by
# HTTP-referrer restrictions in the Cloud console, not by being hidden.
MAPS_SECRET="parentix-${ENV_NAME}-google-maps-key"
if [ -z "${VITE_GOOGLE_MAPS_KEY:-}" ]; then
  VITE_GOOGLE_MAPS_KEY="$(gcloud secrets versions access latest \
    --secret="$MAPS_SECRET" --project "$PROJECT_ID" 2>/dev/null || true)"
fi
# A blank placeholder version reads as a single space.
VITE_GOOGLE_MAPS_KEY="$(printf '%s' "${VITE_GOOGLE_MAPS_KEY:-}" | tr -d '[:space:]')"

# A placeholder is not a key, and it is worse than no key at all: the page sees a
# truthy value, loads Google's script, and Google refuses it during
# authentication — a failure that only `gm_authFailure` reports, that costs a
# doomed round trip on every visit to Location, and that puts a "Google rejected
# the map key" banner above the map for every parent. An absent key loads nothing
# from Google and goes straight to the OpenStreetMap renderer.
#
# This is not hypothetical. The warning below says `printf 'AIza…'`, and the prod
# secret held exactly that — the instruction pasted literally, ellipsis and all.
# Shape rather than a blocklist: a Maps browser key is `AIza` and 35 more from
# the URL-safe alphabet, so anything else was never going to authenticate.
if [ -n "$VITE_GOOGLE_MAPS_KEY" ] \
  && ! printf '%s' "$VITE_GOOGLE_MAPS_KEY" | grep -Eq '^AIza[0-9A-Za-z_-]{35}$'; then
  warn "Ignoring VITE_GOOGLE_MAPS_KEY — '${VITE_GOOGLE_MAPS_KEY}' is not a Maps browser key (expected AIza + 35 chars)."
  warn "Fix the value in ${MAPS_SECRET}; the build continues on OpenStreetMap tiles."
  VITE_GOOGLE_MAPS_KEY=""
fi

export VITE_GOOGLE_MAPS_KEY

if [ -z "$VITE_GOOGLE_MAPS_KEY" ]; then
  log "No Google Maps key — the Location page will use OpenStreetMap tiles and geocoding."
  log "To use Google's instead: printf 'AIzaSyEXAMPLE…' | gcloud secrets versions add ${MAPS_SECRET} --data-file=-"
fi

# Where the keyless map fetches its tiles. Empty means OpenStreetMap's public
# servers, whose usage policy covers a service of this size but not a large one —
# and explicitly not tiles served into a distributed mobile app. Point this at a
# provider of your own before either becomes true; any {z}/{x}/{y} raster source
# works, and the attribution shown on the map comes from the value beside it.
export VITE_MAP_TILE_URL="${VITE_MAP_TILE_URL:-}"
export VITE_MAP_TILE_ATTRIBUTION="${VITE_MAP_TILE_ATTRIBUTION:-}"
if [ -z "$VITE_GOOGLE_MAPS_KEY" ] && [ -n "$VITE_MAP_TILE_URL" ]; then
  log "Map tiles from ${VITE_MAP_TILE_URL}"
fi

# The Google OAuth Web client ID, read from the same Terraform run that told the
# API to accept it — so the button and the endpoint cannot be configured against
# different clients. Public, and compiled into the bundle; empty simply leaves
# the "Sign in with Google" button unrendered.
VITE_GOOGLE_CLIENT_ID="${VITE_GOOGLE_CLIENT_ID:-$(terraform -chdir="$TF_DIR" output -raw google_client_id 2>/dev/null || true)}"
export VITE_GOOGLE_CLIENT_ID
[ -n "$VITE_GOOGLE_CLIENT_ID" ] || warn "No Google client ID — the 'Sign in with Google' button will not be shown."

# Sets DIST rather than printing it: vite writes its own progress to stdout, so
# capturing this in a subshell would hand back the build log with a path on the
# end of it.
build() {
  local build_script="$1" app_dir="$2" label="$3"

  log "Building ${label} against ${API_URL}"
  VITE_API_URL="${API_URL}" \
  VITE_ADMIN_URL="${ADMIN_URL}" \
  VITE_GOOGLE_MAPS_KEY="${VITE_GOOGLE_MAPS_KEY}" \
  VITE_GOOGLE_CLIENT_ID="${VITE_GOOGLE_CLIENT_ID}" \
  VITE_MAP_TILE_URL="${VITE_MAP_TILE_URL}" \
  VITE_MAP_TILE_ATTRIBUTION="${VITE_MAP_TILE_ATTRIBUTION}" \
    npm --prefix "${REPO_ROOT}" run "build:${build_script}"

  DIST="${REPO_ROOT}/apps/${app_dir}/dist"
  [ -d "$DIST" ] || die "Build produced no output at ${DIST}"
}

# The Family App's shell is app.html, not index.html — firebase.json rewrites
# `/` to the marketing page, and a static index.html would beat that rewrite and
# put the React app on the home page instead. vite.config.js does the rename;
# this is the check that it still happened, because the failure is a working
# deploy that serves the wrong thing at the most visible URL on the site.
assert_family_layout() {
  local dist="$1"
  [ -f "${dist}/app.html" ] \
    || die "${dist}/app.html is missing — the SPA shell was not renamed. See apps/family-app/vite.config.js."
  [ ! -f "${dist}/index.html" ] \
    || die "${dist}/index.html exists — it would be served at / instead of the marketing page."
  [ -f "${dist}/landing.html" ] \
    || die "${dist}/landing.html is missing — / would fall through to the SPA shell."
}

TARGETS=()

if [ "$TARGET" = "all" ] || [ "$TARGET" = "family" ]; then
  build family family-app "Family App"
  assert_family_layout "$DIST"
  TARGETS+=(family)
fi

if [ "$TARGET" = "all" ] || [ "$TARGET" = "admin" ]; then
  build admin admin-dashboard "Admin Dashboard"
  [ -f "${DIST}/index.html" ] || die "${DIST}/index.html is missing."
  TARGETS+=(admin)
fi

# `family,admin` for hosting:channel:deploy, `hosting:family,hosting:admin` for
# deploy — the two commands scope themselves differently.
SITES="$(IFS=,; printf '%s' "${TARGETS[*]}")"
ONLY="hosting:${SITES//,/,hosting:}"

if [ -n "$CHANNEL" ]; then
  # A preview channel gets its own throwaway URL and does not touch the live
  # site. The URL is minted per deploy, so the API has not been told to accept it
  # — add it to extra_cors_origins for as long as the channel is needed, or the
  # preview loads and then fails every request.
  log "Deploying to preview channel '${CHANNEL}' (${SITES})"
  firebase hosting:channel:deploy "$CHANNEL" \
    --project "$PROJECT_ID" \
    --only "$SITES" \
    --expires 7d
  warn "Preview URLs are not in the API's CORS allowlist. Add them to extra_cors_origins to use them."
else
  log "Deploying to Firebase Hosting (${ONLY})"
  firebase deploy \
    --project "$PROJECT_ID" \
    --only "$ONLY" \
    --message "$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo manual)"
fi

log "Family App     : $(tf_output app_url)"
log "Admin Dashboard: $(tf_output admin_url)"
log "API            : ${API_URL}"
