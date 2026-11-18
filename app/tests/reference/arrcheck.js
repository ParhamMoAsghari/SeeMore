'use strict';
// Snapshot of Radarr/Sonarr state for the crash tests: titles, file records, import history counts.
// usage: node tests/arrcheck.js [titleRegex]
const { radarr, sonarr } = require('../../lib/clients');
const re = new RegExp(process.argv[2] || '.', 'i');
(async () => {
  const movies = await radarr.get('/movie');
  for (const m of movies.filter((x) => re.test(x.title))) {
    const files = await radarr.get(`/moviefile?movieId=${m.id}`);
    const h = await radarr.get(`/history/movie?movieId=${m.id}`).catch(() => []);
    const imp = h.filter((e) => /Imported/i.test(e.eventType)).length;
    console.log(`R movie ${m.id} "${m.title}" (${m.year}) monitored=${m.monitored} files=${files.length} [${files.map((f) => `${f.relativePath}:${f.size}`).join(', ')}] importEvents=${imp} path=${m.path}`);
  }
  const series = await sonarr.get('/series');
  for (const s of series.filter((x) => re.test(x.title))) {
    const files = await sonarr.get(`/episodefile?seriesId=${s.id}`);
    const h = await sonarr.get(`/history/series?seriesId=${s.id}`).catch(() => []);
    const imp = h.filter((e) => /Imported/i.test(e.eventType)).length;
    console.log(`S series ${s.id} "${s.title}" monitored=${s.monitored} episodeFiles=${files.length} importEvents=${imp} [${files.map((f) => f.relativePath).join(' | ')}]`);
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
