#!/usr/bin/env bash
# After the cut-over, once Om has signed in and checked his data: removes what the move left behind on the server and
# in the cluster (docs/hosting.md section 10). Installed root-owned as /usr/local/sbin/work-os-cleanup-cutover.
#
#   sudo work-os-cleanup-cutover            list what would go (nothing changes)
#   sudo work-os-cleanup-cutover --apply    delete it
#
# Files: the env file's backup copies (they hold secrets), the plaintext database dumps in /var/backups/work-os, the
# downloaded build tarballs in /tmp. Databases in the app's cluster: the cut-over rehearsal copies
# (<db>_cutover_<time>) and the pre-move database "workos" when the app now uses another one. Never the app's own
# database (MONGODB_DB), and nothing in any other cluster (the Vercel-era cluster is left as it is).
set -euo pipefail
APPLY=0
[ "${1:-}" = --apply ] && APPLY=1
ENV_FILE="${ENV_FILE:-/etc/work-os/env}"
APP_DIR="${APP_DIR:-/srv/work-os/current}"
NODE="${NODE:-/opt/work-os/node/bin/node}"
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 2; }
# shellcheck source=/dev/null
. /usr/local/sbin/work-os-env.sh
load_env "$ENV_FILE"
LIVE_DB="${MONGODB_DB:-workos}"
[ $APPLY = 1 ] && echo "DELETING:" || echo "would delete (add --apply to do it):"

shopt -s nullglob
files=(/etc/work-os/env.bak-* /var/backups/work-os/*.archive.gz /tmp/work-os-*.tar.gz)
for f in "${files[@]}"; do
  echo "  file  $f ($(du -h "$f" | cut -f1))"
  [ $APPLY = 1 ] && rm -f -- "$f"
done
[ ${#files[@]} -gt 0 ] || echo "  no leftover files"

# Databases: listed and dropped by node with the app's own driver; the URI never leaves the environment.
cd "$APP_DIR"
APPLY=$APPLY LIVE_DB="$LIVE_DB" sudo -u workos --preserve-env=MONGODB_URI,APPLY,LIVE_DB "$NODE" -e '
const { MongoClient } = require("mongodb");
(async () => {
  const c = await MongoClient.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  const live = process.env.LIVE_DB;
  const names = (await c.db().admin().listDatabases({ nameOnly: true })).databases.map(d => d.name);
  if (!names.includes(live)) { console.error(`  the app database ${live} is not there: stopping, nothing dropped`); process.exit(1); }
  const n = await c.db(live).collection("tasks").estimatedDocumentCount();
  console.log(`  keep  database ${live} (${n} tasks): the app uses it`);
  const drop = names.filter(d => d !== live && (/_cutover_\d{12}$/.test(d) || (d === "workos" && live !== "workos")));
  for (const d of drop) {
    console.log(`  db    ${d}`);
    if (process.env.APPLY === "1") await c.db(d).dropDatabase();
  }
  if (!drop.length) console.log("  no leftover databases");
  await c.close();
})().catch(e => { console.error("  database step failed:", e.message); process.exit(1); });
'
[ $APPLY = 1 ] && echo "done. Still by hand: Atlas › the Vercel-era project › Database Access › delete the user workos-move." || true
