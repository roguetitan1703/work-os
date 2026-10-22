#!/usr/bin/env bash
# Multi-user load simulation (tests/load/README.md): a throwaway mongod, a production build run like the EC2 box
# (next start, --max-old-space-size=1024 as in deploy/systemd/work-os.service), the server meter (meter.cjs), a seeded
# team of 20, then sim.mjs. Never touches a real database.
#   bash tests/load/run.sh                      the full simulation (about 16 minutes for a working day)
#   bash tests/load/run.sh --minutes 3          a shorter day
#   LOAD_SCRIPT=other.mjs bash tests/load/run.sh ...   run another script of this folder against the same setup
# Environment (all optional):
#   SKIP_BUILD=1          reuse the existing .next build
#   LOAD_MPORT, LOAD_APORT, LOAD_METER   ports (default 27285, 3285, 4405)
#   LOAD_OUT=<dir>        keep the report (report.json, report.txt) and the server log there
#   LOAD_HEAP_MB          the server's heap cap (default 1024: t3.small)
#   MONGOD, PLAYWRIGHT_CORE, CHROME_EXE   as for tests/e2e/run.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MONGOD="${MONGOD:-/c/Program Files/MongoDB/Server/8.2/bin/mongod.exe}"
MPORT=${LOAD_MPORT:-27285}
APORT=${LOAD_APORT:-3285}
METER=${LOAD_METER:-4405}
HEAP=${LOAD_HEAP_MB:-1024}

TMP="$(mktemp -d "${TMPDIR:-${TEMP:-/tmp}}/wos-load.XXXXXX")"
DBPATH="$TMP/db"
OUT="${LOAD_OUT:-$TMP/out}"
mkdir -p "$DBPATH" "$OUT"
ENVFILE="$ROOT/.env.local"
ENVBAK="$ROOT/.env.local.load-bak"
MOVED=0
STARTED_MONGO=0
SERVER_PID=""

port_busy() { netstat -ano | tr -d '\r' | grep -qE ":$1[[:space:]].*LISTENING"; }
kill_port() {
  local pid
  for pid in $(netstat -ano | tr -d '\r' | grep -E ":$1[[:space:]].*LISTENING" | awk '{print $NF}' | sort -u); do
    taskkill //PID "$pid" //F //T >/dev/null 2>&1
  done
}
cleanup() {
  trap - EXIT INT TERM HUP
  # $! is a Git Bash pid: taskkill needs the Windows one (a raw $! can name an unrelated process and its tree).
  if [ -n "$SERVER_PID" ]; then
    wp=$(cat "/proc/$SERVER_PID/winpid" 2>/dev/null)
    kill_port "$APORT"
    [ -n "$wp" ] && taskkill //PID "$wp" //F //T >/dev/null 2>&1
  fi
  if [ "$STARTED_MONGO" = 1 ]; then kill_port "$MPORT"; sleep 1; fi
  if [ "$MOVED" = 1 ] && [ -e "$ENVBAK" ]; then mv "$ENVBAK" "$ENVFILE"; fi
  if [ -n "${LOAD_OUT:-}" ] && [ -e "$TMP/server.log" ]; then cp "$TMP/server.log" "$OUT/server.log"; fi
  rm -rf "$TMP/db" "$TMP/mongod.log" "$TMP/server.log" "$TMP/build.log" "$TMP/mail" "$TMP/state.json" "$TMP/team.json" "$TMP/shots"
  if [ -z "${LOAD_OUT:-}" ]; then rm -rf "$OUT"; fi
  rmdir "$TMP" 2>/dev/null
}
trap cleanup EXIT INT TERM HUP

for pt in $MPORT $APORT $METER; do
  if port_busy $pt; then echo "port $pt is already in use by something else; not touching it. Aborting."; exit 2; fi
done
if [ ! -x "$MONGOD" ] && [ ! -f "$MONGOD" ]; then echo "mongod not found at $MONGOD (set MONGOD=...)"; exit 2; fi

# .env.local holds the real database URI: out of the way while the throwaway app runs.
if [ -e "$ENVBAK" ]; then
  if [ -e "$ENVFILE" ]; then echo "$ENVBAK and $ENVFILE both exist; resolve by hand. Aborting."; exit 2; fi
  mv "$ENVBAK" "$ENVFILE"
fi
if [ -e "$ENVFILE" ]; then mv "$ENVFILE" "$ENVBAK" && MOVED=1; fi

# The same environment as tests/e2e/run.sh (its helpers are reused), on other ports and another database name.
export MONGODB_URI="mongodb://127.0.0.1:$MPORT/?replicaSet=rs0&directConnection=true"
export MONGODB_DB=workos_e2e_load
export BETTER_AUTH_SECRET=test-secret-load-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export APP_PASSWORD= SESSION_SECRET= MCP_TOKEN= MCP_ALLOW_URL_TOKEN= TRUST_PROXY=
export AUTH_RATE_LIMIT=off
export MAIL_CAPTURE_DIR="$TMP/mail" E2E_STATE="$TMP/state.json" E2E_SHOTS="$TMP/shots"
export CRON_SECRET=testcron-load-0123456789abcdef
export OPERATOR_EMAILS=e2e-owner@example.test
export APP_TZ=Asia/Kolkata
export APP_URL="http://localhost:$APORT" E2E_BASE="http://localhost:$APORT"
export E2E_MONGO_PORT=$MPORT LOAD_METER_URL="http://127.0.0.1:$METER" LOAD_OUT_DIR="$OUT"
export DISCORD_BOT_TOKEN= DISCORD_PUBLIC_KEY= DISCORD_APPLICATION_ID= DISCORD_API_BASE=
export VAPID_PUBLIC_KEY= VAPID_PRIVATE_KEY= VAPID_SUBJECT=
export EMAIL_HOST= EMAIL_PORT= EMAIL_SECURE= EMAIL_USER= EMAIL_PASSWORD= EMAIL_FROM= EMAIL_FROM_NAME= OWNER_EMAIL=
mkdir -p "$MAIL_CAPTURE_DIR"

echo "starting mongod on $MPORT"
nohup "$MONGOD" --replSet rs0 --port $MPORT --bind_ip 127.0.0.1 --dbpath "$(cygpath -w "$DBPATH" 2>/dev/null || echo "$DBPATH")" --logpath "$(cygpath -w "$TMP/mongod.log" 2>/dev/null || echo "$TMP/mongod.log")" >/dev/null 2>&1 &
STARTED_MONGO=1
ok=0
for i in $(seq 1 30); do
  if (cd "$ROOT/tests/e2e" && node rsinit.mjs >/dev/null 2>&1); then ok=1; break; fi
  sleep 1
done
[ "$ok" = 1 ] || { echo "mongod did not come up"; exit 2; }

if [ "${SKIP_BUILD:-0}" = 1 ] && [ -f "$ROOT/.next/BUILD_ID" ]; then
  echo "SKIP_BUILD: reusing .next"
else
  echo "building (npm run build)"
  (cd "$ROOT" && npm run build) >"$TMP/build.log" 2>&1 || { echo "BUILD FAILED"; tail -40 "$TMP/build.log"; exit 3; }
fi

echo "seeding a team of 20"
(cd "$HERE" && node seed.mjs </dev/null) || { echo "SEED FAILED"; exit 3; }

echo "starting app on $APORT (heap ${HEAP} MB, meter on $METER)"
# NODE_OPTIONS reaches only this process: the server, the way the systemd unit runs it, plus the meter.
(cd "$ROOT" && NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS="--max-old-space-size=$HEAP --require $(cygpath -w "$HERE/meter.cjs" 2>/dev/null || echo "$HERE/meter.cjs")" METER_PORT=$METER exec node node_modules/next/dist/bin/next start -p $APORT) >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
up=0
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$APORT/login" || true)
  [ "$code" = 200 ] && { up=1; break; }
  sleep 1
done
[ "$up" = 1 ] || { echo "server did not come up"; tail -20 "$TMP/server.log"; exit 3; }

(cd "$HERE" && node "${LOAD_SCRIPT:-sim.mjs}" "$@" </dev/null)
rc=$?
grep -E "Error|error" "$TMP/server.log" | grep -v "^\s*$" | head -5
[ -n "${LOAD_OUT:-}" ] && echo "report: $OUT"
exit $rc
