#!/usr/bin/env bash
# Shared helpers for the deploy scripts. Not executable on its own.

set -euo pipefail

ENV_NAME="${ENV_NAME:-prod}"
AWS_REGION="${AWS_REGION:-us-east-2}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed."
}

require_aws_auth() {
  require_tool aws
  aws sts get-caller-identity >/dev/null 2>&1 \
    || die "No usable AWS credentials. Run 'aws configure' or export AWS_PROFILE."
}

# stack_output <stack-suffix> <OutputKey>
# e.g. stack_output Api EcrRepositoryUri
stack_output() {
  local stack="Parentix-${ENV_NAME}-$1"
  local key="$2"
  local value

  value="$(aws cloudformation describe-stacks \
    --stack-name "$stack" \
    --region "$AWS_REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" \
    --output text 2>/dev/null || true)"

  [ -n "$value" ] && [ "$value" != "None" ] \
    || die "Output '${key}' not found on stack '${stack}'. Deploy the infrastructure first (npm run infra:deploy)."

  printf '%s' "$value"
}
