. /data/smtest/common.sh
echo "################ T7 import e2e + *arr response lost after successful import"
rm -f $T/state/crashed-*; wstart -e SM_CRASH_AT=after_import_cmd
echo "== before: arr"; arr
echo "== scan (dry)"; ctl import '{"drive":"SMTB","dry":true}' | python3 -c 'import json,sys;d=json.load(sys.stdin);st=d.pop("stages");print(json.dumps(d,ensure_ascii=False));print("stages",[(s["name"],s.get("ms")) for s in st])'
J=$(ctl import '{"drive":"SMTB"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["job"]["id"])'); echo JOB=$J
waitend 200; docker logs smtest 2>&1 | grep -E 'TESTHOOK'
echo "== (a) state at crash #1"; jst $J; arr
rm -f $T/state/crashed-*; wstart -e SM_CRASH_AT=after_import_cmd
waitend 200; docker logs smtest 2>&1 | grep -E 'TESTHOOK'
echo "== (a2) state at crash #2"; jst $J; arr
wstart; waitend 200
docker logs smtest 2>&1 | grep -E "EV .* $J" | tail -10
echo "== (c) final"; ctl job "{\"id\":\"$J\"}" | jinfo; arr
ctl job "{\"id\":\"$J\"}" | python3 -c 'import json,sys;j=json.load(sys.stdin);print(json.dumps(j["data"].get("report"),ensure_ascii=False)[:1500])'
echo "== disk"; find /data/media/movies -ipath '*living*' -type f; find /data/media/tv -ipath '*sherlock*' -type f; find "/data/media/tv/The Great" -newer /data/smtest/lib.sh -type f; find /data/usb-imports -path '*SMTB*' -type f; echo "staging files: $(find /data/usb-imports/.staging -type f | wc -l)"
echo "source intact: $(find /media/usb/SMTB -type f -not -path '*/.seemore/*' | wc -l) files"
tail -4 $T/state/sent.jsonl
echo T7-END
