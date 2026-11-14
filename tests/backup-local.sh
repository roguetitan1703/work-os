#!/usr/bin/env bash
# Stub test of deploy/backup.sh --nightly-local (no database, no Atlas): a fake mongodump writes a small archive.
# Checks: file name and mode 0600, rotation keeps exactly 7 (a failed dump keeps all), R2 configured = no dump,
# the old plaintext warning ignores nightly files. Run: bash tests/backup-local.sh
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/dir"
cat >"$T/bin/mongodump" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in --archive=*) out="${a#--archive=}";; esac; done
[ -n "${STUB_FAIL:-}" ] && exit 1
echo "stub dump" >"$out"
STUB
chmod +x "$T/bin/mongodump"
export PATH="$T/bin:$PATH" MONGODB_URI=mongodb://x BACKUP_DIR="$T/dir" BACKUP_MIN_FREE_KB=1
pass=0; fail=0
ok() { if [ "$2" = 1 ]; then pass=$((pass+1)); echo "PASS  $1"; else fail=$((fail+1)); echo "FAIL  $1"; fi; }
n() { ls "$T/dir" | grep -c 'workos-nightly-.*\.archive\.gz$'; }
# ten old nights
for i in 01 02 03 04 05 06 07 08 09 10; do touch -d "2026-01-$i" "$T/dir/workos-nightly-202601${i}T000000Z.archive.gz"; done
echo old >"$T/dir/workos-20250101T000000Z.archive.gz.age"
bash "$ROOT/deploy/backup.sh" --nightly-local >"$T/out" 2>&1; rc=$?
ok "run succeeds" $([ $rc = 0 ] && echo 1 || echo 0)
ok "exactly 7 nightly archives kept" $([ "$(n)" = 7 ] && echo 1 || echo 0)
newest="$(ls -1t "$T/dir"/workos-nightly-*.archive.gz | head -1)"
# NTFS (Git Bash) has no real modes: there only the content is checked; on Linux the mode must be 0600.
mode_ok=1; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) [ "$(stat -c %a "$newest")" = 600 ] || mode_ok=0 ;; esac
ok "newest is the new dump, mode 0600 (Linux only)" $(grep -q 'stub dump' "$newest" && [ $mode_ok = 1 ] && echo 1 || echo 0)
ok "the R2-style .age copy is untouched" $([ -e "$T/dir/workos-20250101T000000Z.archive.gz.age" ] && echo 1 || echo 0)
ok "no plaintext-age warning for nightly files" $(grep -q 'warning' "$T/out" && echo 0 || echo 1)
ok "no .partial left" $([ -z "$(ls "$T/dir" | grep partial)" ] && echo 1 || echo 0)
before="$(n)"; STUB_FAIL=1 bash "$ROOT/deploy/backup.sh" --nightly-local >/dev/null 2>&1; rc=$?
ok "a failed dump exits non-zero and removes nothing" $([ $rc != 0 ] && [ "$(n)" = "$before" ] && echo 1 || echo 0)
BACKUP_S3_URI=s3://b/p BACKUP_AGE_RECIPIENT=age1x bash "$ROOT/deploy/backup.sh" --nightly-local >"$T/out2" 2>&1; rc=$?
ok "R2 configured: exits 0 and dumps nothing" $([ $rc = 0 ] && grep -q 'R2 backup is configured' "$T/out2" && [ "$(n)" = "$before" ] && echo 1 || echo 0)
BACKUP_NIGHTLY_KEEP=3 bash "$ROOT/deploy/backup.sh" --nightly-local >/dev/null 2>&1
ok "BACKUP_NIGHTLY_KEEP=3 keeps 3" $([ "$(n)" = 3 ] && echo 1 || echo 0)
bash "$ROOT/deploy/backup.sh" --bogus >/dev/null 2>&1; ok "unknown flag refused" $([ $? = 2 ] && echo 1 || echo 0)
echo "RESULT pass=$pass fail=$fail"; [ "$fail" = 0 ]
