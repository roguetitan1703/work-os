#!/usr/bin/env bash
# Read-only check of a server before Work OS is installed on it (docs/hosting.md "1. The server"). It changes nothing:
# no files written, no packages installed, no services touched. Run it on the box and send the output to whoever
# installs, privately: it describes the other apps on the box. It prints no secrets (it never reads /etc/work-os/env
# or any other app's config values).
#
#   bash preflight.sh                 what an ordinary user can see
#   sudo bash preflight.sh            also the process behind each listening port and nginx -T's site list
#   WORK_OS_PORT=3110 bash preflight.sh   check another app port (default 3100)
#
# Sections: machine (arch, OS, RAM, swap, disk, cgroup v2, CPU credits hint), software (the system Node and Work OS's
# own in /opt/work-os/node, npm, git, gh, mongodump, systemd-run, pm2, docker), Caddy (sites and imports), nginx (version, sites, default servers, names already served, variables and
# zones that would clash), ports in use, users and groups, and what Work OS would create that already exists.
set -u
PORT="${WORK_OS_PORT:-3100}"
ROOT_RUN=0
[ "$(id -u)" = 0 ] && ROOT_RUN=1

h() { echo; echo "== $1 =="; }
have() { command -v "$1" >/dev/null 2>&1; }
ok() { echo "  ok    $*"; }
warn() { echo "  WARN  $*"; }
info() { echo "  ·     $*"; }

echo "Work OS pre-flight ($(date -u +%Y-%m-%dT%H:%MZ)) on $(hostname 2>/dev/null || echo '?'), as $(id -un)$([ "$ROOT_RUN" = 1 ] && echo ' (root)')"

h "Machine"
ARCH="$(uname -m)"
case "$ARCH" in
  aarch64 | arm64) ok "arch $ARCH (ARM64, e.g. Graviton t4g): Node, Next's SWC, MongoDB Database Tools and age all ship arm64 builds" ;;
  x86_64) ok "arch $ARCH" ;;
  *) warn "arch $ARCH: not a target Work OS was checked on (arm64 or x86_64)" ;;
esac
if [ -r /etc/os-release ]; then
  . /etc/os-release
  info "OS: ${PRETTY_NAME:-$ID}"
  case "${ID:-}" in
    ubuntu | debian) ;;
    amzn) warn "Amazon Linux: nginx sites live in /etc/nginx/conf.d (no sites-available); packages via dnf (docs/hosting.md)" ;;
    *) warn "not Ubuntu/Debian: the install commands in docs/hosting.md need translating" ;;
  esac
fi
info "kernel $(uname -r)"
if have nproc; then info "CPUs: $(nproc)"; fi
TOKEN="$(curl -s -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)"
if [ -n "$TOKEN" ]; then
  ITYPE="$(curl -s -m 2 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-type 2>/dev/null || true)"
  [ -n "$ITYPE" ] && info "EC2 instance type: $ITYPE"
  case "$ITYPE" in
    t4g.nano | t4g.micro | t4g.small | t3.* | t4g.*) info "burstable: CPU credits are shared by every app on the box (docs/cpu.md \"Graviton\")" ;;
  esac
else
  info "EC2 metadata not reachable (not EC2, or IMDS off/hop limit): instance type unknown"
fi
if have free; then
  free -m | awk 'NR==2{printf "  ·     RAM: %d MB total, %d MB available now\n",$2,$7} /^Swap:/{printf "  ·     swap: %d MB total, %d MB used\n",$2,$3}'
  MEM_MB="$(free -m | awk 'NR==2{print $2}')"
  SWAP_MB="$(free -m | awk '/^Swap:/{print $2}')"
  AVAIL_MB="$(free -m | awk 'NR==2{print $7}')"
  [ "${MEM_MB:-0}" -lt 3000 ] && [ "${SWAP_MB:-0}" -lt 1900 ] && info "under 3 GB RAM and no 2 GB swap: fine, the box does not build (docs/hosting.md section 7); 2 GB swap is the optional safety net (section 1)"
  [ "${AVAIL_MB:-0}" -lt 700 ] && warn "under 700 MB available now: the app alone wants about 350-450 MB (docs/cpu.md); other apps already use most of it"
fi
if [ -r /proc/swaps ]; then sed -n '2,$p' /proc/swaps | awk '{printf "  ·     swap device %s (%s, %d MB)\n",$1,$2,$3/1024}'; fi
if have df; then
  echo "  ·     disk (Work OS keeps one release, two during a deploy; work-os-deploy refuses to start under 1.5 GB free):"
  df -h / /srv /var /tmp 2>/dev/null | awk 'NR==1 || !seen[$1 $6]++' | sed 's/^/          /'
  FREE_MB="$(df -Pm /srv 2>/dev/null | awk 'NR==2 {print $4}')"
  [ -n "$FREE_MB" ] && [ "$FREE_MB" -lt 1536 ] && warn "only $FREE_MB MB free for /srv: under the 1.5 GB a deploy needs"
fi
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  ok "cgroup v2 (the deploy can cap the build's memory: work-os-deploy uses systemd-run)"
else
  warn "no cgroup v2: the build's memory cap in work-os-deploy is skipped"
fi

h "Software"
if have node; then
  NV="$(node -v)"
  case "$NV" in
    v22.*) ok "system node $NV ($(command -v node)); Work OS still uses its own in /opt/work-os/node" ;;
    *) info "system node $NV at $(command -v node): leave it to the other apps; Work OS runs on its own Node 22 (/opt/work-os/node)" ;;
  esac
  info "node arch: $(node -p process.arch 2>/dev/null)"
else
  info "node: not installed"
fi
if [ -x /opt/work-os/node/bin/node ]; then
  ok "Work OS's own Node: /opt/work-os/node ($(/opt/work-os/node/bin/node -v))"
else
  info "Work OS's own Node 22 (/opt/work-os/node) is not installed yet (docs/hosting.md section 2); the system node stays as it is"
fi
for t in npm git curl flock systemd-run gh certbot mongodump mongorestore age aws rclone ufw; do
  if have "$t"; then
    v="$("$t" --version 2>/dev/null | head -1)"
    ok "$t ${v:-} ($(command -v "$t"))"
  else
    info "$t: not installed"
  fi
done
if have pm2; then info "pm2 is installed (another app may run under it; Work OS uses systemd)"; fi
if have docker; then info "docker is installed: $(docker ps --format '{{.Names}} ({{.Ports}})' 2>/dev/null | tr '\n' ' ' || echo 'containers not readable without root')"; fi

h "Caddy"
if have caddy || systemctl is-active --quiet caddy 2>/dev/null; then
  info "caddy $(caddy version 2>/dev/null | cut -d" " -f1) ($(systemctl is-active caddy 2>/dev/null || echo "?"))"
  for f in /etc/caddy/Caddyfile; do
    [ -r "$f" ] || { info "$f: not readable (run with sudo)"; continue; }
    info "sites in $f: $(grep -hoE '^[^#[:space:]{(][^{]*{' "$f" | tr -d "{" | tr "
" " ")"
    info "imports: $(grep -hoE '^[[:space:]]*import[[:space:]]+[^[:space:]]+' "$f" | awk '{print $2}' | tr "
" " ")"
    if grep -qE '(^|[[:space:]])work.delpat.in([[:space:],{]|$)' "$f" /etc/caddy/sites/*.caddy 2>/dev/null; then warn "work.delpat.in already has a Caddy site"; fi
  done
  [ -e /etc/caddy/sites/work-os.caddy ] && warn "/etc/caddy/sites/work-os.caddy already exists"
else
  info "caddy: not found"
fi

h "nginx"
if have nginx || [ -x /usr/sbin/nginx ]; then
  NGX="$(command -v nginx || echo /usr/sbin/nginx)"
  NGV="$("$NGX" -v 2>&1 | sed 's/.*nginx\///')"
  info "nginx $NGV"
  # http2 on; needs 1.25.1, ssl_reject_handshake 1.19.4. The site uses "listen 443 ssl http2" (works on both).
  case "$NGV" in
    1.1[0-8].*) warn "nginx older than 1.19.4: the opt-in default-deny file (ssl_reject_handshake) will not load" ;;
  esac
  for d in /etc/nginx/sites-enabled /etc/nginx/conf.d; do
    [ -d "$d" ] || continue
    info "$d:"
    ls -l "$d" 2>/dev/null | sed -n '2,$p' | awk '{print "          " $9 ($10 ? " " $10 " " $11 : "")}'
  done
  CONF_FILES="$(ls /etc/nginx/nginx.conf /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null)"
  if [ -n "$CONF_FILES" ]; then
    # shellcheck disable=SC2086
    DEFS="$(grep -Hn 'default_server' $CONF_FILES 2>/dev/null | grep -vE ':[0-9]+:[[:space:]]*#' || true)"
    if [ -n "$DEFS" ]; then
      info "default servers already set (Work OS adds none unless you opt in):"
      echo "$DEFS" | sed 's/^/          /'
    else
      info "no default_server set: nginx answers unknown names with the first server block it loads"
    fi
    # shellcheck disable=SC2086
    NAMES="$(grep -hoE '^[[:space:]]*server_name[[:space:]]+[^;]+' $CONF_FILES 2>/dev/null | sed -E 's/^[[:space:]]*server_name[[:space:]]+//' | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')"
    info "names already served: ${NAMES:-none}"
    case " $NAMES " in *" work.delpat.in "*) warn "work.delpat.in is already served by another site" ;; esac
    # shellcheck disable=SC2086
    if grep -qE '\$work_os_|zone=work_os_|upstream[[:space:]]+work_os' $CONF_FILES 2>/dev/null; then
      warn "a Work OS site (or names starting work_os_) is already loaded"
    else
      ok "no limit zones, maps or upstreams named work_os_* yet"
    fi
    # shellcheck disable=SC2086
    WC="$(grep -hoE '^[[:space:]]*worker_connections[[:space:]]+[0-9]+' $CONF_FILES 2>/dev/null | awk '{print $2}' | head -1)"
    info "worker_connections ${WC:-default (512/768)}: push streams need about 2 per open tab (docs/hosting.md \"Push\")"
  fi
  if [ "$ROOT_RUN" = 1 ]; then
    if "$NGX" -t >/dev/null 2>&1; then ok "nginx -t passes now"; else warn "nginx -t fails BEFORE Work OS is added: fix that first"; fi
  fi
else
  info "nginx: not installed"
fi
for d in /etc/letsencrypt/live/*/; do [ -d "$d" ] && info "certificate: $(basename "$d")"; done 2>/dev/null

h "Ports in use (TCP, listening)"
if have ss; then
  if [ "$ROOT_RUN" = 1 ]; then ss -Htlnp 2>/dev/null; else ss -Htln 2>/dev/null; fi |
    awk '{a=$4; p=$NF; if (p ~ /users:/) {sub(/.*users:\(\("/,"",p); sub(/".*/,"",p)} else p=""; print "          " a (p ? "  " p : "")}' | sort -u
  if ss -Htln "sport = :$PORT" 2>/dev/null | grep -q .; then
    warn "port $PORT is taken: set WORK_OS_PORT in /etc/work-os/env to a free one (and the port in the Caddy site)"
  else
    ok "port $PORT is free for Work OS (127.0.0.1 only)"
  fi
  for p in 80 443; do ss -Htln "sport = :$p" 2>/dev/null | grep -q . && info "port $p is served (Caddy or nginx: see above)"; done
else
  info "ss not found"
fi

h "Users, groups, systemd"
have getent || getent() { case "$1" in passwd) if [ -n "${2:-}" ]; then grep "^$2:" /etc/passwd; else cat /etc/passwd; fi ;; esac; }
info "people (UID 1000+ with a shell): $(getent passwd | awk -F: '$3>=1000 && $3<65534 && $7 !~ /(nologin|false)$/ {printf "%s ", $1}')"
info "system users with a home under /srv, /opt or /var/www (other apps): $(getent passwd | awk -F: '$3<1000 && $6 ~ /^\/(srv|opt|var\/www)/ {printf "%s(%s) ", $1, $6}')"
for u in workos workos-build; do
  if getent passwd "$u" >/dev/null; then warn "user $u already exists ($(getent passwd "$u" | cut -d: -f6))"; else ok "user $u is free"; fi
done
for p in /srv/work-os /etc/work-os /var/backups/work-os /usr/local/sbin/work-os-deploy /etc/nginx/sites-available/work-os /etc/nginx/conf.d/work-os.conf; do
  [ -e "$p" ] && warn "$p already exists"
done
if have systemctl; then
  UNITS="$(systemctl list-unit-files 'work-os*' --no-legend 2>/dev/null | awk '{print $1}' | tr '\n' ' ')"
  if [ -n "$UNITS" ]; then warn "systemd units already named work-os*: $UNITS"; else ok "no systemd units named work-os*"; fi
  info "services running now: $(systemctl list-units --type=service --state=running --no-legend 2>/dev/null | awk '{print $1}' | grep -vE '^(systemd|dbus|ssh|cron|rsyslog|polkit|snapd|getty|serial-getty|unattended|multipathd|networkd|udisks|ModemManager|chrony|amazon-ssm|irqbalance|user@)' | tr '\n' ' ')"
  info "timers: $(systemctl list-timers --all --no-legend 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i ~ /\.timer$/) print $i}' | tr '\n' ' ')"
fi
if have ufw && [ "$ROOT_RUN" = 1 ]; then info "ufw: $(ufw status 2>/dev/null | head -1)"; fi

echo
echo "Done. Nothing was changed."
