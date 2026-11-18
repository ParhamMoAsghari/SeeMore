# External drives (USB flash drives and disks)

Two parts: a **host helper** that mounts drives safely, and the **core** that browses them and runs transfers.

## Host helper (`host/usb-automount/`)
Installed by `sudo make host` / `sudo sh host/install.sh --usb` (see [installation.md](installation.md)).

| file | installed to | role |
|---|---|---|
| `99-usb-automount.rules` | `/etc/udev/rules.d/` | for USB block devices with a filesystem: start `usb-mount@<kname>.service` |
| `usb-mount@.service` (+ `.d/fsck-timeout.conf`) | `/etc/systemd/system/` | runs `usb-automount add/remove <kname>`; bound to the device, so unplug unmounts |
| `usb-automount` | `/usr/local/sbin/` | mounts (read-only by default), check-only or repairing fsck, writes the drive JSON, handles eject / mode / check / repair requests |
| `usbpol` | `/usr/local/sbin/` | per-drive write-protection policy (`/etc/seemore/usb-policy.json`) |
| `usb-eject.path` / `usb-eject.service` | `/etc/systemd/system/` | watches `/run/usb-automount/requests` for eject, mode, check, repair and policy requests from the container |
| `usb-automount.tmpfiles` | `/etc/tmpfiles.d/usb-automount.conf` | runtime dirs (requests dir writable by `SEEMORE_UID`) |
| — | `/etc/seemore/usb.conf` | `USB_BASE`, `SEEMORE_UID`, `SEEMORE_GID` written by the installer |

Behaviour:
* Only removable / USB devices; never anything backing `/`, `/boot` or swap. Loop devices only when
  `/run/usb-automount/allow-loop` exists (testing).
* Filesystems: vfat (FAT32), exfat, ntfs (ntfs3 kernel driver, ntfs-3g fallback, read-only if both fail), ext2/3/4,
  btrfs, xfs.
* **Before mounting**, an unknown drive is **protected**: the block device is set read-only, fsck runs check-only
  (`-n`), and the mount is read-only. A drive marked writable can be repaired (`fsck.vfat -a`, `fsck.exfat -p`,
  `ntfsfix -d`, `e2fsck -p`, with timeouts). The result (`clean`, `dirty`, `repaired`, `errors(n)`) is shown in the
  bot/panel. Details: [usb-protection.md](usb-protection.md).
* Mounted under `$USB_BASE/<label>` as `SEEMORE_UID:SEEMORE_GID` (`flush` on vfat); state for the core in
  `/run/usb-automount/drives/<id>.json` (label, fs, size, serial, PARTUUID, UUID, fsck result).
* Safe eject: the core writes `requests/<id>.eject`; the helper syncs, unmounts, powers the device off (udisks when
  available) and writes `results/<id>.json`.
* Host packages: `util-linux` (lsblk, blkid, flock), `python3`, and for repairs `dosfstools exfatprogs ntfs-3g
  e2fsprogs`.

The container sees `$SEEMORE_USB_ROOT` as `/media/usb` with `rslave` propagation (hot-plugged mounts appear without a
restart) and `/run/usb-automount` as `/usbctl`.

## In seemore
Permissions: `usb_view`, `usb_copy`, `usb_import`, `usb_manage` ([permissions.md](permissions.md)); feature flags
`features.usb`, `features.usb_import`, `features.usb_manage`.

* **Notices:** plug-in → message with name, size, free space, filesystem and fsck result; unplug → message.
  `usb.ignore_label_regex` hides drives (no notices, no listing, no marker).
* **Browse:** folders and files with sizes, pagination; **metadata** of any file (video: resolution, codec, HDR,
  duration, audio and subtitle tracks via ffprobe; images: dimensions + EXIF; PDF and archives: their info; everything:
  type, size, dates) — same viewer for server files ([api.md](api.md) `/files`).
* **Manage:** move, rename, new folder, delete (with confirmation), copy/move between drives — all as jobs or path-locked
  operations, refused on busy paths.
* **Copy to drive:** pick movies or series → seasons → episodes («همه قسمت‌ها», «همه‌ی فصل‌ها»); subtitles are copied
  alongside; the archive layout is kept (`<Movie (Year)>/…`, `<Series>/Season 01/…`, names cleaned for the
  target filesystem). The plan shows total size and free space
  and refuses when it does not fit; FAT32 files ≥ 4 GiB are skipped with a warning (format the drive as exFAT/NTFS).
  Progress message every `jobs.progress_every_s` s: percent, bytes, speed, ETA, current file, cancel button.
* **Import to server:** see [imports.md](imports.md).
* **Eject:** refused while a transfer uses the drive; flushes and unmounts through the host helper.

## Device identity
See [architecture.md](architecture.md#device-identity). The marker `.seemore/id` is written on first use on writable
drives; read-only drives are identified by the hardware/partition fields only.

## Testing without a USB drive
```sh
truncate -s 2G /tmp/fake.img && mkfs.vfat -n TESTUSB /tmp/fake.img
sudo touch /run/usb-automount/allow-loop
L=$(sudo losetup --show -f /tmp/fake.img) && sudo systemctl start "usb-mount@${L#/dev/}"
# … use it from the bot/panel …
sudo systemctl stop "usb-mount@${L#/dev/}" && sudo losetup -d "$L" && sudo rm /run/usb-automount/allow-loop
```
