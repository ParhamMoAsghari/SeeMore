'use strict';
// Library details for the API (movies / series -> seasons -> episodes, files, subtitles).
const fs = require('fs');
const path = require('path');
const { radarr, sonarr, bazarr } = require('../clients');
const M = require('../media');
const S = require('../usb');

const subsNear = (file) => {
  try {
    const dir = path.dirname(file); const base = path.basename(file).replace(/\.[^.]+$/, '');
    return fs.readdirSync(dir).filter((n) => S.SUBS.test(n) && n.startsWith(base + '.')).map((n) => {
      const m = n.slice(base.length + 1).replace(/\.[^.]+$/, '').split('.');
      return { name: n, lang: m.find((x) => /^[a-z]{2,3}$/i.test(x)) || '', forced: m.includes('forced') };
    });
  } catch { return []; }
};
const qName = (f) => (f && f.quality && f.quality.quality && f.quality.quality.name) || '';

async function movie(id) {
  const o = await radarr.get(`/movie/${Number(id)}`);
  const it = M.normMovie(o);
  const f = o.movieFile || null;
  const file = f ? { id: f.id, path: f.path, rel: f.relativePath, size: f.size, quality: qName(f), added: f.dateAdded,
    video: f.mediaInfo ? { codec: f.mediaInfo.videoCodec, res: f.mediaInfo.resolution, hdr: f.mediaInfo.videoDynamicRangeType || '', runtime: f.mediaInfo.runTime, audio: f.mediaInfo.audioLanguages, subs: f.mediaInfo.subtitles } : null,
    externalSubs: subsNear(f.path) } : null;
  return { ...it, path: o.path, monitored: o.monitored, file, subtitles: await M.subtitles('m', id), folder: o.path ? path.basename(o.path) : null };
}

async function series(id) {
  id = Number(id);
  const [o, eps, files] = await Promise.all([sonarr.get(`/series/${id}`), sonarr.get(`/episode?seriesId=${id}`), sonarr.get(`/episodefile?seriesId=${id}`)]);
  const it = M.normSeries(o);
  const fmap = new Map(files.map((f) => [f.id, f]));
  let bz = new Map();
  try {
    const d = await bazarr.get(`/episodes?seriesid%5B%5D=${id}`, { tries: 1 });
    bz = new Map(((d && d.data) || []).map((e) => [e.sonarrEpisodeId, e]));
  } catch {}
  const seasons = new Map();
  for (const e of eps) {
    if (!seasons.has(e.seasonNumber)) seasons.set(e.seasonNumber, []);
    const f = e.episodeFileId ? fmap.get(e.episodeFileId) : null;
    const b = bz.get(e.id);
    seasons.get(e.seasonNumber).push({
      id: e.id, s: e.seasonNumber, e: e.episodeNumber, title: e.title, air: e.airDateUtc || null, monitored: e.monitored, hasFile: !!e.hasFile,
      file: f ? { id: f.id, path: f.path, size: f.size, quality: qName(f), externalSubs: subsNear(f.path) } : null,
      subs: b ? { have: (b.subtitles || []).map((x) => x.code2 || x.name).filter(Boolean), missing: (b.missing_subtitles || []).map((x) => x.code2 || x.name).filter(Boolean) } : null,
    });
  }
  const out = [...seasons.entries()].sort((a, b) => a[0] - b[0]).map(([n, list]) => {
    list.sort((a, b) => a.e - b.e);
    const so = (o.seasons || []).find((x) => x.seasonNumber === n) || {};
    return { n, monitored: !!so.monitored, eps: list, have: list.filter((x) => x.hasFile).length, total: list.length, size: list.reduce((a, x) => a + (x.file ? x.file.size : 0), 0) };
  });
  return { ...it, path: o.path, monitored: o.monitored, folder: o.path ? path.basename(o.path) : null, seasons: out, subtitles: await M.subtitles('s', id) };
}

module.exports = { movie, series, subsNear };
