#!/usr/bin/env bash
# Nightly backup of the Work OS database (docs/hosting.md "Backups"): mongodump of MONGODB_DB to a gzip archive on
# this server, then a copy to S3. Run by work-os-backup.timer; scripts/cutover.sh runs it with --local-only first.
#
#   deploy/backup.sh                 dump, copy to S3 (when BACKUP_S3_URI is set), delete local dumps past retention
#   deploy/backup.sh --local-only    dump only
#
# Environment (from /etc/work-os/env under systemd):
#   MONGODB_URI (or a MONGO_*_URI name)  the database server (secret; passed to mongodump in a 0600 file, never argv)
#   MONGODB_DB                           database (default workos)
#   BACKUP_DIR                           local folder (default /var/backups/work-os)
#   BACKUP_KEEP_DAYS                     local retention in days (default 14); S3 retention is a lifecycle rule
#   BACKUP_S3_URI                        e.g. s3://delpat-backups/work-os (unset: no S3 copy). Credentials come from
#                                        the instance role, never from this file.
# Needs mongodump (MongoDB Database Tools) and, for S3, the aws CLI. Prints file names and sizes, never the URI.
set -euo pipefail
LOCAL_ONLY=0
[ "${1:-}" = "--local-only" ] && LOCAL_ONLY=1

if [ -z "${MONGODB_URI:-}" ]; then
  for v in $(compgen -e); do
    if [[ "$v" =~ (^|_)MONGO(DB)?_(URI|URL)$ ]]; then MONGODB_URI="${!v}"; break; fi
  done
fi
: "${MONGODB_URI:?MONGODB_URI is not set}"
DB="${MONGODB_DB:-workos}"
DIR="${BACKUP_DIR:-/var/backups/work-os}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
command -v mongodump >/dev/null || { echo "mongodump is not installed (MongoDB Database Tools)" >&2; exit 2; }

umask 077
mkdir -p "$DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$DIR/$DB-$STAMP.archive.gz"
CFG="$(mktemp)"
trap 'rm -f "$CFG"' EXIT
# mongodump reads the connection string from a YAML config file, so it is not visible in ps.
printf 'uri: "%s"\n' "${MONGODB_URI//\"/\\\"}" >"$CFG"

echo "dumping database $DB to $FILE"
mongodump --config="$CFG" --db="$DB" --archive="$FILE" --gzip --quiet
[ -s "$FILE" ] || { echo "the dump is empty" >&2; rm -f "$FILE"; exit 1; }
echo "  $(du -h "$FILE" | cut -f1)"

if [ "$LOCAL_ONLY" = 0 ] && [ -n "${BACKUP_S3_URI:-}" ]; then
  command -v aws >/dev/null || { echo "aws CLI is not installed" >&2; exit 2; }
  aws s3 cp "$FILE" "${BACKUP_S3_URI%/}/$(basename "$FILE")" --sse AES256 --only-show-errors
  echo "  copied to ${BACKUP_S3_URI%/}/"
fi

if [ "$LOCAL_ONLY" = 0 ]; then
  find "$DIR" -maxdepth 1 -name "$DB-*.archive.gz" -mtime +"$KEEP" -print -delete | sed 's/^/  removed old /'
fi
echo "backup done"
