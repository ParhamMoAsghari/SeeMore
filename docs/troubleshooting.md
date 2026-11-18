# Troubleshooting

| symptom | check / fix |
|---|---|
| bot does not answer | `docker compose logs --tail=100 seemore`: `bot ready as @…` must appear. Token: the variable named by `BOT_TOKEN_ENV` must be set. Your id must equal `ALLOWED_CHAT` (strangers get only `acl.refusal_text`). |
| `poll error: … network` in the logs | the Bot API is unreachable from the host (filtering?) — see [iran.md](iran.md), `TELEGRAM_API_BASE`, or Bale. |
| `409 Conflict: can't use getUpdates … webhook is active` | another program set a webhook; polling mode deletes it at start — restart seemore, or set `bot.update_mode=webhook`. |
| webhook mode gets nothing | `getWebhookInfo` errors are logged as `webhook: …`; check that `BOT_WEBHOOK_URL` is public HTTPS and proxied to `seemore:BOT_WEBHOOK_PORT` with the same path. |
| seemore *unhealthy* | `:3000/health` fails when long polling has stalled ~150 s (messenger unreachable) or `:3002/healthz` fails (API). Logs tell which. |
| panel login fails for the owner | user = `PANEL_OWNER_USER`; password = value of the variable named by `PANEL_OWNER_PASS_ENV`; log line `panel: no owner password secret set` means it is empty. After 5 failures the account is locked for 15 min (`panel.lock_*`). |
| panel domain not reachable | Settings → Domains saved? `state/caddy-sites/seemore.caddy` exists? `docker compose logs caddy` for ACME errors; DNS must point at the host and 80/443 must be open. |
| settings change says `host helper not installed` | install `seemore-ctl` (`sudo make host`) or apply that value via `.env` ([settings.md](settings.md)). |
| drive not detected | `journalctl -t usb-automount -b`; `systemctl status 'usb-mount@*'`; `ls /run/usb-automount/drives`; is the device USB/removable (`lsblk -o NAME,TRAN,RM`)? `usb.ignore_label_regex` hiding it? |
| drive visible on host but not in seemore | the container needs `rslave` propagation on `SEEMORE_USB_ROOT`; restart seemore once after installing the host helper. |
| copy refuses files on FAT32 | files ≥ 4 GiB do not fit FAT32 — reformat as exFAT or NTFS. |
| job stays `waiting_for_device` | it waits for the *same* drive (marker/serial/PARTUUID). Plug that drive in, or cancel the job in Jobs. |
| RAR links fail | `rar` missing in the image (`WITH_RAR=0` or download failed at build) — rebuild with `WITH_RAR=1` or disable `features.links_rar`. |
| import matched the wrong title | use rematch in the review step; low-confidence matches always need confirmation. |
| no Persian subtitles | `docker compose logs subfa`; Bazarr language profile includes Persian? `subfa.ENABLED`? subf2m pauses 30 min after 403/429. |
| restart a service | panel → Health → Containers (only names in `ctl.restartable`), or `docker compose restart <svc>`. |

Logs in the panel are redacted (tokens, keys, passwords). When asking for help, never paste `.env` or
`docker compose config` output.
