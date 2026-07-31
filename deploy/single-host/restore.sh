#!/usr/bin/env bash
#
# Restore a backup produced by backup.sh.
#
#   ./restore.sh /var/backups/parentix/parentix-20260731T031700Z.sql.gz
#
# A backup you have never restored is a hypothesis, not a backup. Test this on a
# throwaway instance before you need it for real.
set -euo pipefail
cd "$(dirname "$0")"

ARCHIVE=${1:-}
if [[ -z $ARCHIVE || ! -f $ARCHIVE ]]; then
  echo "usage: $0 <backup.sql.gz>" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

cat <<EOF

This REPLACES the contents of database '${POSTGRES_DB:-parentix}' with:
  ${ARCHIVE}

Every account, child, device and payment record currently in it is dropped.
EOF
read -r -p "Type 'restore' to continue: " confirm
[[ $confirm == restore ]] || { echo "Aborted."; exit 1; }

# Stop the API so nothing writes mid-restore and so no connection blocks the
# DROPs in the dump. Postgres itself stays up.
echo "==> Stopping api"
docker compose stop api caddy

echo "==> Restoring"
gunzip -c "$ARCHIVE" | docker compose exec -T postgres \
  psql -U "${POSTGRES_USER:-parentix}" -d "${POSTGRES_DB:-parentix}" -v ON_ERROR_STOP=1 --quiet

# The dump may predate the current code — bring the schema forward before the
# API sees it.
echo "==> Applying migrations"
docker compose run --rm --no-deps api node scripts/migrate.js up

echo "==> Starting api"
docker compose up -d --wait

echo "Restored from $(basename "$ARCHIVE")."
