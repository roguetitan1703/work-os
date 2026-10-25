#!/usr/bin/env bash
# Builds the server's .next on a PC, for when GitHub Actions cannot (docs/hosting.md section 7, "Building on a PC").
# Runs in WSL (Ubuntu) as root, so the build can sit at the server's release path: Next links .next/node_modules to
# the node_modules of the folder it was built in, and on the server that folder is /srv/work-os/releases/<commit>.
# Makes the same tarball as .github/workflows/server-build.yml; the server deploys it with
#   sudo work-os-deploy <commit> --artifact work-os-<commit12>.tar.gz
# A build made here is x86_64: that is fine, .next holds no native code (deploy.sh checks), and the server installs
# its own native packages with npm ci.
#
#   sudo bash scripts/build-artifact.sh [<ref>] [<out dir>]     ref: default origin/master; out: default the current dir
set -euo pipefail
REF="${1:-origin/master}"
OUT="$(cd "${2:-.}" && pwd)"
REPO_URL="https://github.com/roguetitan1703/work-os.git"
NODE_V=v22.23.4
NODE_SHA=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce   # node-v22.23.4-linux-x64.tar.xz
NODE_DIR=/opt/work-os-build/node

[ "$(id -u)" = 0 ] || { echo "run with sudo (it builds under /srv/work-os/releases)" >&2; exit 2; }
[ "$(uname -m)" = x86_64 ] || { echo "this script is for an x64 PC (WSL); on arm64 use the server's --build-here" >&2; exit 2; }

# Node 22, the server's version, for this build only (never the system's node).
if [ "$("$NODE_DIR/bin/node" -v 2>/dev/null || true)" != "$NODE_V" ]; then
  T="$(mktemp -d)"
  F="node-$NODE_V-linux-x64.tar.xz"
  curl -fsSL --proto '=https' -o "$T/$F" "https://nodejs.org/dist/$NODE_V/$F"
  echo "$NODE_SHA  $T/$F" | sha256sum -c --quiet
  install -d /opt/work-os-build
  tar -xJf "$T/$F" -C /opt/work-os-build --no-same-owner
  ln -sfn "/opt/work-os-build/node-$NODE_V-linux-x64" "$NODE_DIR"
  rm -rf "$T"
fi
export PATH="$NODE_DIR/bin:$PATH"

# The commit, from a clean clone of the public repo (never a working copy with local changes).
SRC=/var/tmp/work-os-src
[ -d "$SRC/.git" ] || git clone -q "$REPO_URL" "$SRC"
git -C "$SRC" fetch -q --prune origin
SHA="$(git -C "$SRC" rev-parse --verify "$REF^{commit}")"
SHORT="${SHA:0:12}"
REL="/srv/work-os/releases/$SHORT"
echo "building $REF = $SHORT"

rm -rf "$REL"
install -d "$REL"
git -C "$SRC" archive "$SHA" | tar -x -C "$REL"
cd "$REL"
npm ci --no-audit --no-fund --loglevel=error
NEXT_TELEMETRY_DISABLED=1 npm run build
echo "$SHA" > REVISION
uname -m > BUILD_ARCH
node -v > BUILD_NODE
# What the server's check will want: no native code inside .next.
if [ -n "$(find .next -type f \( -name '*.node' -o -name '*.so' \) -print -quit)" ]; then
  echo ".next holds native code: this build only runs on $(uname -m); build on arm64 instead" >&2; exit 1
fi
NAME="work-os-$SHORT.tar.gz"
tar -czf "$OUT/$NAME" --exclude=.next/cache .next REVISION BUILD_ARCH BUILD_NODE
(cd "$OUT" && sha256sum "$NAME" > "$NAME.sha256")
cd / && rm -rf "$REL"
ls -l "$OUT/$NAME" "$OUT/$NAME.sha256"
echo "done: copy both files to the server, check the sha256 there, then: sudo work-os-deploy $SHORT --artifact $NAME"
