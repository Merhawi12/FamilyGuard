#!/usr/bin/env bash
#
# Release. Idempotent — run it as often as you like.
#
#   ./deploy.sh              pull, build, migrate, restart
#   ./deploy.sh --no-pull    deploy the working tree as-is
set -euo pipefail
cd "$(dirname "$0")"

PULL=1
[[ ${1:-} == --no-pull ]] && PULL=0

if [[ ! -f .env ]]; then
  echo "error: .env is missing. cp .env.example .env && chmod 600 .env" >&2
  exit 1
fi

# Fail early and loudly rather than starting containers that cannot work.
missing=()
for key in APP_DOMAIN ADMIN_DOMAIN API_DOMAIN TLS_EMAIL POSTGRES_PASSWORD JWT_SECRET FIELD_ENCRYPTION_KEY; do
  value=$(grep -E "^${key}=" .env | head -1 | cut -d= -f2-)
  [[ -z $value ]] && missing+=("$key")
done
if (( ${#missing[@]} )); then
  printf 'error: unset in .env: %s\n' "${missing[*]}" >&2
  exit 1
fi

# 64 hex characters exactly — the API refuses to start otherwise, and it is far
# nicer to find that out here than from a container restart loop.
key_len=$(grep -E '^FIELD_ENCRYPTION_KEY=' .env | cut -d= -f2- | tr -d '\r\n' | wc -c)
if (( key_len != 64 )); then
  echo "error: FIELD_ENCRYPTION_KEY must be 64 hex chars (got ${key_len}). openssl rand -hex 32" >&2
  exit 1
fi

if (( PULL )); then
  echo "==> Updating source"
  git -C ../.. pull --ff-only
fi

echo "==> Building images"
docker compose build

echo "==> Starting data stores"
docker compose up -d --wait postgres redis

# Migrations complete before any new API container serves traffic. `run --rm`
# uses the freshly built image, so this is the new schema, not the old one.
echo "==> Running migrations"
docker compose run --rm --no-deps api node scripts/migrate.js up

echo "==> Starting application"
docker compose up -d --wait

docker image prune -f >/dev/null

echo "==> Health"
sleep 2
docker compose ps
if docker compose exec -T api wget -qO- http://127.0.0.1:5000/api/health >/dev/null 2>&1; then
  echo "api: healthy"
else
  echo "api: NOT healthy — docker compose logs api" >&2
  exit 1
fi

APP=$(grep -E '^APP_DOMAIN=' .env | cut -d= -f2-)
echo
echo "Deployed. https://${APP}"
echo "First staff account:"
echo "  docker compose run --rm api node scripts/create-admin.js --email you@example.com --name 'Your Name'"
