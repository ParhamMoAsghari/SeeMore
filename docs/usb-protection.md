# USB drive write-protection

Goal: a plugged-in drive is never damaged or formatted. **Default = protected (read-only).**

## Host (`host/usb-automount/`, installed to /usr/local/sbin + /etc/systemd/system)
- `usbpol` (NEW, python3, installs to `/usr/local/sbin/usbpol`). Policy file `/etc/seemore/usb-policy.json`:
  `{default_mode, auto_repair, drives{key:{serial,partuuid,uuid,size,mode,label,t}}}`. It fails safe to protected.
  - Match rule: the size must be equal. With a serial: serial + (partuuid|uuid). Without a serial: uuid. Conflicting fields mean no match.
  - CLI: `lookup S P U SIZE`, `set MODE S P U SIZE LABEL`, `default FILE.json`, `show`.
- `usb-automount` (rewritten):
  - Identity is computed **before** the mount, then the policy is looked up.
  - Protected: `blockdev --setro` on the partition and its parent, check-only fsck (`fsck.vfat -n`, `fsck.exfat -n`, `ntfsfix -n`, `e2fsck -n`), then a ro mount (ext `ro,noload`, xfs `ro,norecovery`, btrfs `ro,rescue=nologreplay`). No marker file.
  - Writable: rw mount. It repairs only if `auto_repair` is on (off by default).
  - fsck result: clean | dirty | errors(N) | timeout | skipped. The drive json gets `mode`, `policyKey`, `fsckKind`, `fsckLog` and `fsckAt`.
  - Runtime block-list: shell functions shadow mkfs*, mke2fs, mkntfs, mkdosfs, mkexfatfs, wipefs, parted, (s|g|c)fdisk, gdisk, blkdiscard, dd and shred. They return 99 and log BLOCKED.
  - Requests (`/run/usb-automount/requests/`):
    - `<id>.eject`;
    - `<id>.mode` `{mode}`: protected = save policy, sync, remount ro, setro. Writable = setrw, then umount + fresh rw mount, because a host remount does not propagate into the container;
    - `<id>.check` (check-only; a rw mount is remounted ro temporarily);
    - `<id>.repair` (only if the policy and the drive are writable);
    - `policy.default` `{default_mode,auto_repair}`.
    Every request carries a `nonce`, and the result json (`results/<id>.json`) echoes it. The app only accepts its own nonce, so stale results are ignored. A partial or empty request file is retried for 10 s.
  - Loop devices get setrw on remove (loops are reused).
- `usb-eject.service`/`.path`: `StartLimitIntervalSec=0`, `TriggerLimitIntervalSec=0`, `TimeoutStartSec=1800`. Request bursts had tripped start-limit-hit.

## App
- `lib/settings.js`: `usb.default_mode` ('protected'|'writable', default protected) and `usb.auto_repair` (false).
- `bot.js`: `pushUsbPolicy()` runs after `startWatcher()` and whenever these settings change. It writes the `policy.default` request.
- `lib/usb.js`:
  - `readDrives` normalizes `mode` (missing = protected) and sets `mountRo` from /proc/self/mountinfo (per-mount or superblock ro), `protected`, and `ro = ro || protected || mountRo`.
  - New: `PROTECTED_MSG`, `writable()`, `assertWritable()`/`assertWritablePath()` (throws status 403 code EPROTECTED), `modeLabel`, `fsckLabel`, `ctlRequest(id,kind,body,waitS)` (nonce), `setMode`, `checkDrive`, `repairDrive`, `pushPolicy`.
  - `ensureMarker` only writes on writable drives. `removePath`, `mkdirOn`, `renameOn` and `moveOn` call assertWritable.
- `lib/jobs.js`: `guardWrite()` runs before the tmp write, before the final rename and before the source unlink of a move. Reconcile does not unlink `.part` files on non-writable drives.
- `lib/svc/usbops.js`: assertWritable on the destination of copyPlan/transfer, and on the source for a move. The marker is written on the source only for a move.
- `lib/importui.js`: no marker on the import source, so an import never writes to the source.
- `lib/usbui.js`:
  - The drive line and browse header show the mode and fsck result.
  - The connect notice says "🔒 محافظت‌شده: فقط‌خواندنی وصل شد" and has a «🔒 محافظت و سلامت» button. The watcher no longer writes a marker.
  - New `uM*` drive menu:
    - check (usb_view);
    - writable/protect (admin, with a warning confirm);
    - repair (admin, writable only, with a strong warning).
    Actions are audited.
  - Paste refuses a protected destination (and a protected source on a move).
- `lib/core.js`:
  - `usb.copy` calls assertWritable.
  - New methods: `usb.mode` (admin, `confirm:true` else 428, busy 409), `usb.check` (usb_view), `usb.repair` (admin, 403 if protected).
- `lib/api/routes.js`: POST `/storage/devices/:id/mode` `{mode,confirm}`, `/check`, `/repair` `{confirm}`.
- Panel:
  - `panel/src/pages/Drives.jsx`: mode badges, a protected note, 🩺 check (result modal), a ✏️/🔒 toggle and 🛠 repair (owner) with confirm modals. The browser also shows a protected note.
  - `panel/src/pages/settingsMeta.js`: labels for the two new settings.
  - Rebuilt into `app/public`. ****
- Tests:
  - `app/tests/noformat.js` (static guard: no mkfs/partition/wipe path in app/host/panel, and the helper block-list exists). Run: `node app/tests/noformat.js <repo-root>`.
  - `app/tests/protect.js` (loop-drive API/bot test, `<label> [import] [toggle]`).

## Install
- Copy `host/usb-automount/{usb-automount,usbpol,usb-eject.service,usb-eject.path}`; `usbpol` goes to `/usr/local/sbin/` (mode 755), then `mkdir -p /etc/seemore`, `systemctl daemon-reload` and restart `usb-eject.path`.

## Follow-up: plug/unplug health messages 
- Host `usb-automount`: new `$RUN/gone/<id>.json` `{id,name,safe,ro,t}` file, written before the state file is removed.
  - `safe:true` on an eject request, or when the drive was already unmounted at device removal.
  - `safe:false` when the device disappeared while it was still mounted.
  - Records older than a day are pruned.
- `lib/usb.js`:
  - New `fsckProblem(r)`, `healthNote(r)` (dirty → «⚠️ این فلش قبلاً بدون جداسازی امن جدا شده؛ بعداً چک کن.», errors → a short ❗ line, otherwise '') and `readGone(id)`.
  - Shorter `FSCK_FA.dirty` and errors labels.
- `lib/usbui.js`:
  - The connect notice is minimal: no health line for a clean drive, and only `healthNote` for a dirty drive or one with errors. No repair prompt; the «🔒 محافظت و سلامت» button is kept.
  - The drive list shows a health line only on a problem (`driveLine(x)` / `lineOf(x, health)`).
  - The manual check drops the Check-disk advice.
  - Unplug message: none after a safe eject (bot, panel, or a clean unmount). After an unsafe pull, only «⚠️ «NAME» بدون جداسازی امن جدا شد؛ بعداً چکش کن.»
- Panel `Drives.jsx`: new `fsckNote`. The card shows a ⚠️ «بعداً چک کن» badge and a short line only for dirty/errors; there is no "بررسی سلامت: سالم" text any more. The check modal drops the Check-disk advice.
- Tests: `app/tests/healthmsg.js` plus `app/tests/server/healthmsg.sh` (root on the server; clean and dirty loop images, safe eject, unsafe pull, unmount-then-pull, sha256 unchanged).
