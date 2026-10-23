#!/usr/bin/env bash
# The alert check, installed as /usr/local/sbin/work-os-cron-alerts and run by work-os-alerts.timer (replaces the cron-job.org job). Calls the app on localhost with
# CRON_SECRET in a header read from stdin, so the secret never appears in a process list or a log.
set -euo pipefail
: "${CRON_SECRET:?CRON_SECRET is not set in /etc/work-os/env}"
URL="${WORK_OS_LOCAL_URL:-http://127.0.0.1:${WORK_OS_PORT:-3000}}/api/cron/alerts"
# The answer is counts only ({"alerts":2,"sent":2,...}); a 502 (a channel failed) or a 401 fails the unit.
printf 'Authorization: Bearer %s\n' "$CRON_SECRET" | curl -fsS --max-time 60 -X POST -H @- "$URL"
echo
