#!/usr/bin/env bash
#
# Builds the API image, pushes it to ECR, and rolls the ECS service onto it.
#
#   ENV_NAME=prod ./scripts/deploy-api.sh
#   ENV_NAME=dev  ./scripts/deploy-api.sh
#
# The image is tagged with the current commit so a deploy is always traceable
# back to a revision, and `latest` moves with it for convenience.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_tool docker
require_tool git
require_aws_auth

REPOSITORY_URI="$(stack_output Api EcrRepositoryUri)"
CLUSTER="$(stack_output Api ClusterName)"
SERVICE="$(stack_output Api ServiceName)"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"

log "Environment : ${ENV_NAME} (${AWS_REGION})"
log "Repository  : ${REPOSITORY_URI}"
log "Image tag   : ${IMAGE_TAG}"

log "Authenticating Docker with ECR"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${REPOSITORY_URI%%/*}"

log "Building image"
docker build \
  --tag "${REPOSITORY_URI}:${IMAGE_TAG}" \
  --tag "${REPOSITORY_URI}:latest" \
  "${REPO_ROOT}/services/api"

log "Pushing image"
docker push "${REPOSITORY_URI}:${IMAGE_TAG}"
docker push "${REPOSITORY_URI}:latest"

# Point the task definition at this exact tag rather than relying on `latest`,
# so a rollback is just a redeploy with an older tag.
log "Updating the ECS task definition"
npm --prefix "${REPO_ROOT}/infrastructure/aws" run deploy -- \
  --require-approval never \
  -c "env=${ENV_NAME}" \
  -c "imageTag=${IMAGE_TAG}" \
  "Parentix-${ENV_NAME}-Api"

log "Waiting for the service to stabilise (migrations run on task start)"
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE" --region "$AWS_REGION"

log "API deployed: $(stack_output Api ApiUrl)"
