# Share links (`app/lib/links.js`, `linksui.js`)

Download links for one or several movies, episodes or complete seasons of one or several series, created from the
bot («🔗 لینک دانلود») or the panel (Links / Library selection). Permission `links`, feature `features.links`.

## Formats
* **ZIP** — streamed on the fly in *store* mode (video does not compress), zip64 when needed, exact
  `Content-Length`, HTTP **Range / resume**. The download starts immediately, needs no disk space for whole seasons,
  and a broken download can continue. CRC-32 values are computed while streaming and cached (`crc_cache`); a
  background worker pre-computes them so resumed downloads stay cheap.
* **RAR** (optional, `features.links_rar`) — built in the background with RARLAB `rar -m0` into `/data/dl-cache/<token>/`
  from hard links that keep the `Series/Season` folders; the page shows build progress; after a crash the build
  restarts from scratch (a half-built archive is never served); deleted when the link expires.
  Keeps `links.rar_min_free_mb` free. The `rar` binary is downloaded at image build time (`WITH_RAR=1`; RARLAB
  licence) and is not part of this repository.
* **file** — a single file with Range support.

## Options
Expiry (or none), maximum number of downloads, title; revoke at any time; change expiry; hit statistics.
Each link has a public URL (`links.public_base`, e.g. `https://dl.example.com/dl/<token>`) and a LAN URL
(`links.lan_base`) plus a landing page (`/dl/<token>/`) with a download button.

## Safety
* 128-bit random tokens; paths are resolved (`realpath`) and must stay under `/data/media`.
* Per-IP rate limit (`links.rate_per_min`), parallel downloads per IP (`links.max_parallel`), IP block after
  `links.bad_token_block` invalid tokens (10 min); expired / used / revoked links answer 410.
* Every request is logged (`link_hits`).

## Domains
`domains.dl_public` (HTTPS) and `domains.dl_lan` (plain HTTP for the home network) are generated into the Caddy snippet
([settings.md](settings.md)); both point at the link server on `DL_PORT`.

## API
`GET/POST /shares`, `GET/PATCH/DELETE /shares/{token}`; the files themselves: `GET /dl/{token}` on the link host.
