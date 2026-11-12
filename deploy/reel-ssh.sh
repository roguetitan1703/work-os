#!/bin/bash
# The only thing the reel-booking SSH key can run (forced command in ~ubuntu/.ssh/authorized_keys, docs/hosting.md
# 9a). Installed root-owned as /usr/local/sbin/work-os-reel-ssh. SSH_ORIGINAL_COMMAND is untrusted: it is split
# into words here (no shell parsing, no globbing) and must be exactly one of
#
#   book <post-id> <container-id> <YYYY-MM-DD> <HH:MM>      (IST)
#   list
#   cancel <post-id>
#
# work-os-reel-at checks every value again before it writes anything.
set -euo pipefail
set -f
export LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin   # the client may send LANG/LC_* (AcceptEnv)
CMD="${SSH_ORIGINAL_COMMAND:-}"
[ "${#CMD}" -le 200 ] || { echo "command too long" >&2; exit 2; }
[[ "$CMD" =~ ^[A-Za-z0-9_:\ -]*$ ]] || { echo "only letters, digits, -, _, : and spaces" >&2; exit 2; }
read -r -a W <<<"$CMD"
id='^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$'
case "${W[0]:-} ${#W[@]}" in
  "book 5")
    [[ "${W[1]}" =~ $id && "${W[2]}" =~ ^[0-9]{5,30}$ && "${W[3]}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "${W[4]}" =~ ^[0-9]{2}:[0-9]{2}$ ]] ||
      { echo "usage: book <post-id> <container-id> <YYYY-MM-DD> <HH:MM>" >&2; exit 2; }
    exec sudo -n /usr/local/sbin/work-os-reel-at "${W[1]}" "${W[2]}" "${W[3]} ${W[4]}" ;;
  "list 1")
    exec sudo -n /usr/local/sbin/work-os-reel-at --list ;;
  "cancel 2")
    [[ "${W[1]}" =~ $id ]] || { echo "usage: cancel <post-id>" >&2; exit 2; }
    exec sudo -n /usr/local/sbin/work-os-reel-at --cancel "${W[1]}" ;;
  *)
    echo "usage: book <post-id> <container-id> <YYYY-MM-DD> <HH:MM> | list | cancel <post-id>" >&2; exit 2 ;;
esac
