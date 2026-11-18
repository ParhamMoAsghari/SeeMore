# Imports from a drive (`app/lib/importer.js`, `importui.js`)

Bring movies and series from a drive into the archive so they look exactly like downloaded ones (same naming and
folders, history in Radarr/Sonarr, subtitles next to the video, Jellyfin refreshed). Everything else on the drive
is copied to a separate folder on the server.

## Pipeline
`Scan → Classify → Identify → Match → Deduplicate → Review → Import`

1. **Scan** a drive folder (system folders such as `System Volume Information`, `$RECYCLE.BIN`, `.Trash*` skipped).
2. **Classify** each file: video, subtitle (language from the name: `fa/fas/per/farsi/فارسی`, `en`, …), sample /
   extras (trailers, featurettes, `Sample/`), other.
3. **Identify** from the file and folder names (release junk stripped, Persian digits and names such as
   `فصل ۱/قسمت 2` understood, `SxxEyy`, `1x02`, year) plus **MediaInfo/ffprobe** (duration, resolution).
4. **Match** against Radarr / Sonarr lookup (their own metadata proxies — TMDB is never called directly, which matters
   where TMDB is filtered). Each match has a confidence; low-confidence items must be confirmed or re-matched by the
   user (`rematch`).
5. **Deduplicate** inside the drive and against the library: items already in the archive are flagged `dup` and
   skipped by default (can be set to replace).
6. **Review** in the bot (wizard) or the panel (Drives → import): titles, seasons/episodes, subtitles, other files,
   sizes; then confirm.
7. **Import** as a durable `import` job: files are copied to `/data/usb-imports/.staging/<job>/` (same filesystem as
   the library) and verified; the post phase (idempotent) then
   * adds missing titles to Radarr/Sonarr **unmonitored, without searching**,
   * runs Radarr/Sonarr **ManualImport** (import mode *move*, so naming and history stay consistent), waiting for
     running refresh/rescan of the title first (`settle()`), with a fallback of direct placement + rescan,
   * places subtitles next to the final file with language tags,
   * copies other files to `/data/usb-imports/<drive>/<date>/…` keeping their relative paths,
   * triggers a Bazarr disk scan and a Jellyfin library refresh, and reports a summary.

The source drive is never modified by an import.

## Failure handling
* Crash/power loss during staging → normal job recovery ([job-engine.md](job-engine.md)).
* Radarr/Sonarr lost **after** the import succeeded but before seemore recorded it → the saved command id and the
  *arr file records are checked on recovery; nothing is imported twice (TESTS.md T7).

## API
`POST /storage/imports/scans` (scan, optionally `dry`), `POST /storage/imports/scans/{id}/rematch`,
`POST /storage/imports` (start the job from a reviewed scan). Permission `usb_import`, feature `features.usb_import`.
