#!/usr/bin/env bash
# Instagram reel scheduling for Work OS: one timer per post, no polling. Installed root-owned as
# /usr/local/sbin/work-os-reel-at (docs/hosting.md "Instagram reels"); run with sudo:
#
#   sudo work-os-reel-at <post-id> <container-id> "YYYY-MM-DD HH:MM"   schedule (time in IST); prints the unit name
#   sudo work-os-reel-at --list                                          scheduled posts
#   sudo work-os-reel-at --cancel <post-id>                              unschedule one
#
# Each post gets /etc/systemd/system/work-os-reel-<post-id>.{timer,service}. The timer fires once at the slot
# (OnCalendar; Persistent=true, so a reboot before the slot keeps it), the service runs work-os-reel-publish as workos
# (the app publishes and alerts Om either way), and its ExecStopPost removes both files. Unit files survive a reboot;
# transient systemd-run timers would not.
set -euo pipefail
# Fixed paths, never from the environment: SELF runs as root at the slot (ExecStopPost=+).
UNIT_DIR=/etc/systemd/system
RUNNER=/usr/local/sbin/work-os-reel-publish
SELF=/usr/local/sbin/work-os-reel-at
FAILED_LOG=/var/log/work-os-reel-failed.log
TZ_SLOT="Asia/Kolkata"
MAX_AHEAD_H=23          # a container expires 24 h after upload; a slot further away could never publish

die() { echo "work-os-reel-at: $*" >&2; exit 2; }
[ "$(id -u)" = 0 ] || die "run with sudo"
valid_id() { [[ "$1" =~ ^[A-Za-z0-9_-]{1,48}$ ]]; }
unit() { echo "work-os-reel-$1"; }

remove_units() {
  local u; u="$(unit "$1")"
  systemctl disable --now "$u.timer" >/dev/null 2>&1 || true
  rm -f "$UNIT_DIR/$u.timer" "$UNIT_DIR/$u.service"
  systemctl daemon-reload
}

case "${1:-}" in
  --list)
    systemctl list-timers --all --no-pager 'work-os-reel-*'
    if [ -s "$FAILED_LOG" ]; then echo; echo "Runs that could not reach Work OS (no alert was sent):"; tail -n 10 "$FAILED_LOG"; fi
    exit 0 ;;
  --cancel)
    valid_id "${2:-}" || die "usage: work-os-reel-at --cancel <post-id>"
    [ -e "$UNIT_DIR/$(unit "$2").timer" ] || die "nothing scheduled for $2"
    remove_units "$2"
    echo "cancelled $(unit "$2")"
    exit 0 ;;
  --done)
    # Called by the service's ExecStopPost (as root, "+" prefix) once the publish ran, whatever the result. When the
    # app could not be reached it could not alert anyone either, so the failure is recorded here (shown by --list).
    valid_id "${2:-}" || die "bad post id"
    if [ "${SERVICE_RESULT:-success}" != success ]; then
      echo "$(date -Is) $2: ${SERVICE_RESULT} (journalctl -u $(unit "$2"))" >>"$FAILED_LOG"
    fi
    remove_units "$2"
    exit 0 ;;
  -h|--help|"")
    sed -n '5,7p' "$0"; exit 2 ;;
esac

POST="$1"; CONTAINER="${2:-}"; WHEN="${3:-}"
[ $# -eq 3 ] || die 'usage: work-os-reel-at <post-id> <container-id> "YYYY-MM-DD HH:MM"'
valid_id "$POST" || die "post id: letters, digits, - and _ only (max 48)"
[[ "$CONTAINER" =~ ^[0-9]{5,30}$ ]] || die "container id must be the numeric id from the upload"
[[ "$WHEN" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}$ ]] || die 'time must be "YYYY-MM-DD HH:MM" (IST)'
SLOT="$(TZ="$TZ_SLOT" date -d "$WHEN" +%s 2>/dev/null)" || die "not a real date: $WHEN"
NOW="$(date +%s)"
[ "$SLOT" -gt $((NOW + 60)) ] || die "$WHEN IST is not at least a minute from now"
[ "$SLOT" -le $((NOW + MAX_AHEAD_H * 3600)) ] || die "$WHEN IST is more than ${MAX_AHEAD_H} h away; the container would expire first"
U="$(unit "$POST")"
[ ! -e "$UNIT_DIR/$U.timer" ] || die "$POST is already scheduled (work-os-reel-at --cancel $POST first)"
[ -x "$RUNNER" ] || die "$RUNNER is missing (install it first)"

cat >"$UNIT_DIR/$U.service" <<EOF
[Unit]
Description=Publish Instagram reel $POST (Work OS)
After=work-os.service
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=workos
Group=workos
EnvironmentFile=/etc/work-os/reel.env
ExecStart=$RUNNER $POST $CONTAINER $SLOT
ExecStopPost=+$SELF --done $POST
TimeoutStartSec=10min
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
CapabilityBoundingSet=
PrivateDevices=yes
LockPersonality=yes
RestrictNamespaces=yes
RestrictAddressFamilies=AF_INET AF_INET6
IPAddressDeny=any
IPAddressAllow=localhost
SystemCallFilter=@system-service
MemoryMax=64M
EOF

cat >"$UNIT_DIR/$U.timer" <<EOF
[Unit]
Description=Publish Instagram reel $POST at $WHEN IST

[Timer]
OnCalendar=$(TZ="$TZ_SLOT" date -d "@$SLOT" '+%Y-%m-%d %H:%M:00') $TZ_SLOT
AccuracySec=1s
Persistent=true
RemainAfterElapse=no

[Install]
WantedBy=timers.target
EOF

chmod 0644 "$UNIT_DIR/$U.service" "$UNIT_DIR/$U.timer"
systemctl daemon-reload
systemctl enable --now "$U.timer" >/dev/null
echo "$U  (fires $WHEN IST; logs: journalctl -u $U)"
