#!/usr/bin/env bash
# Shared helpers for the deploy scripts. Not executable on its own.

set -euo pipefail

ENV_NAME="${ENV_NAME:-prod}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="${REPO_ROOT}/infrastructure/gcp"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed."
}

require_gcloud_auth() {
  require_tool gcloud
  gcloud auth print-access-token >/dev/null 2>&1 \
    || die "No usable Google Cloud credentials. Run 'gcloud auth login' (and 'gcloud auth application-default login' for Terraform)."
}

# Reads a Terraform output. Outputs are the single source of truth for resource
# names, so nothing here has to guess at or duplicate a naming convention.
#
#   tf_output api_url
tf_output() {
  local key="$1" value

  value="$(terraform -chdir="$TF_DIR" output -raw "$key" 2>/dev/null || true)"

  [ -n "$value" ] \
    || die "Terraform output '${key}' is unset. Deploy the infrastructure first: infrastructure/gcp/deploy.sh ${ENV_NAME} apply"

  printf '%s' "$value"
}

# Terraform keeps one state file per environment via workspaces, so selecting
# the wrong one silently targets the wrong deployment. Every script that reads
# an output goes through here first.
select_workspace() {
  require_tool terraform
  terraform -chdir="$TF_DIR" workspace select "$ENV_NAME" >/dev/null 2>&1 \
    || die "No Terraform workspace '${ENV_NAME}'. Run infrastructure/gcp/deploy.sh ${ENV_NAME} apply first."
}

require_project() {
  PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
  [ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "(unset)" ] \
    || die "Set PROJECT_ID or run 'gcloud config set project <id>'."
  export PROJECT_ID
}
