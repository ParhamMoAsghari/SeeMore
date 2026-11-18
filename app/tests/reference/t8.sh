. /data/smtest/common.sh
sed -i "s#-e DL_PORT=3998#-e DL_PORT=3998 -e DL_CACHE=/data/smtest/dl-cache#" /data/smtest/lib.sh; grep -q DL_CACHE /data/smtest/lib.sh && . /data/smtest/lib.sh; mkdir -p /data/smtest/dl-cache; chown 1000:1000 /data/smtest/dl-cache
echo "################ T8 restart with active job + unsent notifications + download in progress + RAR build"
rm -rf /media/usb/SMTA/T5 /media/usb/SMTA/T8; rm -f $T/state/crashed-*; touch $T/state/sender-down
wstart -e SM_PAUSE_COPY_CHUNK=400
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' smtest)
J=$(ctl tousb '{"drive":"SMTA","srcDir":"/data/usb-imports/smtest-src","dest":"T8"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])'); echo JOB=$J
M="/data/media/movies/Night of the Living Dead (1968)/Night.of.the.Living.Dead.1968.720p.BluRay.x264.mkv"
E1="/data/media/tv/Sherlock/Season 1/Sherlock.S01E01.720p.WEB.mkv"; E2="/data/media/tv/Sherlock/Season 1/قسمت 2.mkv"
ZT=$(ctl core "$(python3 -c 'import json,sys;print(json.dumps({"method":"links.create","params":{"kind":"zip","title":"smtest zip","files":sys.argv[1:]}}))' "$M" "$E1" "$E2")" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
PIAN=$(find "/data/media/movies/The Pianist (2002)" -type f -size +100M | head -1); echo "rar source: $(basename "$PIAN") $(stat -c %s "$PIAN")"
RT=$(ctl core "$(python3 -c 'import json,sys;print(json.dumps({"method":"links.create","params":{"kind":"rar","title":"smtest rar","files":sys.argv[1:]}}))' "$PIAN")" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
echo "links created (tokens not shown)"
rm -f /tmp/sm.zip; curl -s --limit-rate 150k -o /tmp/sm.zip "http://$IP:3998/dl/$ZT" & CP=$!
sleep 9
echo "== (a) before failure"
ctl jobs | head -2; ctl outbox | python3 -c 'import json,sys;d=json.load(sys.stdin);print("outbox",d["stats"]);[print(" ",r["kind"],r["status"],"attempts",r["attempts"],r["err"]) for r in d["rows"]]'
echo "partial download: $(stat -c %s /tmp/sm.zip) bytes"; ctl core "{\"method\":\"links.get\",\"params\":{\"token\":\"$RT\"}}" 2>/dev/null | python3 -c 'import json,sys;d=json.load(sys.stdin);print("rar",d.get("rar_status"),d.get("rar"))' || true
echo "rar build files: $(find /data/smtest/dl-cache -name building.rar | wc -l) building, size $(find /data/smtest/dl-cache -name building.rar -printf %s)"
docker kill -s KILL smtest >/dev/null; echo "== KILLED (docker kill -s KILL)"; wait $CP; echo "curl exit=$? got=$(stat -c %s /tmp/sm.zip)"
ctlo jobs | head -1
echo "== (b) recovery: network back, worker restarted"
rm -f $T/state/sender-down; wstart; IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' smtest)
curl -s -C - -o /tmp/sm.zip "http://$IP:3998/dl/$ZT"; echo "resume curl exit=$? size=$(stat -c %s /tmp/sm.zip)"
for i in $(seq 1 90); do sleep 2; ctl job "{\"id\":\"$J\"}" | grep -q '"status": "done"' && ctl core "{\"method\":\"links.get\",\"params\":{\"token\":\"$RT\"}}" | grep -q '"rar_status": "ready"' && break; done
sleep 8
echo "== (c) final"
ctl job "{\"id\":\"$J\"}" | jinfo
(cd /data/usb-imports/smtest-src && sha256sum file1.bin file2.bin file3.bin sub/file1.fa.srt) > /tmp/a; (cd /media/usb/SMTA/T8 && sha256sum file1.bin file2.bin file3.bin sub/file1.fa.srt) | diff /tmp/a - && echo "USB HASH-MATCH parts=$(find /media/usb/SMTA/T8 -name '*.part'|wc -l)"
python3 - "$M" "$E1" "$E2" <<'PY'
import zipfile,hashlib,sys,os
z=zipfile.ZipFile('/tmp/sm.zip'); print("zip test:", z.testzip())
src={os.path.basename(p):p for p in sys.argv[1:]}
for i in z.infolist():
    h=hashlib.sha256(z.read(i)).hexdigest(); s=[p for n,p in src.items() if i.filename.endswith(n)]
    print(" ", i.filename, "MATCH" if s and h==hashlib.sha256(open(s[0],'rb').read()).hexdigest() else "DIFF")
PY
ctl core "{\"method\":\"links.get\",\"params\":{\"token\":\"$RT\"}}" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("rar",d.get("rar_status"),d.get("rar_size"),d.get("rar_err"))'
RF=$(ls -t /data/smtest/dl-cache/*/archive.rar 2>/dev/null | head -1); docker exec smtest rar t -idq "$RF" && echo "RAR TEST OK"; echo "leftover building.rar: $(find /data/smtest/dl-cache -name building.rar | wc -l)"
ctl outbox | python3 -c 'import json,sys;d=json.load(sys.stdin);print("outbox",d["stats"]);[print(" ",r["kind"],r["status"],"attempts",r["attempts"]) for r in d["rows"][-6:]]'
echo "job_end notices for $J: $(grep -c "job_end $J" $T/state/sent.jsonl)"; tail -4 $T/state/sent.jsonl
echo "$ZT $RT" > $T/state/t8-tokens
echo T8-END
