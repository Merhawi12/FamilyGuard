#!/usr/bin/env bash
#
# Builds the API image, pushes it to Artifact Registry, and rolls the Cloud Run
# service onto it.
#
#   ENV_NAME=prod ./scripts/deploy-api.sh
#   ENV_NAME=dev  ./scripts/deploy-api.sh
#
# The image is tagged with the current commit so a deploy is always traceable
# back to a revision, and `latest` moves with it for convenience. Rolling back
# is the same command with IMAGE_TAG set to an older commit.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_tool docker
require_tool git
require_gcloud_auth
require_project
select_workspace

REPOSITORY="$(tf_output artifact_registry_repo)"
SERVICE="$(tf_output cloud_run_service)"
REGION="$(tf_output region)"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
IMAGE="${REPOSITORY}/api:${IMAGE_TAG}"

log "Environment : ${ENV_NAME} (${PROJECT_ID}, ${REGION})"
log "Repository  : ${REPOSITORY}"
log "Image tag   : ${IMAGE_TAG}"

# Warn rather than refuse: deploying a dirty tree is sometimes deliberate, but
# the tag then names a commit that does not describe what is running.
if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  warn "Working tree is dirty — ${IMAGE_TAG} will not match what is deployed."
fi

log "Authenticating Docker with Artifact Registry"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

log "Building image"
# Cloud Run is linux/amd64. On an ARM machine (Apple silicon) a native build
# produces an image that fails to start with an exec-format error.
docker build \
  --platform linux/amd64 \
  --tag "$IMAGE" \
  --tag "${REPOSITORY}/api:latest" \
  "${REPO_ROOT}/services/api"

log "Pushing image"
docker push "$IMAGE"
docker push "${REPOSITORY}/api:latest"

# Pin the revision to this exact tag rather than to `latest`, so a rollback is a
# redeploy of an older tag and never depends on what `latest` points at now.
#
# `gcloud run deploy` blocks until the revision is serving traffic or the
# deployment fails, so no separate wait is needed — a failed startup probe
# surfaces here as a non-zero exit.
log "Deploying revision (migrations run at container start)"
gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image "$IMAGE" \
  --quiet

API_URL="$(tf_output api_url)"
log "Verifying health"
if curl -fsS --max-time 30 "${API_URL}/api/health" >/dev/null; then
  log "API deployed: ${API_URL}"
else
  die "Deployed, but ${API_URL}/api/health did not answer. Check: gcloud run services logs read ${SERVICE} --region ${REGION}"
fi
