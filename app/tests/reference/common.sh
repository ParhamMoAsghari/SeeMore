. /data/smtest/lib.sh
jinfo(){ python3 -c 'import json,sys;j=json.load(sys.stdin);print(j["id"],j["status"],j["state"],"phase",j["phase"],"att",j["attempts"],"err",j.get("err"),"rec",j.get("recovery"));g=j["data"].get("groups");g and print("groups:",[(x["kind"],x["title"],x.get("state"),x.get("importCmd"),x.get("recovered")) for x in g]);print("\n".join(j["files"]))'; }
arr(){ docker exec -w /app smtest node tests/reference/arrcheck.js 'Night of the Living|Sherlock|^The Great$' | sed -E 's/ \[Season 2[^]]*\]/ [..library S2 files..]/'; }
jst(){ ctlo job "{\"id\":\"$1\"}" | jinfo; }
waitend(){ for i in $(seq 1 $1); do sleep 2; docker ps -q -f name=smtest -f status=running | grep -q . || return 0; ctl job "{\"id\":\"$J\"}" 2>/dev/null | grep -qE '"status": "(done|failed|canceled)"' && return 0; done; }
