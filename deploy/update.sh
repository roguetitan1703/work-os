#!/usr/bin/env bash
# One command to bring the server to the latest master (docs/hosting.md section 7, "Updating"). Installed root-owned
# as /usr/local/sbin/work-os-update, next to work-os-deploy:
#
#   sudo work-os-update            deploy origin/master if it is not live yet
#
# It finds a build for that commit and hands it to work-os-deploy, which checks, installs, switches and rolls back on
# a failed start:
#   1. the "builds" release (GitHub Actions; work-os-deploy verifies its attestation), else
#   2. the "manual-builds" release (scripts/build-artifact.sh on a PC; checked against its .sha256, no attestation:
#      trusted as much as the GitHub account that uploaded it), else
#   3. none yet: it says so and changes nothing.
# It never re-installs the root-owned scripts in /usr/local/sbin: when deploy/ or scripts/cutover.sh changed, it says
# so, and you re-run those install lines (docs/hosting.md section 4) after reading the diff.
set -euo pipefail
APP_ROOT="${APP_ROOT:-/srv/work-os}"
BUILD_USER="${BUILD_USER:-workos-build}"
DEPLOY_CONF="${DEPLOY_CONF:-/etc/work-os/deploy.conf}"
DEPLOY="${DEPLOY:-/usr/local/sbin/work-os-deploy}"
REPO="$APP_ROOT/repo"

[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 2; }
GH_REPO="$(sed -n 's/^[[:space:]]*GITHUB_REPO=//p' "$DEPLOY_CONF" 2>/dev/null | tail -n 1 | tr -d '\r"'"'"' ' || true)"
[[ "$GH_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "set GITHUB_REPO=<owner>/<repo> in $DEPLOY_CONF" >&2; exit 2; }

sudo -H -u "$BUILD_USER" git -C "$REPO" fetch --prune --quiet origin
SHA="$(sudo -H -u "$BUILD_USER" git -C "$REPO" rev-parse --verify 'origin/master^{commit}')"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "could not read origin/master" >&2; exit 2; }
SHORT="${SHA:0:12}"
LIVE="$(cat "$APP_ROOT/current/REVISION" 2>/dev/null || true)"
if [ "$LIVE" = "$SHA" ]; then
  echo "already up to date: $SHORT is live"
  exit 0
fi
echo "live: ${LIVE:0:12}  latest master: $SHORT"
if [ -n "$LIVE" ] && sudo -H -u "$BUILD_USER" git -C "$REPO" cat-file -e "$LIVE^{commit}" 2>/dev/null; then
  CHANGED="$(sudo -H -u "$BUILD_USER" git -C "$REPO" diff --name-only "$LIVE" "$SHA" -- deploy scripts/cutover.sh || true)"
  if [ -n "$CHANGED" ]; then
    echo "  note: the server scripts changed in this update (re-install them after reading the diff, docs/hosting.md section 4):"
    echo "$CHANGED" | sed 's/^/    /'
  fi
fi

NAME="work-os-$SHORT.tar.gz"
url() { echo "https://github.com/$GH_REPO/releases/download/$1/$2"; }
exists() { curl -fsIL --proto '=https' --proto-redir '=https' --max-time 30 -o /dev/null "$1"; }

if exists "$(url builds "$NAME")"; then
  echo "  a GitHub Actions build exists: deploying it (attestation checked)"
  exec "$DEPLOY" "$SHA"
fi
if exists "$(url manual-builds "$NAME")"; then
  echo "  a PC build exists (manual-builds): downloading and checking it"
  TMPD="$(mktemp -d)"
  trap 'rm -rf "$TMPD"' EXIT
  for f in "$NAME" "$NAME.sha256"; do
    curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 --max-time 300 -o "$TMPD/$f" "$(url manual-builds "$f")" ||
      { echo "could not download $f from manual-builds" >&2; exit 1; }
  done
  (cd "$TMPD" && sha256sum --quiet -c "$NAME.sha256") || { echo "the download does not match its SHA-256: not deployed" >&2; exit 1; }
  "$DEPLOY" "$SHA" --artifact "$TMPD/$NAME"
  exit $?
fi
echo "no build for $SHORT yet: nothing changed."
echo "  GitHub Actions builds every push to master (when it runs); otherwise build on a PC and upload to manual-builds"
echo "  (scripts/build-artifact.sh, docs/hosting.md \"Building on a PC\"), then run this again."
exit 1
