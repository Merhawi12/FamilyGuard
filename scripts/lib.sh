#!/usr/bin/env bash
# Shared helpers for the deploy scripts. Not executable on its own.

set -euo pipefail

ENV_NAME="${ENV_NAME:-prod}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="${REPO_ROOT}/infrastructure/gcp"

# infrastructure/gcp/deploy.sh installs Terraform here on Cloud Shell, since
# only $HOME survives a session. Ahead of the rest of PATH so it wins against
# the placeholder Cloud Shell ships under the same name.
export PATH="${HOME}/bin:${PATH}"

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

# The web builds run vite out of the workspace root's node_modules. On a fresh
# clone that directory does not exist, and the failure surfaces several npm
# frames deep as `sh: line 1: vite: command not found` — which reads like a
# broken toolchain rather than a missing install.
require_web_dependencies() {
  [ -x "${REPO_ROOT}/node_modules/.bin/vite" ] && return 0
  die "Web dependencies are not installed. Run 'npm ci' in ${REPO_ROOT} first."
}

# The same trap on the API side, and it misdiagnoses rather than merely confusing.
#
# `scripts/check-mail.js` loads the config and the mailer at require time, so on a
# fresh clone it crashes before a single SMTP packet is sent — and Node exits 1,
# which is the same exit code it uses for a relay that refused the credentials.
# `setup-google-mail.sh` reads that as "Gmail refused those credentials" and sends
# whoever ran it to the Google account console to re-issue an app password that
# was never the problem. Checked here so the install is named instead.
require_api_dependencies() {
  [ -d "${REPO_ROOT}/services/api/node_modules" ] && return 0
  die "API dependencies are not installed. Run 'npm ci' in ${REPO_ROOT}/services/api first."
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

# Not `require_tool terraform`: Cloud Shell ships a placeholder of that name
# which prints install instructions and exits 0, so `command -v` is satisfied and
# every later terraform call quietly does nothing. Demand a version banner.
require_terraform() {
  terraform version 2>/dev/null | grep -q '^Terraform v' \
    || die "terraform is missing, or is the Cloud Shell placeholder.
       Run 'infrastructure/gcp/deploy.sh ${ENV_NAME} plan' once — it offers to install it."
}

# Terraform keeps one state file per environment via workspaces, so selecting
# the wrong one silently targets the wrong deployment. Every script that reads
# an output goes through here first.
select_workspace() {
  require_terraform
  terraform -chdir="$TF_DIR" workspace select "$ENV_NAME" >/dev/null 2>&1 \
    || die "No Terraform workspace '${ENV_NAME}'. Run infrastructure/gcp/deploy.sh ${ENV_NAME} apply first."
}

require_project() {
  PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
  [ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "(unset)" ] \
    || die "Set PROJECT_ID or run 'gcloud config set project <id>'."
  export PROJECT_ID
}
