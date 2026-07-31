#!/usr/bin/env bash
#
# Terraform wrapper. Keeps the backend config, workspace and tfvars file in
# agreement so it is not possible to apply dev settings onto prod state.
#
#   ./deploy.sh dev  plan
#   ./deploy.sh prod apply
#   ./deploy.sh dev  destroy
#
# The project comes from envs/<env>.tfvars. Override with PROJECT_ID=... to
# target a different one (a scratch project, say).
#
# State lives in a GCS bucket named <project>-parentix-tfstate, created here on
# first run. State is the only record of which real resources Terraform owns —
# it must not live on one laptop.
set -euo pipefail
cd "$(dirname "$0")"

ENV_NAME="${1:-}"
ACTION="${2:-plan}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }

case "$ENV_NAME" in
  dev|prod) ;;
  *) die "usage: $0 <dev|prod> [plan|apply|destroy|output]" ;;
esac

command -v terraform >/dev/null 2>&1 || die "terraform is required but not installed."
command -v gcloud   >/dev/null 2>&1 || die "gcloud is required but not installed."

VAR_FILE="envs/${ENV_NAME}.tfvars"
[ -f "$VAR_FILE" ] || die "Missing ${VAR_FILE}"

# The environment file is the authority. Falling back to `gcloud config` would
# put this environment's state bucket — and its resources — in whichever project
# that happens to point at, which is not something you want to discover later.
PROJECT_ID="${PROJECT_ID:-$(sed -n 's/^project_id[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$VAR_FILE" | head -1)}"
[ -n "$PROJECT_ID" ] \
  || die "No project_id in ${VAR_FILE}, and PROJECT_ID is unset."

if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
  # Cloud Shell has no ADC file — it serves credentials from the metadata
  # server, which the Terraform provider uses happily. Refusing to run there
  # would be a false alarm.
  if [ -z "${CLOUD_SHELL:-}" ] && [ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
    die "Terraform needs Application Default Credentials. Run: gcloud auth application-default login"
  fi
fi

# Deploying into the wrong project is tedious to undo — a Cloud SQL instance
# name cannot be reused for about a week after deletion. Say something when the
# active gcloud project is not the one this environment targets.
ACTIVE_PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
if [ -n "$ACTIVE_PROJECT" ] && [ "$ACTIVE_PROJECT" != "(unset)" ] && [ "$ACTIVE_PROJECT" != "$PROJECT_ID" ]; then
  printf '\033[1;33m warn\033[0m %s\n' "gcloud is on '${ACTIVE_PROJECT}' but ${VAR_FILE} targets '${PROJECT_ID}'." >&2
  printf '       %s\n' "Terraform will use '${PROJECT_ID}'. Fix the tfvars, or set PROJECT_ID=... to override." >&2
  if [ "$ACTION" = "apply" ] || [ "$ACTION" = "destroy" ]; then
    read -r -p "       Continue with '${PROJECT_ID}'? [y/N] " reply
    [ "$reply" = "y" ] || [ "$reply" = "Y" ] || die "Aborted."
  fi
fi

STATE_BUCKET="${PROJECT_ID}-parentix-tfstate"

if ! gsutil ls -b "gs://${STATE_BUCKET}" >/dev/null 2>&1; then
  log "Creating state bucket gs://${STATE_BUCKET}"
  gsutil mb -p "$PROJECT_ID" -l us "gs://${STATE_BUCKET}"
  # Versioning turns a corrupted or truncated state write into an inconvenience
  # rather than a rebuild-from-scratch.
  gsutil versioning set on "gs://${STATE_BUCKET}"
fi

log "Initialising Terraform"
terraform init -upgrade -reconfigure \
  -backend-config="bucket=${STATE_BUCKET}" >/dev/null

# One workspace per environment: separate state, same configuration.
terraform workspace select "$ENV_NAME" 2>/dev/null \
  || terraform workspace new "$ENV_NAME"

TF_ARGS=(-var-file="$VAR_FILE" -var="project_id=${PROJECT_ID}")

case "$ACTION" in
  plan)
    terraform plan "${TF_ARGS[@]}"
    ;;
  apply)
    terraform apply "${TF_ARGS[@]}"
    echo
    log "Outputs"
    terraform output
    ;;
  destroy)
    # prod sets db_deletion_protection, so this stops at the database rather
    # than quietly deleting it. That is the intended behaviour.
    terraform destroy "${TF_ARGS[@]}"
    ;;
  output)
    terraform output
    ;;
  *)
    die "Unknown action '${ACTION}'. Use plan, apply, destroy or output."
    ;;
esac
