#!/usr/bin/env bash
# The one-time cut-over from single-user Work OS to multi-user (docs/hosting.md "Cut-over"). Runs the steps in order,
# stops at the first error. A dry run unless --apply.
#
# On the server it is installed root-owned as /usr/local/sbin/work-os-cutover (next to work-os-env.sh and
# work-os-backup) and run with sudo. Root only stops and starts the app and edits the env file (step 6); every node
# step and the backup run as the app user (--app-user, default workos), from the live release (--app-dir).
#
#   sudo work-os-cutover --db workos --env-file /etc/work-os/env                              dry run
#   sudo work-os-cutover --db workos --env-file /etc/work-os/env --apply --service work-os     do it
#
#   0. checks: the variables the steps need are set (names only are printed). With --apply, whatever --from says:
#      a mongodump first (work-os-backup --local-only; --skip-backup if you made one yourself), and the app stopped
#      (--service) until step 5 or the end
#   1. accounts for every OPERATOR_EMAILS address           scripts/create-operators.mjs
#   2. Om, the organization Delpat, Om as owner             scripts/migrate-auth.mjs
#   3. orgId / owner / visibility on every document         scripts/migrate-ownership.mjs: with --apply, first
#                                                            --copy-to <db>_cutover_<time> (a rehearsal on a copy;
#                                                            the copy stays for you to drop), then --apply
#   4. schedule, modes, timezone, Discord ids as data       scripts/migrate-phase3.mjs (reads DISCORD_GUILD_ID and
#                                                            DISCORD_OWNER_ID one last time)
#   5. Discord commands registered again (they gain /link)  scripts/discord-register.mjs; needs the app running
#                                                            (--service starts it first); skipped when Discord is
#                                                            not configured
#   6. DISCORD_GUILD_ID and DISCORD_OWNER_ID removed from --env-file (a copy is kept next to it)
#
# Options:
#   --db <name>         the database (required; never taken from the environment)
#   --apply             do it (default: dry run)
#   --env-file <path>   load the app's variables from this systemd EnvironmentFile; step 6 edits it
#   --service <unit>    systemd unit of the app: stopped before step 1, started before step 5 (or at the end)
#   --app-dir <dir>     the release whose scripts run (default /srv/work-os/current when installed, else this repo)
#   --app-user <user>   who runs them when this script runs as root (default workos)
#   --base <url>        where the app answers for step 5 (default http://127.0.0.1:3000)
#   --tz <zone>         the owner's timezone for step 4 (default APP_TZ, else Asia/Kolkata)
#   --from <n>, --to <n>   run only steps n..m (e.g. --from 5 after fixing Discord)
#   --skip-backup       no mongodump before --apply
#
# The steps are idempotent: running one again changes nothing that is already done.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$HERE/work-os-env.sh" ]; then
  # Installed in /usr/local/sbin: the helpers beside it are root-owned too.
  . "$HERE/work-os-env.sh"
  BACKUP_SH="$HERE/work-os-backup"
  APP_DIR="/srv/work-os/current"
else
  # shellcheck source=../deploy/env.sh
  . "$HERE/../deploy/env.sh"
  BACKUP_SH="$HERE/../deploy/backup.sh"
  APP_DIR="$(cd "$HERE/.." && pwd)"
fi

DB="" APPLY=0 ENV_FILE="" SERVICE="" BASE="http://127.0.0.1:3000" TZ_ARG="" FROM=0 TO=6 SKIP_BACKUP=0 APP_USER=workos
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --app-dir) APP_DIR="${2:-}"; shift 2 ;;
    --app-user) APP_USER="${2:-}"; shift 2 ;;
    --base) BASE="${2:-}"; shift 2 ;;
    --tz) TZ_ARG="${2:-}"; shift 2 ;;
    --from) FROM="${2:-}"; shift 2 ;;
    --to) TO="${2:-}"; shift 2 ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    -h|--help) sed -n '2,41p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done
[ -n "$DB" ] || { echo "Name the database: --db <name>" >&2; exit 2; }
[[ "$FROM" =~ ^[0-6]$ && "$TO" =~ ^[0-6]$ ]] || { echo "--from/--to take 0..6" >&2; exit 2; }
[ -f "$APP_DIR/scripts/migrate-auth.mjs" ] || { echo "no Work OS release at $APP_DIR (--app-dir)" >&2; exit 2; }
if [ "$(id -u)" = 0 ]; then
  id "$APP_USER" >/dev/null 2>&1 || { echo "user $APP_USER does not exist (--app-user)" >&2; exit 2; }
fi
[ -z "$ENV_FILE" ] || load_env "$ENV_FILE"
# The app also accepts the Atlas integration's MONGO_*_URI names; the helpers below want MONGODB_URI.
if [ -z "${MONGODB_URI:-}" ]; then
  for v in $(compgen -e); do
    if [[ "$v" =~ (^|_)MONGO(DB)?_(URI|URL)$ ]]; then export MONGODB_URI="${!v}"; break; fi
  done
fi
export MONGODB_DB="$DB"

APPLY_FLAG=()
[ "$APPLY" = 1 ] && APPLY_FLAG=(--apply)
want() { [ "$1" -ge "$FROM" ] && [ "$1" -le "$TO" ]; }
step() { echo; echo "=== $1 ==="; }
fail() { echo; echo "STOPPED at: $1" >&2; exit 1; }
has_systemctl() { command -v systemctl >/dev/null 2>&1; }
# Run as the app user when we are root (runuser keeps the exported variables and the working directory).
as_app() { if [ "$(id -u)" = 0 ]; then runuser -u "$APP_USER" -- "$@"; else "$@"; fi; }
node_step() { (cd "$APP_DIR" && as_app node "$@") || fail "$CURRENT"; }
live() { [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/live" || true)" = 200 ]; }
wait_live() { local _; for _ in $(seq 1 60); do live && return 0; sleep 1; done; return 1; }

echo "Work OS cut-over on database \"$DB\": $([ "$APPLY" = 1 ] && echo APPLY || echo 'DRY RUN (nothing changes; add --apply)')"

CURRENT="0. checks"; step "$CURRENT"
check_vars MONGODB_URI BETTER_AUTH_SECRET APP_URL OWNER_EMAIL OPERATOR_EMAILS || fail "$CURRENT (set the MISSING variables)"
echo "  Discord (steps 4-5, optional):"
check_vars DISCORD_BOT_TOKEN DISCORD_APPLICATION_ID DISCORD_PUBLIC_KEY DISCORD_GUILD_ID DISCORD_OWNER_ID || echo "  (Discord parts are skipped where a variable is missing)"
command -v node >/dev/null || fail "$CURRENT (node is not installed)"
STOPPED=0
STARTED=0
if [ "$APPLY" = 1 ]; then
  # Before anything is written, whatever --from says.
  if [ "$SKIP_BACKUP" = 0 ]; then
    echo "  backup before writing:"
    (cd / && as_app bash "$BACKUP_SH" --local-only) || fail "$CURRENT (backup; --skip-backup if you have one)"
  fi
  if [ -n "$SERVICE" ] && has_systemctl; then
    echo "  stopping $SERVICE while the data moves"
    systemctl stop "$SERVICE" || fail "$CURRENT (systemctl stop $SERVICE)"
    STOPPED=1
  fi
fi

if want 1; then
  CURRENT="1. operator accounts"; step "$CURRENT"
  node_step scripts/create-operators.mjs --db "$DB" "${APPLY_FLAG[@]}"
fi

if want 2; then
  CURRENT="2. migrate-auth"; step "$CURRENT"
  node_step scripts/migrate-auth.mjs --db "$DB" "${APPLY_FLAG[@]}"
fi

# Steps 3 and 4 need the organization that step 2 makes: in a dry run on a database from before step 2 they can only
# say so (rehearse the whole chain with --apply on a restored copy: docs/hosting.md "Cut-over").
org_exists() {
  (cd "$APP_DIR" && as_app node -e "
    const { MongoClient } = require('mongodb');
    const c = new MongoClient(process.env.MONGODB_URI);
    c.connect().then(() => c.db(process.argv[1]).collection('organization').countDocuments())
      .then(n => c.close().then(() => process.exit(n ? 0 : 1)), () => process.exit(2));
  " "$DB")
}

if want 3; then
  CURRENT="3. migrate-ownership"; step "$CURRENT"
  if [ "$APPLY" = 1 ]; then
    COPY="${DB}_cutover_$(date -u +%Y%m%d%H%M)"
    echo "  rehearsal on a copy: $COPY"
    node_step scripts/migrate-ownership.mjs --db "$DB" --copy-to "$COPY"
    echo "  the copy again (must find nothing to do; computers without an owner are only reported):"
    AGAIN="$(cd "$APP_DIR" && as_app node scripts/migrate-ownership.mjs --db "$COPY")" || fail "$CURRENT (second run on the copy)"
    echo "$AGAIN"
    if echo "$AGAIN" | grep -E '^  - ' | grep -vq '(left as they are)'; then fail "$CURRENT (a second run on the copy still found work)"; fi
    echo "  now the real one:"
    node_step scripts/migrate-ownership.mjs --db "$DB" --apply
    echo "  (the copy $COPY stays; drop it when you are happy)"
  elif org_exists; then
    node_step scripts/migrate-ownership.mjs --db "$DB"
  else
    echo "  - waits on step 2 (no organization yet): runs with --apply"
  fi
fi

if want 4; then
  CURRENT="4. migrate-phase3"; step "$CURRENT"
  TZ_FLAG=()
  [ -n "$TZ_ARG" ] && TZ_FLAG=(--tz "$TZ_ARG")
  if [ "$APPLY" = 1 ] || org_exists; then
    node_step scripts/migrate-phase3.mjs --db "$DB" "${APPLY_FLAG[@]}" "${TZ_FLAG[@]}"
  else
    echo "  - waits on step 2 (no organization yet): runs with --apply"
  fi
fi

start_app() {
  if [ "$STOPPED" = 1 ] && [ "$STARTED" = 0 ]; then
    echo "  starting $SERVICE"
    systemctl start "$SERVICE" || fail "$CURRENT (systemctl start $SERVICE)"
    STARTED=1
    wait_live || fail "$CURRENT ($SERVICE does not answer at $BASE/api/live: journalctl -u $SERVICE)"
  fi
}

if want 5; then
  CURRENT="5. Discord commands"; step "$CURRENT"
  if [ -z "${DISCORD_BOT_TOKEN:-}" ] || [ -z "${DISCORD_APPLICATION_ID:-}" ] || [ -z "${DISCORD_PUBLIC_KEY:-}" ]; then
    echo "  · Discord is not configured: skipped"
  else
    [ "$APPLY" = 1 ] && start_app
    ok=0
    if [ "$APPLY" = 1 ]; then wait_live && ok=1; else live && ok=1; fi
    if [ "$ok" = 1 ]; then
      node_step scripts/discord-register.mjs --db "$DB" --base "$BASE" "${APPLY_FLAG[@]}"
    elif [ "$APPLY" = 1 ]; then
      fail "$CURRENT (the app does not answer at $BASE/api/live)"
    else
      echo "  - the app is not running at $BASE: with --apply it registers once the app is up"
    fi
  fi
fi

if want 6; then
  CURRENT="6. old Discord variables"; step "$CURRENT"
  if [ -z "$ENV_FILE" ]; then
    echo "  · no --env-file: remove DISCORD_GUILD_ID and DISCORD_OWNER_ID from the app's environment by hand"
  elif ! grep -qE '^[[:space:]]*(DISCORD_GUILD_ID|DISCORD_OWNER_ID)=' "$ENV_FILE"; then
    echo "  = already gone from $ENV_FILE"
  elif [ "$APPLY" = 1 ]; then
    BAK="$ENV_FILE.bak-$(date -u +%Y%m%d%H%M%S)"
    cp -p "$ENV_FILE" "$BAK" || fail "$CURRENT (copy $ENV_FILE)"
    grep -vE '^[[:space:]]*(DISCORD_GUILD_ID|DISCORD_OWNER_ID)=' "$BAK" >"$ENV_FILE" || fail "$CURRENT (rewrite $ENV_FILE)"
    echo "  ✓ removed from $ENV_FILE (previous copy: $BAK; it holds secrets, delete it once all is well)"
    echo "    the app no longer reads them: no restart needed"
  else
    echo "  - would remove them from $ENV_FILE"
  fi
fi

# Never leave the app stopped.
if [ "$STOPPED" = 1 ] && [ "$STARTED" = 0 ]; then CURRENT="restart"; step "$CURRENT"; start_app; fi

echo
if [ "$APPLY" = 1 ]; then
  echo "Cut-over steps $FROM-$TO done."
  echo "Next (docs/hosting.md): Om opens \$APP_URL/login → Forgot password?, signs in, makes a Claude chat key, re-adds his computers."
else
  echo "Dry run finished: nothing was changed."
fi
