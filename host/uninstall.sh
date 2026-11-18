#!/bin/sh
# Remove the seemore host components. Mounted drives are left mounted; /etc/seemore is kept unless --purge.
set -eu
PURGE=0; [ "${1:-}" = "--purge" ] && PURGE=1
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
systemctl disable --now usb-eject.path seemore-ctl.path 2>/dev/null || true
rm -f /etc/udev/rules.d/99-usb-automount.rules /etc/systemd/system/usb-mount@.service /etc/systemd/system/usb-eject.path \
      /etc/systemd/system/usb-eject.service /etc/systemd/system/seemore-ctl.path /etc/systemd/system/seemore-ctl.service \
      /etc/tmpfiles.d/usb-automount.conf /etc/tmpfiles.d/seemore-ctl.conf /usr/local/sbin/usb-automount /usr/local/sbin/seemore-ctl
rm -rf /etc/systemd/system/usb-mount@.service.d
[ $PURGE = 1 ] && rm -rf /etc/seemore
systemctl daemon-reload; udevadm control --reload || true
echo "seemore host components removed"
