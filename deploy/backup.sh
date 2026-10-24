#!/usr/bin/env bash
# Nightly backup of the Work OS database (docs/hosting.md "Backups"): mongodump of MONGODB_DB, encrypted with age to a
# public key whose private half is NOT on this server, uploaded to Cloudflare R2 (or S3) and checked by size.
# Installed as /usr/local/sbin/work-os-backup; run by work-os-backup.timer (as workos), and by the cut-over with
# --local-only first.
#
#   work-os-backup                   dump -> age -> upload -> verify; the local file is deleted afterwards
#   work-os-backup --local-only      plain gzip dump on this disk, nothing uploaded, never deleted (the cut-over's
#                                    safety copy; it is NOT encrypted, so it stays 0600 in BACKUP_DIR: delete it
#                                    when the cut-over is done)
#
# Environment (/etc/work-os/env under systemd; the R2 keys come from a second file, see below):
#   MONGODB_URI (or a MONGO_*_URI name)  the database server (secret; passed to mongodump in a 0600 file, never argv)
#   MONGODB_DB                           database (default workos)
#   BACKUP_DIR                           local folder (default /var/backups/work-os); the dump is written here first
#   BACKUP_S3_URI                        s3://<bucket>/<prefix>. Unset: a normal run refuses (nothing to do)
#   BACKUP_S3_ENDPOINT                   R2: https://<account id>.r2.cloudflarestorage.com. Set: R2 mode (region auto,
#                                        no --sse header). Unset: real S3 (instance role, --sse AES256)
#   BACKUP_AGE_RECIPIENT                 age public key(s), age1..., space separated. Required to upload: no key, no
#                                        upload (fail closed). Never the private key.
#   BACKUP_KEEP_LOCAL                    encrypted copies to keep on this disk after a good upload (default 0)
#   BACKUP_MIN_FREE_KB                   refuse to start with less free space in BACKUP_DIR (default 1048576 = 1 GB)
# R2 only: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, from /etc/work-os/backup-r2 (root only, read by systemd and
# given to this service alone). Never printed, never on a command line.
# Needs mongodump (MongoDB Database Tools), age, and the aws CLI. Prints file names and sizes, never a secret.
set -euo pipefail
LOCAL_ONLY=0
case "${1:-}" in
  "") ;;
  --local-only) LOCAL_ONLY=1 ;;
  *) echo "usage: work-os-backup [--local-only]" >&2; exit 2 ;;
esac

if [ -z "${MONGODB_URI:-}" ]; then
  for v in $(compgen -e); do
    if [[ "$v" =~ (^|_)MONGO(DB)?_(URI|URL)$ ]]; then MONGODB_URI="${!v}"; break; fi
  done
fi
: "${MONGODB_URI:?MONGODB_URI is not set}"
DB="${MONGODB_DB:-workos}"
DIR="${BACKUP_DIR:-/var/backups/work-os}"
KEEP="${BACKUP_KEEP_LOCAL:-0}"
MINFREE="${BACKUP_MIN_FREE_KB:-1048576}"
URI="${BACKUP_S3_URI:-}"
ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
[[ "$KEEP" =~ ^[0-9]+$ ]] || { echo "BACKUP_KEEP_LOCAL must be a number" >&2; exit 2; }
[[ "$MINFREE" =~ ^[0-9]+$ ]] || { echo "BACKUP_MIN_FREE_KB must be a number" >&2; exit 2; }
command -v mongodump >/dev/null || { echo "mongodump is not installed (MongoDB Database Tools)" >&2; exit 2; }

RECIPIENTS=()
if [ "$LOCAL_ONLY" = 0 ]; then
  # Everything that can stop a run is checked before any dump is made.
  [ -n "$URI" ] || { echo "BACKUP_S3_URI is not set: nothing to upload to (use --local-only for a local copy)" >&2; exit 2; }
  [[ "$URI" =~ ^s3://[^/[:space:]]+(/.*)?$ ]] || { echo "BACKUP_S3_URI must look like s3://bucket/prefix" >&2; exit 2; }
  read -r -a RECIPIENTS <<<"${BACKUP_AGE_RECIPIENT:-}"
  [ "${#RECIPIENTS[@]}" -gt 0 ] || { echo "BACKUP_AGE_RECIPIENT is not set: refusing to upload an unencrypted dump" >&2; exit 2; }
  for r in "${RECIPIENTS[@]}"; do
    [[ "$r" =~ ^age1[a-z0-9]{50,}$ ]] || { echo "BACKUP_AGE_RECIPIENT holds something that is not an age public key (age1...)" >&2; exit 2; }
  done
  command -v age >/dev/null || { echo "age is not installed" >&2; exit 2; }
  command -v aws >/dev/null || { echo "aws CLI is not installed" >&2; exit 2; }
  if [ -n "$ENDPOINT" ]; then
    [[ "$ENDPOINT" =~ ^https://[^/[:space:]]+$ ]] || { echo "BACKUP_S3_ENDPOINT must look like https://<account id>.r2.cloudflarestorage.com" >&2; exit 2; }
    [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] || { echo "R2 keys are missing (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from /etc/work-os/backup-r2)" >&2; exit 2; }
  fi
fi

umask 077
mkdir -p "$DIR"
FREE="$(df -Pk "$DIR" | awk 'NR==2 {print $4}')"
if [ -z "$FREE" ] || [ "$FREE" -lt "$MINFREE" ]; then
  echo "less than $((MINFREE / 1024)) MB free in $DIR (${FREE:-?} KB): not starting" >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CFG="$(mktemp)"
PART=""; ENC=""
# A failed upload leaves no dump behind when BACKUP_KEEP_LOCAL is 0: the disk is short, and tomorrow dumps again.
trap 'rm -f "$CFG" "$PART"; [ "$KEEP" != 0 ] || [ -z "$ENC" ] || rm -f "$ENC"' EXIT
# mongodump reads the connection string from a YAML config file, so it is not visible in ps. It also never gets the
# storage keys.
printf 'uri: "%s"\n' "${MONGODB_URI//\"/\\\"}" >"$CFG"
dump() { env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN mongodump --config="$CFG" --db="$DB" --gzip --quiet "$@"; }

if [ "$LOCAL_ONLY" = 1 ]; then
  FILE="$DIR/$DB-$STAMP.archive.gz"
  PART="$FILE.partial"
  echo "dumping database $DB to $FILE (not encrypted: delete it when done)"
  dump --archive="$PART"
  [ -s "$PART" ] || { echo "the dump is empty" >&2; exit 1; }
  mv "$PART" "$FILE"; PART=""
  echo "  $(du -h "$FILE" | cut -f1)"
  echo "backup done"
  exit 0
fi

NAME="$DB-$STAMP.archive.gz.age"
FILE="$DIR/$NAME"
PART="$FILE.partial"; ENC="$FILE"
echo "dumping database $DB, encrypting, to $FILE"
AGEARGS=()
for r in "${RECIPIENTS[@]}"; do AGEARGS+=(-r "$r"); done
dump --archive | age "${AGEARGS[@]}" -o "$PART"
[ -s "$PART" ] || { echo "the dump is empty" >&2; exit 1; }
mv "$PART" "$FILE"; PART=""
SIZE="$(wc -c <"$FILE" | tr -d ' ')"
echo "  $SIZE bytes encrypted"

AWSARGS=()
if [ -n "$ENDPOINT" ]; then
  # R2: no instance role, region auto, no server-side-encryption header (R2 encrypts at rest and does not take it),
  # and no extra checksum headers (R2 rejects some of what newer aws CLIs send by default).
  export AWS_DEFAULT_REGION=auto AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
  AWSARGS=(--endpoint-url "$ENDPOINT")
  CPARGS=()
else
  CPARGS=(--sse AES256)
fi
DEST="${URI%/}/$NAME"
aws "${AWSARGS[@]}" s3 cp "$FILE" "$DEST" "${CPARGS[@]}" --only-show-errors
# The upload is only counted once the object is listed with the size we wrote.
REMOTE="$(aws "${AWSARGS[@]}" s3 ls "$DEST" | awk -v n="$NAME" '$4 == n {print $3}' | head -1)"
if [ "$REMOTE" != "$SIZE" ]; then
  echo "upload check failed: sent $SIZE bytes, the bucket lists '${REMOTE:-nothing}'" >&2
  exit 1
fi
echo "  uploaded to ${URI%/}/ and checked ($REMOTE bytes)"

# Local copies: none by default (the disk is short). Keep the newest BACKUP_KEEP_LOCAL encrypted ones.
ls -1t "$DIR/$DB-"*.archive.gz.age 2>/dev/null | tail -n +"$((KEEP + 1))" | while IFS= read -r old; do
  rm -f -- "$old" && echo "  removed local $(basename "$old")"
done || true
echo "backup done"
