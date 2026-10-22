#!/usr/bin/env bash
# Runs every e2e suite against a throwaway mongod + a production build of the app. See README.md.
#   tests/e2e/run.sh                 all suites
#   tests/e2e/run.sh today search    only these
# Environment (all optional):
#   SKIP_BUILD=1       reuse the existing .next build
#   E2E_MPORT, E2E_APORT, E2E_DPORT   ports (default 27281, 3281, 4401); each builder uses its own
#   MONGOD=<path>      mongod binary (default: C:\Program Files\MongoDB\Server\8.2\bin\mongod.exe)
#   PLAYWRIGHT_CORE=<folder of playwright-core>   CHROME_EXE=<chrome.exe>
#   E2E_LOGS=<dir>     keep each suite's log there (default: temp dir, deleted at the end); the app server log too
#   E2E_WAIT=<s>       idle time of the nav-preload suites (default 65)
#   E2E_EXTRA='name|file|seed|plain'   one extra throwaway suite (a probe), run after the others
# Never touches the real database: it starts its own mongod on 27281 and the app on 3281, and cleans both up.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MONGOD="${MONGOD:-/c/Program Files/MongoDB/Server/8.2/bin/mongod.exe}"
MPORT=${E2E_MPORT:-27281}
APORT=${E2E_APORT:-3281}
DPORT=${E2E_DPORT:-4401}

# name | file | seed profile | server mode
SUITES="
today|today.mjs|today|plain
claude-page|claude-page.mjs|none|plain
nav|nav.mjs|nav|plain
nav-cross|nav-cross.mjs|nav|plain
nav-preload-1|nav-preload-1.mjs|nav|plain
nav-preload-2|nav-preload-2.mjs|nav|plain
fix-check|fix-check.mjs|none|plain
settings|settings.mjs|none|plain
review|review.mjs|base|plain
search|search.mjs|base|plain
dispatcher-backend|dispatcher-backend.mjs|none|plain
dispatcher-backend-2|dispatcher-backend-2.mjs|base|plain
dispatcher-ui|dispatcher-ui.mjs|none|plain
launcher-backend|launcher-backend.mjs|none|plain
usage|usage.mjs|none|plain
auth|auth.mjs|none|plain
tenancy|tenancy.mjs|none|plain
team|team.mjs|none|plain
push|push.mjs|none|plain
budgets|budgets.mjs|none|plain
alerts-once|alerts-once.mjs|none|discord
discord-link|discord-link.mjs|none|discord
leak-audit|leak-audit.mjs|none|discord
${E2E_EXTRA:-}
"

TMP="$(mktemp -d "${TMPDIR:-${TEMP:-/tmp}}/wos-e2e.XXXXXX")"
DBPATH="$TMP/db"
LOGS="${E2E_LOGS:-$TMP/logs}"
mkdir -p "$DBPATH" "$LOGS"
ENVFILE="$ROOT/.env.local"
ENVBAK="$ROOT/.env.local.e2e-bak"
MOVED=0
STARTED_MONGO=0
STARTED_APP=0
SERVER_PID=""

port_busy() { netstat -ano | tr -d '\r' | grep -qE ":$1[[:space:]].*LISTENING"; }
kill_port() {
  local pid
  for pid in $(netstat -ano | tr -d '\r' | grep -E ":$1[[:space:]].*LISTENING" | awk '{print $NF}' | sort -u); do
    taskkill //PID "$pid" //F //T >/dev/null 2>&1
  done
}
stop_server() {
  if [ "$STARTED_APP" = 1 ]; then
    # $! is a Git Bash pid: taskkill needs the Windows one (a raw $! can name an unrelated process and its tree).
    # Kill it by that pid while it still runs (so the pid cannot have been reused), then whatever holds the port.
    local wp
    wp=$(cat "/proc/$SERVER_PID/winpid" 2>/dev/null)
    [ -n "$wp" ] && taskkill //PID "$wp" //F //T >/dev/null 2>&1
    kill_port "$APORT"
    SERVER_PID=""
    STARTED_APP=0
  fi
}
cleanup() {
  trap - EXIT INT TERM HUP
  stop_server
  if [ "$STARTED_MONGO" = 1 ]; then kill_port "$MPORT"; sleep 1; fi
  if [ "$MOVED" = 1 ] && [ -e "$ENVBAK" ]; then mv "$ENVBAK" "$ENVFILE"; fi
  if [ -n "${E2E_LOGS:-}" ] && [ -e "$TMP/server.log" ]; then cp "$TMP/server.log" "$LOGS/server.log"; fi
  rm -rf "$TMP/db" "$TMP/shots" "$TMP/mongod.log" "$TMP/server.log" "$TMP/build.log" "$TMP/mail" "$TMP/state.json" "$TMP/team.json"
  if [ -z "${E2E_LOGS:-}" ]; then rm -rf "$LOGS"; fi
  rmdir "$TMP" 2>/dev/null
}
trap cleanup EXIT INT TERM HUP

# ---- refuse to run over anything that is not ours ----
for pt in $MPORT $APORT $DPORT; do
  if port_busy $pt; then echo "port $pt is already in use by something else; not touching it. Aborting."; exit 2; fi
done
if [ ! -x "$MONGOD" ] && [ ! -f "$MONGOD" ]; then echo "mongod not found at $MONGOD (set MONGOD=...)"; exit 2; fi

# ---- .env.local aside (it holds the real database URI) ----
if [ -e "$ENVBAK" ]; then
  if [ -e "$ENVFILE" ]; then echo "$ENVBAK and $ENVFILE both exist; resolve by hand. Aborting."; exit 2; fi
  mv "$ENVBAK" "$ENVFILE"   # leftover from an interrupted run
fi
if [ -e "$ENVFILE" ]; then mv "$ENVFILE" "$ENVBAK" && MOVED=1; fi

# ---- one shared environment for the app and every suite ----
export MONGODB_URI="mongodb://127.0.0.1:$MPORT/?replicaSet=rs0&directConnection=true"
export MONGODB_DB=workos_e2e
export BETTER_AUTH_SECRET=test-secret-e2e-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export APP_PASSWORD= SESSION_SECRET= MCP_TOKEN= MCP_ALLOW_URL_TOKEN= TRUST_PROXY=
# Better Auth's sign-in rate limit counts every suite's sign-ins from 127.0.0.1; the auth suite checks limits itself.
export AUTH_RATE_LIMIT=off
# Mail is written as JSON files here instead of being sent (lib/mail.ts); the auth suite reads reset links from it.
export MAIL_CAPTURE_DIR="$TMP/mail" E2E_STATE="$TMP/state.json"
export CRON_SECRET=testcron-e2e-0123456789abcdef
# The e2e owner runs the deployment (lib/operator.ts): health, Discord registration and servers, Usage.
export OPERATOR_EMAILS=e2e-owner@example.test
export APP_TZ=Asia/Kolkata
export APP_URL="http://localhost:$APORT" E2E_BASE="http://localhost:$APORT"
export E2E_MONGO_PORT=$MPORT E2E_DISCORD_PORT=$DPORT
export E2E_SHOTS="${E2E_SHOTS:-$TMP/shots}"
export DISCORD_BOT_TOKEN= DISCORD_PUBLIC_KEY= DISCORD_APPLICATION_ID= DISCORD_API_BASE=
export VAPID_PUBLIC_KEY= VAPID_PRIVATE_KEY= VAPID_SUBJECT=
export EMAIL_HOST= EMAIL_PORT= EMAIL_SECURE= EMAIL_USER= EMAIL_PASSWORD= EMAIL_FROM= EMAIL_FROM_NAME= OWNER_EMAIL=
mkdir -p "$MAIL_CAPTURE_DIR"
# A throwaway Ed25519 key pair: the discord suites sign interactions with it, the app checks them with the public half.
read -r E2E_DISCORD_PUB E2E_DISCORD_PRIV < <(node -e "const k=require('crypto').generateKeyPairSync('ed25519');console.log(k.publicKey.export({format:'der',type:'spki'}).subarray(12).toString('hex'),k.privateKey.export({format:'der',type:'pkcs8'}).toString('base64'))")
export E2E_DISCORD_PRIV

# ---- throwaway mongod, single-node replica set ----
echo "starting mongod on $MPORT (dbpath $DBPATH)"
nohup "$MONGOD" --replSet rs0 --port $MPORT --bind_ip 127.0.0.1 --dbpath "$(cygpath -w "$DBPATH" 2>/dev/null || echo "$DBPATH")" --logpath "$(cygpath -w "$TMP/mongod.log" 2>/dev/null || echo "$TMP/mongod.log")" >/dev/null 2>&1 &
STARTED_MONGO=1
ok=0
for i in $(seq 1 30); do
  if (cd "$HERE" && node rsinit.mjs >/dev/null 2>&1); then ok=1; break; fi
  sleep 1
done
[ "$ok" = 1 ] || { echo "mongod did not come up"; exit 2; }

# ---- build once ----
if [ "${SKIP_BUILD:-0}" = 1 ] && [ -f "$ROOT/.next/BUILD_ID" ]; then
  echo "SKIP_BUILD: reusing .next"
else
  echo "building (npm run build)"
  (cd "$ROOT" && npm run build) >"$TMP/build.log" 2>&1 || { echo "BUILD FAILED"; tail -40 "$TMP/build.log"; exit 3; }
fi

start_server() {
  if [ "$1" = discord ]; then
    export DISCORD_BOT_TOKEN=test-bot-token DISCORD_APPLICATION_ID=222222222222222222
    export DISCORD_PUBLIC_KEY="$E2E_DISCORD_PUB" DISCORD_API_BASE="http://127.0.0.1:$DPORT"
  else
    export DISCORD_BOT_TOKEN= DISCORD_APPLICATION_ID= DISCORD_PUBLIC_KEY= DISCORD_API_BASE=
  fi
  (cd "$ROOT" && exec npx next start -p $APORT) >"$TMP/server.log" 2>&1 &
  SERVER_PID=$!
  STARTED_APP=1
  local i code
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$APORT/login" || true)
    [ "$code" = 200 ] && return 0
    sleep 1
  done
  echo "server did not come up"; tail -20 "$TMP/server.log"; return 1
}
echo "starting app on $APORT"
MODE=plain
start_server plain || exit 3

# ---- run ----
WANT=" $* "
ROWS=""
FAILED_SUITES=0
while IFS='|' read -r name file profile mode; do
  [ -z "$name" ] && continue
  if [ $# -gt 0 ] && [[ "$WANT" != *" $name "* ]]; then continue; fi
  if [ "$mode" != "$MODE" ]; then stop_server; start_server "$mode" || exit 3; MODE=$mode; fi
  echo "--- $name (seed: $profile)"
  start=$SECONDS
  log="$LOGS/$name.log"
  if ! (cd "$HERE" && node seed.mjs "$profile" </dev/null) >"$log" 2>&1; then
    ROWS+="$name|-|-|$((SECONDS - start))|SEED FAILED"$'\n'; FAILED_SUITES=$((FAILED_SUITES + 1)); tail -5 "$log"; continue
  fi
  (cd "$HERE" && timeout 1200 node "$file" </dev/null) >>"$log" 2>&1
  rc=$?
  line=$(grep -E '^RESULT pass=' "$log" | tail -1)
  if [ -n "$line" ]; then
    p=$(echo "$line" | sed -E 's/.*pass=([0-9]+).*/\1/'); f=$(echo "$line" | sed -E 's/.*fail=([0-9]+).*/\1/')
  else
    p="-"; f="-"
  fi
  if [ "$rc" = 0 ] && [ "$f" = 0 ]; then res=PASS; else res=FAIL; FAILED_SUITES=$((FAILED_SUITES + 1)); fi
  ROWS+="$name|$p|$f|$((SECONDS - start))|$res"$'\n'
  if [ "$res" = FAIL ]; then grep -E '^(FAIL|FAILED:)' "$log" | head -15; [ "$p" = "-" ] && tail -8 "$log"; fi
done <<<"$SUITES"

echo
printf '%-22s %6s %6s %6s  %s\n' SUITE PASS FAIL SECS RESULT
printf '%s' "$ROWS" | while IFS='|' read -r n p f s r; do [ -n "$n" ] && printf '%-22s %6s %6s %6s  %s\n' "$n" "$p" "$f" "$s" "$r"; done
echo
if [ "$FAILED_SUITES" = 0 ]; then echo "ALL SUITES PASSED"; else echo "$FAILED_SUITES suite(s) failed"; fi
[ -n "${E2E_LOGS:-}" ] && echo "logs: $LOGS"
exit $((FAILED_SUITES > 0 ? 1 : 0))
