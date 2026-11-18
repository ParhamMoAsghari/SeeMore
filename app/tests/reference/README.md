# Reference-installation tests

These scripts produced the Stage 1 (T1–T8) and Stage 2 (panel/API e2e) results in [../../../TESTS.md](../../../TESTS.md).
They ran on the reference server against the real Radarr/Sonarr/Jellyfin stack with loop-device drives and a throwaway
worker container, using a harness (`/data/smtest/lib.sh`: loop images, `wstart`, `ctl`, `det`) that was removed after
the run. They are kept as an exact record of the procedure and as a starting point for re-running the scenarios on
another host, not as a turnkey suite.

| file | role |
|---|---|
| `worker.js` | real job engine, importer, outbox and link server with its own SQLite DB and a messenger stand-in |
| `ctl.js` | drives the worker through core calls (start jobs, imports, links; inspect jobs/outbox) |
| `arrcheck.js`, `cleanup.js` | read / clean the Radarr and Sonarr test items |
| `common.sh`, `t7.sh`, `t8.sh`, `cleanup.sh` | shell drivers (T7 import + lost *arr response, T8 restart with active work) |
| `panel_e2e.py` | API + panel end-to-end test (`SEEMORE_DIR`, `SEEMORE_CONTAINER`; reads `.env`, never prints secrets) |

Fault injection: `app/lib/testhooks.js` (`SM_TEST_HOOKS=1`, `SM_CRASH_AT=before_rename|verify_file|commit_start|after_import_cmd`).
The offline suites that run anywhere are `app/tests/unit` and `app/tests/integration`.
