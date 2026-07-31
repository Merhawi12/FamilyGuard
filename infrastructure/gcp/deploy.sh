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

command -v gcloud >/dev/null 2>&1 || die "gcloud is required but not installed."

# Not `command -v terraform`: Cloud Shell ships a shim of that name whose only
# job is to print installation instructions, and it satisfies `command -v`
# perfectly well. Ask for a version banner instead, which only the real binary
# produces — otherwise the run continues and silently does nothing.
if ! terraform version 2>/dev/null | grep -q '^Terraform v'; then
  die "terraform is not installed, or is the Cloud Shell placeholder.

       Cloud Shell does not ship Terraform, and an apt install does not survive
       the session. Install it under \$HOME, which does:

         TF=1.9.8
         mkdir -p ~/bin
         curl -fsSL \"https://releases.hashicorp.com/terraform/\${TF}/terraform_\${TF}_linux_amd64.zip\" -o /tmp/tf.zip
         unzip -oq /tmp/tf.zip -d ~/bin && chmod +x ~/bin/terraform
         grep -q 'HOME/bin' ~/.bashrc || echo 'export PATH=\"\$HOME/bin:\$PATH\"' >> ~/.bashrc
         export PATH=\"\$HOME/bin:\$PATH\"

       Then re-run this script."
fi

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

# Nothing here can be created without a billing account, and the failure without
# this check is a bare "AccessDeniedException: 403" from whichever resource
# happens to be attempted first — which says nothing about billing.
#
# Only a definite "False" stops the run: the describe call needs billing.viewer,
# and someone entitled to deploy but not to read billing should not be blocked.
BILLING="$(gcloud beta billing projects describe "$PROJECT_ID" \
  --format='value(billingEnabled)' 2>/dev/null || true)"
if [ "$BILLING" = "False" ]; then
  die "Billing is disabled on '${PROJECT_ID}'.

       Cloud Run, Cloud SQL, Artifact Registry and Cloud Storage all refuse to be
       created without a billing account, so nothing can be deployed until this
       is fixed.

       Firebase project? Upgrade Spark -> Blaze:
         https://console.firebase.google.com/project/${PROJECT_ID}/usage/details
       Otherwise attach a billing account:
         https://console.cloud.google.com/billing/linkedaccount?project=${PROJECT_ID}

       Blaze is pay-as-you-go, not a flat fee. Set a budget alert afterwards —
       nothing in this configuration caps its own spend."
fi

STATE_BUCKET="${PROJECT_ID}-parentix-tfstate"

# `gcloud storage` rather than gsutil: gsutil is deprecated and prints a
# migration notice on every call.
if ! gcloud storage buckets describe "gs://${STATE_BUCKET}" >/dev/null 2>&1; then
  log "Creating state bucket gs://${STATE_BUCKET}"
  gcloud storage buckets create "gs://${STATE_BUCKET}" \
    --project="$PROJECT_ID" --location=us --uniform-bucket-level-access
  # Versioning turns a corrupted or truncated state write into an inconvenience
  # rather than a rebuild-from-scratch.
  gcloud storage buckets update "gs://${STATE_BUCKET}" --versioning
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
