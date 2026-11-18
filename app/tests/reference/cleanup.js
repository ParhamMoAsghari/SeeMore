'use strict';
// Removes the crash-test items from Radarr/Sonarr (only the exact test titles / test files).
const { radarr, sonarr } = require('../../lib/clients');
(async () => {
  for (const m of await radarr.get('/movie')) {
    if (m.title === 'Night of the Living Dead' && m.year === 1968) { await radarr.del(`/movie/${m.id}?deleteFiles=true&addImportExclusion=false`); console.log('radarr: deleted test movie', m.id, m.path); }
  }
  for (const s of await sonarr.get('/series')) {
    if (s.title === 'Sherlock') { await sonarr.del(`/series/${s.id}?deleteFiles=true&addImportListExclusion=false`); console.log('sonarr: deleted test series', s.id, s.path); }
    if (s.title === 'The Great') {
      for (const f of await sonarr.get(`/episodefile?seriesId=${s.id}`)) if (/The\.Great\.S0[12]E01\.1080p\.WEB\.mkv$/.test(f.relativePath)) { await sonarr.del(`/episodefile/${f.id}`); console.log('sonarr: deleted test episode file', f.relativePath); }
    }
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
