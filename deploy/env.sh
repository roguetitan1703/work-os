# Sourced by the deploy scripts (installed as /usr/local/sbin/work-os-env.sh): load_env <file> exports every KEY=value line of a systemd EnvironmentFile without
# running it through the shell (values may hold $, spaces or quotes). Surrounding single or double quotes are removed.
# Never prints a value.
load_env() {
  local file="$1" line k v
  [ -r "$file" ] || { echo "cannot read $file (run with sudo?)" >&2; return 2; }
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    k="${BASH_REMATCH[1]}"
    v="${BASH_REMATCH[2]}"
    if [[ "$v" =~ ^\"(.*)\"$ ]] || [[ "$v" =~ ^\'(.*)\'$ ]]; then v="${BASH_REMATCH[1]}"; fi
    export "$k=$v"
  done <"$file"
}

# check_vars NAME...: prints "NAME: set" or "NAME: MISSING" (never the value); returns 1 if any is missing.
check_vars() {
  local n bad=0
  for n in "$@"; do
    if [ -n "${!n:-}" ]; then echo "  $n: set"; else echo "  $n: MISSING"; bad=1; fi
  done
  return $bad
}
