#!/usr/bin/env bash
#
# Points outbound mail at Gmail / Google Workspace, and proves it works.
#
#   ./scripts/setup-google-mail.sh support@parentix.ca
#   ./scripts/setup-google-mail.sh you@gmail.com --to you@gmail.com
#   ./scripts/setup-google-mail.sh you@gmail.com --to you@gmail.com --deploy
#
# The app password is read from stdin, never from the command line — an argument
# lands in shell history and in `ps` output for every user on the machine.
# Interactively it prompts with the input hidden; in a pipeline it reads stdin:
#
#   printf 'abcdefghijklmnop' | ./scripts/setup-google-mail.sh you@gmail.com --deploy
#
# The order is deliberate: authenticate against Gmail *first*, and only write the
# value anywhere once it has been proved. Every previous outage on this platform
# was a credential that was stored and never tested — a placeholder, a password
# with a trailing newline, a Verify SID pasted into a Messaging field. Storing
# first is what turns a five-minute typo into a fortnight of missing password
# resets, because nothing downstream can tell a wrong credential from an absent
# one: `send()` swallows both into a logged `false`.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ACCOUNT=""
TO=""
DEPLOY=0
REGION="${REGION:-us-central1}"

while [ $# -gt 0 ]; do
  case "$1" in
    --to)     TO="${2:-}"; shift 2 ;;
    --deploy) DEPLOY=1; shift ;;
    -h|--help)
      # The header comment is the help text. Bounded by where the comments stop
      # rather than by a line number, so editing the preamble cannot leave
      # --help printing shell source at whoever asked for usage.
      awk 'NR > 1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
      exit 0 ;;
    -*) die "Unknown option '$1'." ;;
    *)  [ -z "$ACCOUNT" ] || die "Give one account address, not two ('$ACCOUNT' and '$1')."
        ACCOUNT="$1"; shift ;;
  esac
done

[ -n "$ACCOUNT" ] || die "Usage: $0 <account@example.com> [--to <address>] [--deploy]"
case "$ACCOUNT" in
  *@*.*) ;;
  *) die "'$ACCOUNT' is not an email address. SMTP_USER must be the full address — Gmail rejects the local part alone with the same 535 as a wrong password." ;;
esac

# Gmail replaces the From header with the authenticated account unless the
# address is a verified alias, so anything else here is a silent lie: the mail
# goes out, and the recipient sees the account address regardless.
EMAIL_FROM="${EMAIL_FROM:-Parentix <${ACCOUNT}>}"
case "$EMAIL_FROM" in
  *,*) die "EMAIL_FROM contains a comma, which gcloud reads as a second variable. Use a display name without one." ;;
esac

# ── The credential ───────────────────────────────────────────────────────────

if [ -t 0 ]; then
  printf 'Gmail app password for %s (input hidden): ' "$ACCOUNT" >&2
  read -rs APP_PASSWORD
  printf '\n' >&2
else
  APP_PASSWORD="$(cat)"
fi

RAW_LENGTH="${#APP_PASSWORD}"
# Google shows the password as four groups of four, and pasting it that way is
# the single most common failure: Gmail's SMTP AUTH rejects the spaced form, and
# answers with a 535 identical to a revoked password. A trailing newline from
# `echo` does the same thing. Both are stripped here rather than diagnosed later.
APP_PASSWORD="$(printf '%s' "$APP_PASSWORD" | tr -d '[:space:]')"

[ -n "$APP_PASSWORD" ] || die "No password on stdin."

if [ "${#APP_PASSWORD}" != "$RAW_LENGTH" ]; then
  log "Stripped $(( RAW_LENGTH - ${#APP_PASSWORD} )) whitespace character(s) — Gmail would have refused the pasted form."
fi

if [ "${#APP_PASSWORD}" != 16 ] && [ "${ALLOW_ODD_PASSWORD:-0}" != 1 ]; then
  die "That is ${#APP_PASSWORD} characters; a Gmail app password is 16.
       This is an account password or a truncated paste — either way Gmail will
       answer 535. Generate one at https://myaccount.google.com/apppasswords
       (the page only exists once 2-Step Verification is on).
       Set ALLOW_ODD_PASSWORD=1 to override for a non-Gmail relay."
fi

# ── 1. Prove the credential before storing it anywhere ───────────────────────

log "Testing ${ACCOUNT} against smtp.gmail.com:587 …"

set +e
(
  cd "${REPO_ROOT}/services/api" || exit 1
  EMAIL_PROVIDER=smtp \
  SMTP_HOST=smtp.gmail.com \
  SMTP_PORT=587 \
  SMTP_SECURE=false \
  SMTP_USER="$ACCOUNT" \
  SMTP_PASS="$APP_PASSWORD" \
  EMAIL_FROM="$EMAIL_FROM" \
  node scripts/check-mail.js ${TO:+--to "$TO"}
)
CHECK_STATUS=$?
set -e

if [ "$CHECK_STATUS" != 0 ]; then
  die "Gmail refused those credentials — nothing was written. The three causes,
       in the order they happen:
         1. 2-Step Verification is off, so what you pasted is not an app password.
         2. The app password was revoked (they die when the account password changes).
         3. A Workspace admin has disabled app passwords for the domain.
       Fix it at https://myaccount.google.com/apppasswords and run this again."
fi

# ── 2. Local .env ────────────────────────────────────────────────────────────
#
# Rewritten key by key rather than appended to: a duplicate KEY= line is legal in
# a .env and the *last* one wins, so appending leaves a file whose visible top
# half is not what the process reads.

ENV_FILE="${REPO_ROOT}/services/api/.env"

set_env_key() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"
  KEY="$key" VALUE="$value" awk '
    BEGIN { key = ENVIRON["KEY"]; value = ENVIRON["VALUE"]; seen = 0 }
    $0 ~ "^" key "=" { if (!seen) { print key "=" value; seen = 1 } ; next }
    { print }
    END { if (!seen) print key "=" value }
  ' "$file" > "$tmp"
  # Same permissions as the file it replaces, not the umask default.
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

if [ -f "$ENV_FILE" ]; then
  set_env_key "$ENV_FILE" EMAIL_PROVIDER smtp
  set_env_key "$ENV_FILE" SMTP_HOST      smtp.gmail.com
  set_env_key "$ENV_FILE" SMTP_PORT      587
  set_env_key "$ENV_FILE" SMTP_SECURE    false
  set_env_key "$ENV_FILE" SMTP_USER      "$ACCOUNT"
  set_env_key "$ENV_FILE" SMTP_PASS      "$APP_PASSWORD"
  set_env_key "$ENV_FILE" SMTP_FROM      "$EMAIL_FROM"
  log "Updated services/api/.env"
else
  warn "No services/api/.env — skipped. Copy .env.example if you want local mail."
fi

if [ "$DEPLOY" != 1 ]; then
  log "Local mail is working. Re-run with --deploy to put this into production."
  exit 0
fi

# ── 3. Production ────────────────────────────────────────────────────────────

require_gcloud_auth
require_project

SERVICE="parentix-${ENV_NAME}-api"
log "Storing credentials for ${SERVICE} in ${PROJECT_ID} …"

# printf, not echo. `echo` appends a newline, Secret Manager stores it, and it
# becomes part of the password — which fails as a 535, exactly like a wrong one.
printf '%s' 'smtp.gmail.com' | gcloud secrets versions add "parentix-${ENV_NAME}-smtp-host" --data-file=- --quiet >/dev/null
printf '%s' "$ACCOUNT"       | gcloud secrets versions add "parentix-${ENV_NAME}-smtp-user" --data-file=- --quiet >/dev/null
printf '%s' "$APP_PASSWORD"  | gcloud secrets versions add "parentix-${ENV_NAME}-smtp-pass" --data-file=- --quiet >/dev/null
log "Added a new version of smtp-host, smtp-user and smtp-pass."

# Cloud Run resolves `version = "latest"` when an instance starts, not when a
# version is added, so a new secret alone reaches nothing that is already
# running. Setting EMAIL_FROM rolls a revision, which is also what picks the new
# credentials up — one command, two reasons.
log "Rolling a new revision with EMAIL_FROM=${EMAIL_FROM} …"
gcloud run services update "$SERVICE" \
  --region "$REGION" \
  --update-env-vars "EMAIL_FROM=${EMAIL_FROM}" \
  --quiet >/dev/null

# ── 4. Verify what was actually stored ───────────────────────────────────────
#
# Reading the secrets back rather than reusing the values in memory is the whole
# point: this is the step that catches a value that was mangled on the way in.

log "Verifying the stored credentials …"

set +e
(
  cd "${REPO_ROOT}/services/api" || exit 1
  EMAIL_PROVIDER=smtp \
  SMTP_HOST="$(gcloud secrets versions access latest --secret="parentix-${ENV_NAME}-smtp-host")" \
  SMTP_USER="$(gcloud secrets versions access latest --secret="parentix-${ENV_NAME}-smtp-user")" \
  SMTP_PASS="$(gcloud secrets versions access latest --secret="parentix-${ENV_NAME}-smtp-pass")" \
  EMAIL_FROM="$EMAIL_FROM" \
  node scripts/check-mail.js ${TO:+--to "$TO"}
)
VERIFY_STATUS=$?
set -e

[ "$VERIFY_STATUS" = 0 ] || die "The stored credentials do not work, though the same values did in step 1.
       That difference is the storage layer — check for a stray newline:
         gcloud secrets versions access latest --secret=parentix-${ENV_NAME}-smtp-pass | wc -c
       should be 16, not 17."

log "Done. Outbound mail goes through Gmail as ${EMAIL_FROM}."
cat <<EOF

Two things this script deliberately does not do:

  1. EMAIL_FROM is set on the service, but Terraform owns it — the next
     'terraform apply' reverts it. Make it permanent in infrastructure/gcp:
       variable "email_from" { default = "${EMAIL_FROM}" }

  2. Gmail caps a free account at 500 recipients a day and Workspace at 2,000.
     Past the cap every send fails for 24 hours, which on this platform means
     password reset and signup verification stop — silently, from the outside.

EOF
