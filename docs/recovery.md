# Recovery and power-loss behaviour

All state is in SQLite (`state/seemore/bot.db`, WAL, `synchronous=FULL`, checkpoint every `schedule.checkpoint_min` and on stop).
Containers use `restart: always`; the host helpers are systemd units, so everything comes back after a power cut.

| situation | what happens |
|---|---|
| power loss while copying | file written as `.part`, never renamed; on boot the job is requeued, orphan `.part` files are removed, the last finished file is re-verified (size + sample hash), copying continues |
| power loss in verifying / committing | verification restarts from scratch; sources of a move are deleted only after every destination file is verified, so a source is never removed without a verified copy |
| drive pulled | job → `waiting_for_device`; resumes only when the **same** drive returns (seemore marker, serial, PARTUUID, fs UUID, size); a different/reformatted drive is refused |
| Radarr/Sonarr lost after an import was sent | the command id is stored; on recovery the *arr file record is checked before importing again (no duplicates) |
| restart with unsent notifications | outbox rows stay `pending` and are sent with backoff (at-least-once) |
| two jobs on the same path | path locks: the second waits; rename/delete on a busy path is refused |
| self-recreate from settings | `seemore-ctl` keeps a copy of `.env` in `backups/ctl/`, restores it if `compose up` fails, and the history entry is settled on boot |
| bad Caddy domain | snippet restored and value reverted; Caddy keeps serving the old config |
| bad subfa override | subfa only reads tuning keys; delete `subfa/state/overrides.json` and restart `subfa` to return to env defaults |

| restart while a share link download is running | the client resumes with HTTP Range (`curl -C -`, browsers, download managers); ZIP CRCs come from the cache so the resumed stream is identical |
| restart while a RAR is being built | the build restarts from scratch; the half-built archive is never served |
| messenger unreachable (filtered, outage) | the bot keeps polling with backoff; notifications wait in the outbox; the container health check turns unhealthy after ~150 s without a successful poll |

**Health vs. recovery:** a running container is not proof that interrupted work recovered. `GET /api/v1/health`
(panel → Health) reports service reachability and job recovery separately: waiting jobs and which drive they need,
recent recoveries, failures in the last 24 h and the notification outbox.

**After a power cut** the Docker daemon starts at boot and brings every container back (`restart: always`); the
bot sends a short report of resumed and waiting jobs. Note: Docker does not apply `restart: always` after an explicit
`docker kill` (by design) — start the container manually in that case.

Manual recovery: panel → Jobs (resume/cancel), Health → Recovery. Last resort: stop `seemore`, restore
`state/seemore/bot.db` from the daily backup ([backup-restore.md](backup-restore.md)), start.
