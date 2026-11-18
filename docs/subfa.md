# subfa: automatic Persian subtitles

Gets a Persian (`fa`) subtitle for every movie and episode in the library, so nothing has to be fetched by hand.

## How it works
1. Every 3 minutes (and right after a Sonarr/Radarr import, via the `subfa` webhook connection) it reads Bazarr's
   series/episodes/movies and finds video files with no `fa` subtitle (Bazarr state + a disk check for `*.fa.srt`, `.fas`, `.per`...).
2. New item: asks Bazarr to search with its own providers (`search-missing`) and waits 15 minutes (`BAZARR_GRACE`).
3. Still missing: own subf2m scraper.
   - Page: search `"<title> <Ordinal> Season"` for series (e.g. "<Title> Second Season"), `"<title>"` for movies,
     matched on title/alt titles from Sonarr/Radarr plus season number or year (+-1).
   - Item ranking: release group > source family (BluRay/BrRip, WEB) > streaming service > resolution > codec, then a
     season pack covering all needed episodes, then "good" rating. For movies a runtime in the comment matching the file adds weight.
   - Downloads the zip (nested zip/rar supported), maps files to episodes by SxxEyy, decodes utf-8/cp1256/utf-16,
     checks it is really Persian, writes `<video>.fa.srt` owned by `SEEMORE_UID:SEEMORE_GID`.
4. Then Bazarr `scan-disk`, Jellyfin `Library/Media/Updated`, and a short note in the bot through seemore's hook
   (`http://seemore:3000/hook/<HOOK_KEY>/bazarr`).
5. Nothing found: retried after 6h, then every 12h. A new/upgraded file resets the item.
Every 6h a full sweep also re-scans items whose Bazarr subtitle state was never computed and assigns the default
language profile to items without one. subf2m requests are spaced 8s apart; 403/429/503 pauses subf2m for 30 min.

## Files
- `subfa/app/subfa.py` the service (Python stdlib only, runs on the Bazarr image's `/lsiopy/bin/python3`, so no
  extra image is pulled; override with `SUBFA_IMAGE`).
- Compose service `subfa` (profile `subfa`), `restart: always`, no published port; keys from the shared `.env`
  (`SONARR_KEY`, `RADARR_KEY`, `BAZARR_KEY`, `JELLYFIN_USER/PASS`, `HOOK_KEY`, `SUBFA_HOOK_KEY`).
- `state/subfa/state.json` per-item status (`bz` = Bazarr asked, `next` = next retry, `why`), cached subf2m pages.
- `state/subfa/overrides.json` runtime tuning written by the panel (Settings → subfa; class `reload`).
- Optional webhook from Radarr/Sonarr for instant reaction: `http://subfa:8090/hook/<SUBFA_HOOK_KEY>`.

## Commands (in the repo folder)
- Logs: `docker compose logs -f subfa`
- Dry run (downloads, writes nothing): `docker compose run --rm --no-deps -T subfa --dry-run --series "<Series>" --season 2 --include-present`
- Fill one title now, skipping the wait: `docker compose run --rm --no-deps -T subfa --movie "<Movie>" --now`
- Tunables (`.env` defaults, panel overrides): `SUBFA_POLL_SECONDS`, `SUBFA_SWEEP_SECONDS`, `SUBFA_BAZARR_GRACE`,
  `SUBFA_BACKOFF_HOURS`, `SUBFA_SUBF2M_GAP`, `SUBFA_NOTIFY`, and `ENABLED` (subf2m fallback on/off) in the panel.

## Limits
- Only subf2m is scraped. Titles absent there (or only listed under an odd name) wait for Bazarr's own providers.
- Sync is by release name, not audio; a subtitle for a different cut can be off. Fix by deleting the `.fa.srt` and
  setting `next` to 0 in state, or by picking another one in Bazarr.
- Multi-CD subtitles are skipped (CD2 files ignored).
