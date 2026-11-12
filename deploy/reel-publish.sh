#!/usr/bin/env bash
# One reel's publish, installed as /usr/local/sbin/work-os-reel-publish and run once at the slot by the
# work-os-reel-<post>.service that work-os-reel-at made. Asks the app on localhost to publish the container
# (POST /api/cron/reel, which checks it, publishes, and alerts Om either way). CRON_SECRET goes in a header read from
# stdin, so it never appears in a process list or a log; the Instagram token stays inside the app.
set -euo pipefail
: "${CRON_SECRET:?CRON_SECRET is not set in /etc/work-os/reel.env}"
[ $# -eq 3 ] || { echo "usage: work-os-reel-publish <post-id> <container-id> <slot-epoch>" >&2; exit 2; }
URL="${WORK_OS_LOCAL_URL:-http://127.0.0.1:${WORK_OS_PORT:-3100}}/api/cron/reel"
BODY="$(printf '{"post":"%s","container":"%s","slot":%s}' "$1" "$2" "$3")"
# The app may still be starting (a reboot just before the slot): a refused connection is retried for ~5 min; the app
# itself refuses to post more than 30 min late and alerts instead (a repeated call never publishes twice). One call can
# take ~8 min (a container still processing, a retried publish); the unit stops it all at 10 min. A final failure fails
# the unit, and work-os-reel-at --done records it in /var/log/work-os-reel-failed.log (shown by --list).
printf 'Authorization: Bearer %s\n' "$CRON_SECRET" |
  curl -fsS --retry 20 --retry-delay 15 --retry-connrefused --max-time 540 -X POST -H @- \
    -H 'Content-Type: application/json' --data "$BODY" "$URL"
echo
