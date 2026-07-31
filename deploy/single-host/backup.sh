#!/usr/bin/env bash
#
# Nightly logical backup of Postgres.
#
# This matters more here than it would on the Cloud Run stack: Cloud SQL takes
# automated backups by default, a container on one persistent disk takes none.
# Without this, a lost disk is a lost customer database with no way back.
set -euo pipefail
cd "$(dirname "$0")"

set -a
# shellcheck disable=SC1091
. ./.env
set +a

DEST=${BACKUP_DIR:-/var/backups/parentix}
KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="${DEST}/parentix-${STAMP}.sql.gz"

install -d -m 700 "$DEST"

# Write to .partial first: an interrupted dump that lands under the real name
# looks like a good backup right up until the day you need it.
docker compose exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-parentix}" -d "${POSTGRES_DB:-parentix}" --clean --if-exists \
  | gzip -9 > "${FILE}.partial"

mv "${FILE}.partial" "$FILE"
chmod 600 "$FILE"

if [[ -n ${BACKUP_GCS_URI:-} ]]; then
  # An on-box copy does not survive the failure it exists to protect against.
  # The instance's service account needs roles/storage.objectCreator on the
  # bucket; no key file is involved.
  gsutil -q cp "$FILE" "${BACKUP_GCS_URI%/}/$(basename "$FILE")"
fi

find "$DEST" -name 'parentix-*.sql.gz' -mtime "+${KEEP_DAYS}" -delete
find "$DEST" -name 'parentix-*.sql.gz.partial' -mtime +1 -delete

echo "backup ok: ${FILE} ($(du -h "$FILE" | cut -f1))"
