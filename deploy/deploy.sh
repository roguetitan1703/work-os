#!/usr/bin/env bash
# Deploys Work OS on the server (docs/hosting.md "Deploying"). Installed root-owned as /usr/local/sbin/work-os-deploy
# (never run from a release: a release is written by the build user and by npm install scripts).
#
#   sudo work-os-deploy                      deploy origin/master
#   sudo work-os-deploy <commit>             an older master commit (its build must still be published)
#   sudo work-os-deploy <ref> --artifact <work-os-<commit>.tar.gz>   a build made on another arm64 machine
#   sudo work-os-deploy <ref> --build-here   build on this box instead (last resort; needs swap)
#   sudo work-os-deploy --rollback           back to the previous release (code only, see the doc)
#
# The box does not build by default: it has 2 GB, shared with other apps, and a Next build wants more. The "Server
# build" workflow (.github/workflows/server-build.yml, an arm64 GitHub runner) publishes work-os-<commit>.tar.gz (the
# .next folder), its .sha256 and its build provenance attestation (.sigstore.json) on the repo's "builds" release.
# This script downloads them for the commit it deploys and, before unpacking anything, checks the SHA-256 and the
# attestation: made by that workflow in this repo, from that commit, on master, on a GitHub-hosted runner. Then it
# checks the contents (only the build, links only into the release), the commit, CPU type and Node version, gives the
# build fresh secrets (work-os-fresh-secrets.mjs: the published ones are public), and runs `npm ci --omit=dev`, so the
# native modules (Next's SWC, sharp) are this machine's. A release counts as prepared only when all of that passed.
#
# Each release is prepared in its own folder by the build user (workos-build, who cannot read /etc/work-os/env) while
# the current one keeps serving; then the "current" symlink moves, the app (user workos) restarts and /api/live is
# checked. A release that does not come up is rolled back at once. One deploy at a time (a lock).
#
# Layout: $APP_ROOT/repo (git clone, build user), $APP_ROOT/releases/<commit> (build user; only .next/cache belongs to
# the app user), $APP_ROOT/current and $APP_ROOT/previous (root's symlinks). /etc/work-os/deploy.conf (root's, made at
# install time) names the GitHub repo the builds come from: GITHUB_REPO=<owner>/<repo>.
#
# Environment (all optional): PORT (else WORK_OS_PORT from /etc/work-os/env, else 3000), KEEP (releases kept, 4),
# BUILD_MEMORY_MAX (memory cap of npm ci and a --build-here build, 1200M; "off" for none), BUILD_SWAP_MAX (2G), and for
# --build-here NEXT_BUILD_CPUS (1), BUILD_MEMORY_MB (1536).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="${APP_ROOT:-/srv/work-os}"
APP_USER="${APP_USER:-workos}"
BUILD_USER="${BUILD_USER:-workos-build}"
SERVICE="${SERVICE:-work-os}"
ENV_FILE="${ENV_FILE:-/etc/work-os/env}"
DEPLOY_CONF="${DEPLOY_CONF:-/etc/work-os/deploy.conf}"
WORKFLOW=.github/workflows/server-build.yml
BUILD_BRANCH=master
# The app's port: WORK_OS_PORT from the env file (only that line is read), else 3000 (deploy/systemd/work-os.service).
PORT="${PORT:-$(sed -n 's/^[[:space:]]*WORK_OS_PORT=//p' "$ENV_FILE" 2>/dev/null | tail -n 1 | tr -cd '0-9' || true)}"
PORT="${PORT:-3000}"
KEEP="${KEEP:-4}"
REPO="$APP_ROOT/repo"
RELEASES="$APP_ROOT/releases"
# Installed: work-os-fresh-secrets.mjs beside this script in /usr/local/sbin; in the repo: deploy/fresh-build-secrets.mjs.
FRESH="$HERE/work-os-fresh-secrets.mjs"
[ -f "$FRESH" ] || FRESH="$HERE/fresh-build-secrets.mjs"

MODE=prebuilt
REF=""
ARTIFACT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rollback) MODE=rollback; shift ;;
    --build-here) MODE=here; shift ;;
    --artifact) MODE=artifact; ARTIFACT="${2:-}"; shift; [ $# -gt 0 ] && shift ;;
    -h | --help) sed -n '2,30p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    *) [ -z "$REF" ] || { echo "one ref only" >&2; exit 2; }; REF="$1"; shift ;;
  esac
done
[ "$MODE" != artifact ] || [ -f "$ARTIFACT" ] || { echo "--artifact: no such file: $ARTIFACT" >&2; exit 2; }

[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 2; }
exec 9>/run/work-os-deploy.lock
flock -n 9 || { echo "another deploy is running" >&2; exit 2; }

as_build() { sudo -H -u "$BUILD_USER" "$@"; }
# The box is shared with other apps: npm ci (and a --build-here build) run at low priority in their own memory cgroup,
# so running short of memory swaps or stops only that step (the old release keeps serving) instead of pushing the
# other apps out. BUILD_MEMORY_MAX=off turns the cap off. Needs systemd and cgroup v2 (Ubuntu 22.04+); else no cap.
as_build_capped() {
  if [ "${BUILD_MEMORY_MAX:-1200M}" != off ] && command -v systemd-run >/dev/null && [ -f /sys/fs/cgroup/cgroup.controllers ]; then
    systemd-run --scope --quiet -p MemoryMax="${BUILD_MEMORY_MAX:-1200M}" -p MemorySwapMax="${BUILD_SWAP_MAX:-2G}" \
      nice -n 10 sudo -H -u "$BUILD_USER" "$@"
  else
    nice -n 10 sudo -H -u "$BUILD_USER" "$@"
  fi
}
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

if [ "$MODE" = rollback ]; then
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

if ! grep -qE '^[[:space:]]*NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=.+' "$ENV_FILE" 2>/dev/null; then
  echo "  note: NEXT_SERVER_ACTIONS_ENCRYPTION_KEY is not set in $ENV_FILE: each release gets its own key, so a page" >&2
  echo "        open across a deploy fails its next server action once (docs/hosting.md \"The build's secrets\")" >&2
fi

REF="${REF:-origin/master}"
as_build git -C "$REPO" fetch --prune --quiet origin
SHA="$(as_build git -C "$REPO" rev-parse --verify "$REF^{commit}")"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "not a commit: $REF" >&2; exit 2; }
REL="$RELEASES/${SHA:0:12}"
NAME="work-os-${SHA:0:12}.tar.gz"
echo "deploying $REF = ${SHA:0:12}"

# Root's own scratch folder (mktemp -d is 0700): downloads and --artifact copies are checked here, never in place.
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

# Which GitHub repo the builds come from: fixed at install time in a root-owned file, never taken from the build
# user's git remote (the build user could change that).
github_repo() {
  local r
  r="$(sed -n 's/^[[:space:]]*GITHUB_REPO=//p' "$DEPLOY_CONF" 2>/dev/null | tail -n 1 | tr -d '\r"'"'"' ' || true)"
  [[ "$r" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "set GITHUB_REPO=<owner>/<repo> in $DEPLOY_CONF (docs/hosting.md section 4)" >&2; return 1; }
  [ "$(stat -c '%u' "$DEPLOY_CONF")" = 0 ] && [ -z "$(find "$DEPLOY_CONF" -perm /022)" ] ||
    { echo "$DEPLOY_CONF must belong to root and be writable by root only" >&2; return 1; }
  echo "$r"
}

# The build's provenance: signed by GitHub for this repo's Server build workflow, from commit $SHA on master, on a
# GitHub-hosted runner. --bundle verifies offline against the downloaded attestation (no GitHub login needed).
verify_attestation() {
  local f="$1" bundle="$2" repo="$3"
  command -v gh >/dev/null || { echo "  gh (GitHub CLI) is not installed: cannot check the build's attestation (docs/hosting.md section 2)" >&2; return 1; }
  GH_NO_UPDATE_NOTIFIER=1 GH_PROMPT_DISABLED=1 gh attestation verify "$f" --bundle "$bundle" --repo "$repo" \
    --signer-workflow "$repo/$WORKFLOW" --source-digest "$SHA" --source-ref "refs/heads/$BUILD_BRANCH" \
    --deny-self-hosted-runners >/dev/null ||
    { echo "  the attestation does not match: not built by $repo's $WORKFLOW from ${SHA:0:12} on $BUILD_BRANCH" >&2; return 1; }
}

# Unpacks a checked build tarball ($1, root's copy) into $REL as the build user, after checking that it holds only the
# build (.next and three small files) and that it is this commit's build for this machine's architecture and Node.
# Links: Next puts symlinks in .next/node_modules to the packages it keeps external (mongodb, @blocknote/*), pointing
# into the node_modules of the folder it was built in. That is why the build is made in the release's own path
# (/srv/work-os/releases/<commit>): those are the only links allowed, and only into this release's node_modules.
unpack_build() {
  local f="$1" bad want have l to
  bad="$(tar -tzf "$f" | grep -vE '^(\./)?(\.next(/.*)?|REVISION|BUILD_ARCH|BUILD_NODE)?$' || true)"
  [ -z "$bad" ] || { echo "  it holds more than a build (e.g. $(echo "$bad" | head -n 1))" >&2; return 1; }
  if tar -tzf "$f" | grep -qE '(^|/)\.\.(/|$)'; then echo "  it holds a path with .." >&2; return 1; fi
  if tar -tzvf "$f" | grep -qE '^h'; then echo "  it holds hard links" >&2; return 1; fi
  # GNU tar makes symlinks last, so nothing in the archive is written through one. The build user reads root's copy
  # through stdin only.
  as_build tar -xzf - -C "$REL" --no-same-owner --no-same-permissions <"$f"
  while IFS= read -r -d '' l; do
    to="$(readlink -m "$l")"
    case "$l" in "$REL/.next/node_modules/"*) ;; *) echo "  it holds a link outside .next/node_modules: ${l#"$REL"/}" >&2; return 1 ;; esac
    case "$to" in "$REL/node_modules/"*) ;; *) echo "  ${l#"$REL"/} points outside this release (${to}); was it built in $REL?" >&2; return 1 ;; esac
  done < <(find "$REL" -type l -print0)
  [ "$(cat "$REL/REVISION" 2>/dev/null)" = "$SHA" ] || { echo "  it is the build of another commit" >&2; return 1; }
  [ "$(cat "$REL/BUILD_ARCH" 2>/dev/null)" = "$(uname -m)" ] ||
    { echo "  it was built for $(cat "$REL/BUILD_ARCH" 2>/dev/null || echo '?'); this machine is $(uname -m)" >&2; return 1; }
  want="$(sed -E 's/^v([0-9]+).*/\1/' "$REL/BUILD_NODE" 2>/dev/null || true)"
  have="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
  [ -z "$want" ] || [ "$want" = "$have" ] || { echo "  it was built with Node $want; this machine runs Node $have" >&2; return 1; }
  [ -f "$REL/.next/BUILD_ID" ] || { echo "  it has no .next/BUILD_ID" >&2; return 1; }
}

fail_prepare() { rm -rf "$REL"; echo "$1 (nothing changed; the app still runs the old release)" >&2; exit 1; }

# .prepared is written last, only when every step below passed; anything else in the folder is started over.
if [ -f "$REL/.prepared" ]; then
  echo "  already prepared: $REL"
else
  rm -rf "$REL"
  as_build mkdir -p "$REL"
  as_build bash -c "git -C '$REPO' archive '$SHA' | tar -x -C '$REL'"
  echo "$SHA" | as_build tee "$REL/REVISION" >/dev/null
  if [ "$MODE" = here ]; then
    uname -m | as_build tee "$REL/BUILD_ARCH" >/dev/null
    echo "  npm ci"
    as_build_capped bash -c "cd '$REL' && npm ci --no-audit --no-fund --loglevel=error" || fail_prepare "npm ci FAILED"
    echo "  build (on this box: slow, and it needs swap; docs/hosting.md \"The build\")"
    as_build_capped env NEXT_TELEMETRY_DISABLED=1 NEXT_BUILD_CPUS="${NEXT_BUILD_CPUS:-1}" \
      NODE_OPTIONS="--max-old-space-size=${BUILD_MEMORY_MB:-1536}" bash -c "cd '$REL' && npm run build >'$REL/build.log' 2>&1" ||
      { echo "BUILD FAILED (nothing changed; the app still runs the old release): tail $REL/build.log" >&2; exit 1; }
  else
    COPY="$TMPD/$NAME"
    if [ "$MODE" = prebuilt ]; then
      GH_REPO_NAME="$(github_repo)" || fail_prepare "NO SOURCE FOR BUILDS"
      BASE="https://github.com/$GH_REPO_NAME/releases/download/builds"
      echo "  download $NAME"
      for f in "$NAME" "$NAME.sha256" "$NAME.sigstore.json"; do
        if ! curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 --max-time 300 -o "$TMPD/$f" "$BASE/$f"; then
          echo "NO BUILD for ${SHA:0:12} at $BASE ($f missing). Its \"Server build\" run on GitHub Actions may not have" >&2
          echo "finished, or failed. Or deploy a build made elsewhere: --artifact <file>; last resort: --build-here." >&2
          fail_prepare "NO BUILD"
        fi
      done
      (cd "$TMPD" && sha256sum --quiet -c "$NAME.sha256") || fail_prepare "the download does not match its SHA-256"
      echo "  verify the attestation"
      verify_attestation "$COPY" "$TMPD/$NAME.sigstore.json" "$GH_REPO_NAME" || fail_prepare "BUILD NOT TRUSTED"
    else
      # A build you made and copied here: checked from root's own copy, never from where it lies.
      install -m 600 "$ARTIFACT" "$COPY"
      if [ -f "$ARTIFACT.sigstore.json" ]; then
        install -m 600 "$ARTIFACT.sigstore.json" "$COPY.sigstore.json"
        GH_REPO_NAME="$(github_repo)" || fail_prepare "NO SOURCE FOR BUILDS"
        verify_attestation "$COPY" "$COPY.sigstore.json" "$GH_REPO_NAME" || fail_prepare "BUILD NOT TRUSTED"
      else
        echo "  $ARTIFACT has no attestation beside it: deploying it on your word (a build you made)"
      fi
    fi
    echo "  unpack the build"
    unpack_build "$COPY" || fail_prepare "BUILD NOT USABLE"
    echo "  fresh secrets for this build"
    as_build node "$FRESH" "$REL/.next" || fail_prepare "could not replace the build's published secrets"
    # Runtime packages only, installed here so their native parts (Next's SWC, sharp) are this machine's.
    echo "  npm ci --omit=dev"
    as_build_capped bash -c "cd '$REL' && npm ci --omit=dev --no-audit --no-fund --loglevel=error" || fail_prepare "npm ci FAILED"
  fi
  as_build touch "$REL/.prepared"
fi
# The only place the app writes: its own cache (work-os.service ReadWritePaths).
mkdir -p "$REL/.next/cache"
chown -R "$APP_USER:$APP_USER" "$REL/.next/cache"

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
