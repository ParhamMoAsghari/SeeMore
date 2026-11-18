#!/bin/sh
# seemore host components installer (run as root on the Docker host).
#
#   sudo host/install.sh [--usb] [--ctl] [--all] [--dir <seemore dir>] [--uid N] [--gid N]
#                        [--usb-base /media/usb] [--caddy-container caddy] [--dry-run]
#
#   --usb   USB auto-mount: udev rule + usb-mount@.service (protected by default) + usbpol + request path unit
#   --ctl   seemore-ctl: allow-listed "recreate seemore container" and "reload Caddy" for runtime settings
#   --all   both (default when no component is given)
# Values default to the ones in <seemore dir>/.env (SEEMORE_UID, SEEMORE_GID, SEEMORE_USB_ROOT, CADDY_CONTAINER).
# Idempotent: re-running updates the files; an existing /etc/seemore/ctl.conf is kept (use --force-conf to rewrite).
# Undo with host/uninstall.sh.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
DIR=$(cd "$HERE/.." && pwd)
USB=0; CTL=0; DRY=0; FORCE_CONF=0
UID_=""; GID_=""; USB_BASE=""; CADDY_C=""
while [ $# -gt 0 ]; do
  case "$1" in
    --usb) USB=1 ;; --ctl) CTL=1 ;; --all) USB=1; CTL=1 ;;
    --dir) DIR=$2; shift ;; --uid) UID_=$2; shift ;; --gid) GID_=$2; shift ;;
    --usb-base) USB_BASE=$2; shift ;; --caddy-container) CADDY_C=$2; shift ;;
    --dry-run) DRY=1 ;; --force-conf) FORCE_CONF=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac; shift
done
[ $USB = 0 ] && [ $CTL = 0 ] && { USB=1; CTL=1; }
envval() { [ -f "$DIR/.env" ] && sed -n "s/^$1=//p" "$DIR/.env" | tail -1 | tr -d '"' || true; }
UID_=${UID_:-$(envval SEEMORE_UID)}; UID_=${UID_:-1000}
GID_=${GID_:-$(envval SEEMORE_GID)}; GID_=${GID_:-$UID_}
USB_BASE=${USB_BASE:-$(envval SEEMORE_USB_ROOT)}; USB_BASE=${USB_BASE:-/media/usb}
CADDY_C=${CADDY_C:-$(envval CADDY_CONTAINER)}; CADDY_C=${CADDY_C:-caddy}
case "$UID_$GID_" in *[!0-9]*) echo "uid/gid must be numeric" >&2; exit 2 ;; esac
case "$USB_BASE" in /*) ;; *) echo "--usb-base must be absolute" >&2; exit 2 ;; esac

run() { if [ $DRY = 1 ]; then echo "+ $*"; else "$@"; fi; }
put() { # put <mode> <src> <dst> [sed-expr]
  if [ $DRY = 1 ]; then echo "+ install -m $1 $2 $3"; return; fi
  if [ -n "${4:-}" ]; then sed "$4" "$2" > "$3.tmp" && chmod "$1" "$3.tmp" && mv "$3.tmp" "$3"; else install -m "$1" "$2" "$3"; fi
}
[ $DRY = 1 ] || [ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
SUBST="s#__UID__#$UID_#g;s#__GID__#$GID_#g;s#__USB_BASE__#$USB_BASE#g;s#__SEEMORE_DIR__#$DIR#g;s#__CADDY_CONTAINER__#$CADDY_C#g"
run mkdir -p /etc/seemore

if [ $USB = 1 ]; then
  for b in lsblk blkid mount umount flock python3 logger; do command -v $b >/dev/null 2>&1 || echo "warning: $b not found (needed by usb-automount)"; done
  command -v fsck.vfat >/dev/null 2>&1 || echo "hint: install dosfstools exfatprogs ntfs-3g e2fsprogs for fsck/repair before mounting"
  put 0755 "$HERE/usb-automount/usb-automount" /usr/local/sbin/usb-automount
  put 0755 "$HERE/usb-automount/usbpol" /usr/local/sbin/usbpol
  if [ $DRY = 1 ]; then echo "+ write /etc/seemore/usb.conf"; else
    printf '# written by seemore host/install.sh\nUSB_BASE=%s\nSEEMORE_UID=%s\nSEEMORE_GID=%s\n' "$USB_BASE" "$UID_" "$GID_" > /etc/seemore/usb.conf; chmod 0644 /etc/seemore/usb.conf; fi
  put 0644 "$HERE/usb-automount/usb-automount.tmpfiles" /etc/tmpfiles.d/usb-automount.conf "$SUBST"
  put 0644 "$HERE/usb-automount/99-usb-automount.rules" /etc/udev/rules.d/99-usb-automount.rules
  put 0644 "$HERE/usb-automount/usb-mount@.service" /etc/systemd/system/usb-mount@.service
  run mkdir -p /etc/systemd/system/usb-mount@.service.d
  put 0644 "$HERE/usb-automount/usb-mount@.service.d/fsck-timeout.conf" /etc/systemd/system/usb-mount@.service.d/fsck-timeout.conf
  put 0644 "$HERE/usb-automount/usb-eject.path" /etc/systemd/system/usb-eject.path
  put 0644 "$HERE/usb-automount/usb-eject.service" /etc/systemd/system/usb-eject.service
  run systemd-tmpfiles --create /etc/tmpfiles.d/usb-automount.conf
  run systemctl daemon-reload
  run systemctl enable --now usb-eject.path
  run udevadm control --reload
  echo "usb-automount installed (mount base $USB_BASE, uid:gid $UID_:$GID_)"
fi

if [ $CTL = 1 ]; then
  command -v docker >/dev/null 2>&1 || echo "warning: docker not found (seemore-ctl runs docker compose / docker exec)"
  put 0755 "$HERE/seemore-ctl/seemore-ctl" /usr/local/sbin/seemore-ctl
  if [ ! -f /etc/seemore/ctl.conf ] || [ $FORCE_CONF = 1 ]; then put 0644 "$HERE/seemore-ctl/ctl.conf.example" /etc/seemore/ctl.conf "$SUBST"; else echo "keeping existing /etc/seemore/ctl.conf"; fi
  put 0644 "$HERE/seemore-ctl/seemore-ctl.tmpfiles" /etc/tmpfiles.d/seemore-ctl.conf "$SUBST"
  put 0644 "$HERE/seemore-ctl/seemore-ctl.service" /etc/systemd/system/seemore-ctl.service
  put 0644 "$HERE/seemore-ctl/seemore-ctl.path" /etc/systemd/system/seemore-ctl.path
  run systemd-tmpfiles --create /etc/tmpfiles.d/seemore-ctl.conf
  run systemctl daemon-reload
  run systemctl enable --now seemore-ctl.path
  echo "seemore-ctl installed (compose dir $DIR, caddy container $CADDY_C, uid:gid $UID_:$GID_)"
fi
