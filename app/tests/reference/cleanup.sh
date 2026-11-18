. /data/smtest/lib.sh
echo "== arr cleanup"; docker exec -w /app smtest node tests/reference/cleanup.js
docker rm -f smtest >/dev/null
det A; det B; det C
rm -f /run/usb-automount/allow-loop
rm -rf /data/usb-imports/SMTB /data/usb-imports/smtest-src /data/usb-imports/smtest-src2 /data/usb-imports/.staging/* 
rmdir "/data/media/tv/The Great/Season 1" 2>/dev/null
echo "media left: $(ls /data/media/movies | tr '\n' ',') | $(ls /data/media/tv | tr '\n' ',')"
docker exec ${SEEMORE_CONTAINER:-seemore} node -e "const DB=require('/app/lib/db');DB.open('/state/bot.db');const S=require('/app/lib/settings');S.reset('usb.ignore_label_regex');console.log('live notifications rows:',JSON.stringify(DB.all('SELECT kind,status,COUNT(*) n FROM notifications GROUP BY kind,status')));DB.close()"
docker exec -w /app ${SEEMORE_CONTAINER:-seemore} node -e "require('/app/lib/clients').jellyfin.refresh().then(()=>console.log('jellyfin refresh ok'),e=>console.log('jellyfin',e.message))"
rm -rf /data/smtest
ls /run/usb-automount/drives/ /media/usb/
echo "== live bot power-loss check: docker kill -s KILL ${SEEMORE_CONTAINER:-seemore}"
docker kill -s KILL ${SEEMORE_CONTAINER:-seemore} >/dev/null; sleep 40; docker ps --filter name=${SEEMORE_CONTAINER:-seemore} --format '{{.Status}}'; docker logs --since 45s ${SEEMORE_CONTAINER:-seemore} 2>&1 | grep -E 'ready|server on|boot|error' | grep -viE 'token|key' | tail -5
ls -la ${SEEMORE_DIR:-/opt/seemore}/state/seemore/ | grep bot.db
