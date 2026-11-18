#!/bin/bash
# Host side of tests/healthmsg.js: loop images only (labels SMPROTH*), never a real drive. Run as root on the server.
set -u
W=/root/protect-test; mkdir -p $W; cd $W
H=/usr/local/sbin/usb-automount; RUN=/run/usb-automount; DBF=/opt/seemore/data/bot.db; ST=/tmp/hm-state
setk(){ python3 -c "import sqlite3,time,json;c=sqlite3.connect('$DBF');c.execute('INSERT INTO settings(k,v,t,by) VALUES(?,?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,t=excluded.t',('usb.ignore_label_regex',json.dumps('^SMPROT'),int(time.time()*1000),None));c.commit()"; }
delk(){ python3 -c "import sqlite3;c=sqlite3.connect('$DBF');c.execute(\"DELETE FROM settings WHERE k='usb.ignore_label_regex'\");c.commit()"; }
mkimg(){ rm -f $1; truncate -s 64M $1; printf 'label: dos\n,,c\n' | sfdisk -q $1
  local L; L=$(losetup -fP --show $1); udevadm settle; blockdev --setrw $L ${L}p1; mkfs.vfat -F 32 -n $2 ${L}p1 >/dev/null
  mkdir -p /mnt/pt; mount ${L}p1 /mnt/pt; echo hello > /mnt/pt/note.txt; umount /mnt/pt; losetup -d $L; }
dirty(){ python3 - $1 <<'PY'
import sys,struct
f=open(sys.argv[1],'r+b'); f.seek(446+8); start=struct.unpack('<I',f.read(4))[0]*512
f.seek(start+0x41); b=f.read(1)[0]; f.seek(start+0x41); f.write(bytes([b|1])); f.close()
PY
}
plug(){ LOOP=$(losetup -fP --show $1); udevadm settle; $H add ${LOOP#/dev/}p1; }
gone(){ $H remove ${LOOP#/dev/}p1; losetup -d $LOOP; udevadm settle; }
w(){ for i in $(seq 1 400); do [ -e $ST/$1 ] && return 0; sleep 0.5; done; echo "host: timeout waiting $1"; return 1; }
setk; sleep 7; touch $RUN/allow-loop
mkimg h1.img SMPROTH1; mkimg h2.img SMPROTH2; dirty h2.img; S1=$(sha256sum < h1.img); S2=$(sha256sum < h2.img)
rm -rf $ST; mkdir -p $ST; chown 1000:1000 $ST
docker run --rm --user 1000:1000 -w /app -e TZ=Asia/Tehran -e DB_FILE=/state/h.db -e BALE_CHAT_ID=1484089453 -e USB_CTL=/usbctl \
  -v /opt/seemore/app:/app:ro -v /media/usb:/media/usb:rslave -v /run/usb-automount:/usbctl -v $ST:/state \
  --entrypoint node media-bot:local tests/healthmsg.js > $W/hm.out 2>&1 &
DP=$!
w ready && { plug h1.img; touch $ST/p1; }
w e1 && { gone; touch $ST/g1; }                                   # device leaves after the safe eject
w g1 && { plug h2.img; touch $ST/p2; }
w n2 && { gone; touch $ST/u2; }                                   # pulled while still mounted
sleep 2; plug h1.img; touch $ST/p3
w n3 && { MP=$(findmnt -rno TARGET ${LOOP}p1); umount "$MP"; gone; touch $ST/u3; }   # unmounted first, then pulled
wait $DP; grep -v '"level"' $W/hm.out
[ "$(sha256sum < h1.img)" = "$S1" ] && echo "PASS clean image byte-identical" || echo "FAIL clean image changed"
[ "$(sha256sum < h2.img)" = "$S2" ] && echo "PASS dirty image byte-identical (dirty bit untouched, nothing repaired)" || echo "FAIL dirty image changed"
ls $RUN/gone/; cat $RUN/gone/*.json 2>/dev/null
rm -f $RUN/allow-loop; delk; rm -rf $ST; losetup -a | grep -c protect-test; findmnt -rn | grep -c SMPROT; ls $RUN/drives
echo END
