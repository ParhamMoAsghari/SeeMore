# Upgrading

```sh
cd /opt/seemore
make backup                      # or rely on today's automatic backup
git fetch --tags && git checkout vX.Y.Z    # or: git pull
diff <(grep -o '^[A-Z_]*=' .env.example | sort) <(grep -o '^[A-Z_]*=' .env | sort)   # new variables?
docker compose build seemore
docker compose up -d             # recreates what changed
sudo make host                   # only if host/ changed (see CHANGELOG)
```
* Read `CHANGELOG.md` first; breaking changes and migrations are listed there.
* The database schema is migrated automatically on start (`app/lib/db.js`: `CREATE TABLE IF NOT EXISTS` + additive
  `ALTER TABLE … ADD COLUMN`). Settings stored in
  the DB are kept; new keys appear with their defaults.
* Media services: `docker compose pull && docker compose up -d` (pin versions with the `*_IMAGE` variables if you want
  controlled upgrades).
* Rollback: check out the previous tag, rebuild, and if the new version migrated the DB, restore the backup taken
  before the upgrade ([backup-restore.md](backup-restore.md)).

## From the reference installation (pre-repo layout)
The reference install ran the core as container `media-bot` with `config.env` and `./data`. To adopt this layout:
merge `config.env` into `.env`, move `data/bot.db` to `state/seemore/bot.db`, set `SEEMORE_CONTAINER=media-bot` (or
rename and update the Radarr/Sonarr webhook host to `seemore`), and re-run
`sudo sh host/install.sh --all --force-conf` so `/etc/seemore/ctl.conf` points at the new compose dir and service.
