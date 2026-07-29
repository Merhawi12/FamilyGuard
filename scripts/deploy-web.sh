#!/usr/bin/env bash
#
# Builds the two web apps and publishes them to S3 + CloudFront.
#
#   ENV_NAME=prod ./scripts/deploy-web.sh          # both apps
#   ENV_NAME=prod ./scripts/deploy-web.sh family   # one app
#
# Hashed asset filenames are immutable, so they get a one-year cache. The HTML
# entry points must not be cached, or a browser keeps loading the previous
# build's script tags after a deploy.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_tool npm
require_aws_auth

TARGET="${1:-all}"

publish() {
  local build_script="$1" app_dir="$2" bucket="$3" distribution="$4" label="$5"

  log "Building ${label}"
  npm --prefix "${REPO_ROOT}" run "build:${build_script}"

  local dist="${REPO_ROOT}/apps/${app_dir}/dist"
  [ -d "$dist" ] || die "Build produced no output at ${dist}"

  log "Uploading immutable assets to s3://${bucket}"
  aws s3 sync "$dist" "s3://${bucket}" \
    --region "$AWS_REGION" \
    --delete \
    --exclude '*.html' \
    --cache-control 'public,max-age=31536000,immutable'

  log "Uploading HTML entry points"
  aws s3 sync "$dist" "s3://${bucket}" \
    --region "$AWS_REGION" \
    --exclude '*' \
    --include '*.html' \
    --cache-control 'public,max-age=0,must-revalidate'

  log "Invalidating CloudFront distribution ${distribution}"
  aws cloudfront create-invalidation \
    --distribution-id "$distribution" \
    --paths '/*' \
    --query 'Invalidation.Id' \
    --output text >/dev/null

  log "${label} published"
}

if [ "$TARGET" = "all" ] || [ "$TARGET" = "family" ]; then
  publish family family-app \
    "$(stack_output Storage FamilyAppBucketName)" \
    "$(stack_output Web FamilyDistributionId)" \
    "Family App"
fi

if [ "$TARGET" = "all" ] || [ "$TARGET" = "admin" ]; then
  publish admin admin-dashboard \
    "$(stack_output Storage AdminAppBucketName)" \
    "$(stack_output Web AdminDistributionId)" \
    "Admin Dashboard"
fi

log "Family App     : $(stack_output Web FamilyAppUrl)"
log "Admin Dashboard: $(stack_output Web AdminAppUrl)"
