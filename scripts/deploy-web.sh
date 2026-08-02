#!/usr/bin/env bash
#
# Builds the two web apps and publishes them to Cloud Storage behind Cloud CDN.
#
#   ENV_NAME=prod ./scripts/deploy-web.sh          # both apps
#   ENV_NAME=prod ./scripts/deploy-web.sh family   # one app
#
# Hashed asset filenames are immutable, so they get a one-year cache. The HTML
# entry points must not be cached, or a browser keeps loading the previous
# build's script tags after a deploy.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_tool npm
require_tool gsutil
require_web_dependencies
require_gcloud_auth
require_project
select_workspace

TARGET="${1:-all}"
URL_MAP="$(terraform -chdir="$TF_DIR" output -raw url_map 2>/dev/null || true)"

publish() {
  local build_script="$1" app_dir="$2" bucket="$3" label="$4"

  log "Building ${label}"
  # The API is same-origin behind the load balancer, so VITE_API_URL stays
  # empty. VITE_ADMIN_URL is a link the family app shows to staff.
  VITE_API_URL="" \
  VITE_ADMIN_URL="$(tf_output admin_url)" \
    npm --prefix "${REPO_ROOT}" run "build:${build_script}"

  local dist="${REPO_ROOT}/apps/${app_dir}/dist"
  [ -d "$dist" ] || die "Build produced no output at ${dist}"

  # Assets first, HTML second. In the other order a browser could fetch the new
  # index.html and then 404 on assets that had not been uploaded yet.
  log "Uploading assets to gs://${bucket}"
  gsutil -m -h 'Cache-Control:public,max-age=31536000,immutable' \
    rsync -r -d -x '.*\.html$' "$dist" "gs://${bucket}"

  log "Uploading HTML entry points"
  gsutil -m -h 'Cache-Control:public,max-age=0,must-revalidate' \
    cp -r "$dist"/*.html "gs://${bucket}/"

  # Any HTML nested below the root (rare, but Vite can emit it) is uploaded by
  # the rsync above and so carries the immutable header. Correct it in place —
  # a cached HTML entry point is what pins a browser to the previous build.
  gsutil -m setmeta -h 'Cache-Control:public,max-age=0,must-revalidate' \
    "gs://${bucket}/**.html" 2>/dev/null || true

  if [ -n "$URL_MAP" ]; then
    # Without this the edge keeps serving the previous HTML until it revalidates.
    log "Invalidating CDN cache for ${label}"
    gcloud compute url-maps invalidate-cdn-cache "$URL_MAP" \
      --project "$PROJECT_ID" \
      --path '/*' \
      --async \
      --quiet
  else
    warn "No load balancer in this environment — skipping CDN invalidation."
  fi

  log "${label} published"
}

if [ "$TARGET" = "all" ] || [ "$TARGET" = "family" ]; then
  publish family family-app "$(tf_output family_bucket)" "Family App"
fi

if [ "$TARGET" = "all" ] || [ "$TARGET" = "admin" ]; then
  publish admin admin-dashboard "$(tf_output admin_bucket)" "Admin Dashboard"
fi

log "Family App     : $(tf_output app_url)"
log "Admin Dashboard: $(tf_output admin_url)"
