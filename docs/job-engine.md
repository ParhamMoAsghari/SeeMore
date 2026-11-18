# Job engine (`app/lib/jobs.js`)

Durable, resumable file-transfer engine backed by SQLite. One job runs at a time (transfers are I/O-bound on the
same disks; running them in sequence keeps progress honest and recovery simple).

## Kinds
| kind | from → to | started by |
|---|---|---|
| `to_usb` | library (`/data/media`) → drive | bot «کپی روی حافظه», panel Drives → copy wizard, `POST /storage/exports` |
| `usb_copy`, `usb_move` | inside a drive or between two drives | drive file manager (move / copy) |
| `import` | drive → `/data/usb-imports/.staging/<id>` → archive (post phase through Radarr/Sonarr) | import wizard, `POST /storage/imports` |

## States
`queued → running → verifying → committing → completed`, plus `paused` (interrupted, resumable by the user),
`waiting_for_device` (drive gone, read-only or I/O error; resumes by itself on the same drive), `failed`, `canceled`.
Stored columns: `status` (engine status), `phase` (`copy | verify | commit`), `attempts`, `idem_key`, `recovery`
(JSON: what boot reconciliation found and did). Per file: `pending → copying → verifying → done` (or `skipped`,
`failed`).

## Write protocol (per file)
1. copy to `<dst>.part` in chunks; progress is emitted every `jobs.progress_every_s` seconds;
2. `fsync(file)`, verify size + sample hash (start/middle/end blocks);
3. `rename(.part → final)`, `fsync(dir)`; mark the row `done` in its own transaction;
4. after the copy loop: flush the destination and **re-verify every file from disk** (`verifying`);
5. `committing`: delete move sources, hand imports to Radarr/Sonarr, clean staging — only now;
6. `completed`, a single `job_end` notification.

On FAT32/exFAT/NTFS a rename is not as crash-safe as on ext4, so the engine never trusts a rename alone: on resume
it re-checks size + sample hash of the last finished file and of any file whose row is not `done`. Drives are mounted
with `flush` on vfat, and the host runs fsck/repair before mounting a drive that was unplugged uncleanly
([usb.md](usb.md)). FAT32 cannot hold files ≥ 4 GiB: such files are skipped with a warning before the job starts.

## Idempotency
* Job: `idem_key = hash(kind, user, endpoints, files)`. Submitting the same job while it is active returns the
  existing job id (bot double-tap, panel retry, API retry).
* File: own `idem_key`; a destination file that already exists with identical size + sample hash is marked done
  without copying (no `name (1).mkv` duplicates).
* Import: the Radarr/Sonarr ManualImport command id is persisted before waiting for it; on recovery the engine
  checks the real `moviefile` / `episodefile` records (same size) before importing again.

## Concurrency
Path locks: a second job touching the same files waits; rename / move / delete on a busy path is refused
(`path busy`); eject is refused while a transfer uses the drive.

## Events and notifications
Every transition and periodic progress is appended to `job_events` (`seq` is monotonic and replayable over SSE).
User-facing notices (`job_waiting`, `job_resumed`, `job_end`, boot summary) are written to the `notifications`
outbox in the same transaction. See [architecture.md](architecture.md#state-events-and-notifications-three-tables).

## Boot reconciliation
On start (`J.boot()`): interrupted jobs are requeued with `recovery = {at, from, phase, action}`, orphan `.part`
files are deleted, the last finished file is re-verified, jobs waiting for a drive stay waiting, and a short boot
notice lists what resumed. Details per failure in [recovery.md](recovery.md).

## Controls
Bot: buttons on the progress message (cancel / resume). Panel: Jobs page. API: `GET /jobs`, `GET /jobs/{id}`,
`GET /jobs/{id}/events`, `POST /jobs/{id}/cancel`, `POST /jobs/{id}/resume`.

## Test hooks
`app/lib/testhooks.js` can SIGKILL the process at exact points (`before_rename`, `verify_file`, `commit_start`,
`after_import_cmd`) — inert unless `SM_TEST_HOOKS=1`, which is never set in production. Used by the failure tests in
[../TESTS.md](../TESTS.md).
