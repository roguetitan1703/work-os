#!/usr/bin/env bash
# Deploys Work OS on the server (docs/hosting.md "Deploying"). Installed root-owned as /usr/local/sbin/work-os-deploy
# (never run from a release: a release is written by the build user and by npm install scripts).
#
#   sudo work-os-deploy                 deploy origin/master
#   sudo work-os-deploy <ref>           a branch, tag or commit
#   sudo work-os-deploy --rollback      back to the previous release (code only, see the doc)
#
# Each release is built in its own folder by the build user (workos-build, who cannot read /etc/work-os/env) while the
# current one keeps serving; then the "current" symlink moves, the app (user workos) restarts and /api/live is checked.
# A release that does not come up is rolled back at once. One deploy at a time (a lock).
#
# Layout: $APP_ROOT/repo (git clone, build user), $APP_ROOT/releases/<commit> (build user; only .next/cache belongs to
# the app user), $APP_ROOT/current and $APP_ROOT/previous (root's symlinks).
set -euo pipefail
APP_ROOT="${APP_ROOT:-/srv/work-os}"
APP_USER="${APP_USER:-workos}"
BUILD_USER="${BUILD_USER:-workos-build}"
SERVICE="${SERVICE:-work-os}"
PORT="${PORT:-3000}"
KEEP="${KEEP:-4}"
REPO="$APP_ROOT/repo"
RELEASES="$APP_ROOT/releases"

[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 2; }
exec 9>/run/work-os-deploy.lock
flock -n 9 || { echo "another deploy is running" >&2; exit 2; }

as_build() { sudo -H -u "$BUILD_USER" "$@"; }
live() {
  local i
  for i in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/live" || true)" = 200 ] &&
      [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/login" || true)" = 200 ] && return 0
    sleep 1
  done
  return 1
}
link() { ln -sfn "$2" "$APP_ROOT/$1.new" && mv -Tf "$APP_ROOT/$1.new" "$APP_ROOT/$1"; }
target() { readlink -f "$APP_ROOT/$1" 2>/dev/null || true; }
down() {
  echo "FAILED: the app is DOWN. Neither the new nor the previous release answers on /api/live." >&2
  echo "        journalctl -u $SERVICE -n 100; releases: ls -t $RELEASES" >&2
  exit 1
}

if [ "${1:-}" = "--rollback" ]; then
  PREV="$(target previous)"
  CUR="$(target current)"
  [ -n "$PREV" ] && [ -d "$PREV" ] && [ "$PREV" != "$CUR" ] || { echo "no previous release to go back to" >&2; exit 2; }
  echo "rolling back: $(basename "$CUR") -> $(basename "$PREV")"
  link current "$PREV"
  link previous "$CUR"
  systemctl restart "$SERVICE"
  if live; then echo "rolled back; app is up on $(basename "$PREV")"; exit 0; fi
  echo "$(basename "$PREV") did not come up: going back to $(basename "$CUR")" >&2
  link current "$CUR"
  link previous "$PREV"
  systemctl restart "$SERVICE"
  live && { echo "FAILED rollback: still on $(basename "$CUR"), which is up" >&2; exit 1; }
  down
fi

REF="${1:-origin/master}"
as_build git -C "$REPO" fetch --prune --quiet origin
SHA="$(as_build git -C "$REPO" rev-parse --verify "$REF^{commit}")"
REL="$RELEASES/${SHA:0:12}"
echo "deploying $REF = ${SHA:0:12}"

if [ -f "$REL/.next/BUILD_ID" ]; then
  echo "  already built: $REL"
else
  rm -rf "$REL"
  as_build mkdir -p "$REL"
  as_build bash -c "git -C '$REPO' archive '$SHA' | tar -x -C '$REL'"
  echo "$SHA" | as_build tee "$REL/REVISION" >/dev/null
  echo "  npm ci"
  as_build bash -c "cd '$REL' && npm ci --no-audit --no-fund --loglevel=error"
  echo "  build"
  as_build env NEXT_TELEMETRY_DISABLED=1 NEXT_BUILD_CPUS="${NEXT_BUILD_CPUS:-1}" \
    NODE_OPTIONS="--max-old-space-size=${BUILD_MEMORY_MB:-1536}" bash -c "cd '$REL' && npm run build >'$REL/build.log' 2>&1" ||
    { echo "BUILD FAILED (nothing changed; the app still runs the old release): tail $REL/build.log" >&2; exit 1; }
  # The only place the app writes: its own cache (work-os.service ReadWritePaths).
  mkdir -p "$REL/.next/cache"
  chown -R "$APP_USER:$APP_USER" "$REL/.next/cache"
fi

OLD="$(target current)"
OLD_PREV="$(target previous)"
if [ "$OLD" = "$REL" ]; then echo "  already live"; exit 0; fi
link current "$REL"
[ -n "$OLD" ] && link previous "$OLD"
systemctl restart "$SERVICE"
if live; then
  echo "live: ${SHA:0:12}"
else
  echo "the new release ${SHA:0:12} did not come up (journalctl -u $SERVICE): rolling back" >&2
  [ -n "$OLD" ] || down
  link current "$OLD"
  # previous stays what it was before this deploy, so --rollback still means "the release before the live one".
  if [ -n "$OLD_PREV" ]; then link previous "$OLD_PREV"; else rm -f "$APP_ROOT/previous"; fi
  systemctl restart "$SERVICE"
  live || down
  echo "FAILED deploy: back on $(basename "$OLD"), which is up" >&2
  exit 1
fi

# Keep the newest $KEEP releases, never current or previous.
KEEP_CUR="$(target current)"
KEEP_PREV="$(target previous)"
ls -1dt "$RELEASES"/*/ 2>/dev/null | sed 's:/$::' | tail -n +"$((KEEP + 1))" | while read -r old; do
  [ "$old" = "$KEEP_CUR" ] || [ "$old" = "$KEEP_PREV" ] || { rm -rf "$old"; echo "  removed old release $(basename "$old")"; }
done
