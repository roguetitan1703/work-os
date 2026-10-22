#!/usr/bin/env bash
# Deploys Work OS on the server (docs/hosting.md "Deploying"). Each release is built in its own folder while the
# current one keeps serving; then the "current" symlink moves, the app restarts and /api/live is checked. A release
# that does not come up is rolled back at once.
#
#   sudo /srv/work-os/repo/deploy/deploy.sh                 deploy origin/master
#   sudo /srv/work-os/repo/deploy/deploy.sh <ref>           a branch, tag or commit
#   sudo /srv/work-os/repo/deploy/deploy.sh --rollback      back to the previous release (code only, see the doc)
#
# Layout: $APP_ROOT/repo (git clone), $APP_ROOT/releases/<commit>, $APP_ROOT/current and $APP_ROOT/previous (symlinks).
# The build does not read /etc/work-os/env: nothing in it is needed at build time, so no secret enters the build.
set -euo pipefail
APP_ROOT="${APP_ROOT:-/srv/work-os}"
APP_USER="${APP_USER:-workos}"
SERVICE="${SERVICE:-work-os}"
PORT="${PORT:-3000}"
KEEP="${KEEP:-4}"
REPO="$APP_ROOT/repo"
RELEASES="$APP_ROOT/releases"

as_app() { if [ "$(id -un)" = "$APP_USER" ]; then "$@"; else sudo -H -u "$APP_USER" "$@"; fi; }
live() {
  local i
  for i in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/live" || true)" = 200 ] &&
      [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/login" || true)" = 200 ] && return 0
    sleep 1
  done
  return 1
}
switch_to() { ln -sfn "$1" "$APP_ROOT/current.new" && mv -Tf "$APP_ROOT/current.new" "$APP_ROOT/current"; }

if [ "${1:-}" = "--rollback" ]; then
  PREV="$(readlink -f "$APP_ROOT/previous" 2>/dev/null || true)"
  CUR="$(readlink -f "$APP_ROOT/current")"
  [ -n "$PREV" ] && [ -d "$PREV" ] && [ "$PREV" != "$CUR" ] || { echo "no previous release to go back to" >&2; exit 2; }
  echo "rolling back: $(basename "$CUR") -> $(basename "$PREV")"
  switch_to "$PREV"
  ln -sfn "$CUR" "$APP_ROOT/previous"
  systemctl restart "$SERVICE"
  live && echo "rolled back; app is up" || { echo "the previous release did not come up either: journalctl -u $SERVICE" >&2; exit 1; }
  exit 0
fi

REF="${1:-origin/master}"
as_app git -C "$REPO" fetch --prune --quiet origin
SHA="$(as_app git -C "$REPO" rev-parse --verify "$REF^{commit}")"
REL="$RELEASES/${SHA:0:12}"
echo "deploying $REF = ${SHA:0:12}"

if [ -f "$REL/.next/BUILD_ID" ]; then
  echo "  already built: $REL"
else
  rm -rf "$REL"
  as_app mkdir -p "$REL"
  as_app bash -c "git -C '$REPO' archive '$SHA' | tar -x -C '$REL'"
  echo "$SHA" | as_app tee "$REL/REVISION" >/dev/null
  echo "  npm ci"
  as_app bash -c "cd '$REL' && npm ci --no-audit --no-fund --loglevel=error"
  echo "  build"
  as_app env NEXT_TELEMETRY_DISABLED=1 NEXT_BUILD_CPUS="${NEXT_BUILD_CPUS:-1}" \
    NODE_OPTIONS="--max-old-space-size=${BUILD_MEMORY_MB:-1536}" bash -c "cd '$REL' && npm run build >'$REL/build.log' 2>&1" ||
    { echo "BUILD FAILED (nothing changed; the app still runs the old release): tail $REL/build.log" >&2; exit 1; }
fi

OLD="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"
if [ "$OLD" = "$REL" ]; then echo "  already live"; exit 0; fi
switch_to "$REL"
[ -n "$OLD" ] && ln -sfn "$OLD" "$APP_ROOT/previous"
systemctl restart "$SERVICE"
if live; then
  echo "live: ${SHA:0:12}"
else
  echo "the new release did not come up: rolling back" >&2
  if [ -n "$OLD" ]; then
    switch_to "$OLD"
    systemctl restart "$SERVICE"
    live && echo "back on $(basename "$OLD")" >&2
  fi
  exit 1
fi

# Keep the newest $KEEP releases, never current or previous.
KEEP_CUR="$(readlink -f "$APP_ROOT/current")"
KEEP_PREV="$(readlink -f "$APP_ROOT/previous" 2>/dev/null || true)"
ls -1dt "$RELEASES"/*/ 2>/dev/null | sed 's:/$::' | tail -n +"$((KEEP + 1))" | while read -r old; do
  [ "$old" = "$KEEP_CUR" ] || [ "$old" = "$KEEP_PREV" ] || { rm -rf "$old"; echo "  removed old release $(basename "$old")"; }
done
