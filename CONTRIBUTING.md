# Contributing

seemore is a private project; changes go through pull requests on this repository.

* **Layering:** interfaces (bot UI, API routes, panel) call the core (`core.call`) only — never service clients
  directly. New domain operations go into `app/lib/core.js` / `core_ext.js` with a permission, and into
  `app/lib/api/routes.js`; then run `python3 tools/gen_openapi.py` to refresh `app/lib/api/openapi.yaml`.
* **Durability:** anything that moves or writes user files is a job (`app/lib/jobs.js`), with `.part` + fsync +
  verify, commit-phase deletes and an idempotency key. Add a failure scenario to `TESTS.md` (pre-failure state,
  recovery behaviour, final data state, PASS/FAIL) for every new kind of operation.
* **Settings:** new tunables go into `DEFS` in `app/lib/settings.js` with type, env name, description and
  validation, a change class in `app/lib/config/apply.js`, and a Persian label in `panel/src/pages/settingsMeta.js`.
  Document them in `.env.example` (if they have an env var) and `docs/settings.md`.
* **Messengers:** keep `messenger.js`' interface; adapter-specific behaviour stays in the adapter.
* **UI language:** bot and panel texts are Persian (panel RTL); code, comments and docs are English.
* **No dependencies** in the core (Node ≥ 22 built-ins only: `fetch`, `node:sqlite`, `node:test`).
* **Secrets:** never commit `.env`, tokens, keys, passwords, real domains/IPs or user ids. CI runs gitleaks on the full
  history; run `make scan` locally.
* Before a PR: `make lint test` (offline), and `docker compose config --quiet` with your `.env`.
* Versioning: SemVer. A release lists only implemented **and tested** features; untested items go to *Known
  limitations* in `CHANGELOG.md`.
