'use strict';
// Maintenance helpers run inside the container: node bot.js --selftest | --demo | --announce
const M = require('./lib/media');
const V = require('./lib/views');
const U = require('./lib/util');

module.exports = async function tools(mode, args, { bale, store, h, notify, backup }) {
  const ok = (n, v) => console.log(`OK   ${n}${v ? ': ' + v : ''}`);
  const bad = (n, e) => console.log(`FAIL ${n}: ${U.redact(e.message || e)}`);
  const step = async (n, fn) => { try { ok(n, await fn()); } catch (e) { bad(n, e); } };
  if (mode === '--selftest') {
    // read-only checks of every data function
    let items;
    await step('search "The Pianist"', async () => { const r = await M.search('The Pianist', 'all'); items = r.items; return `${r.items.length} results, errors=${r.errors.length}`; });
    await step('search "Breaking Bad"', async () => { const r = await M.search('Breaking Bad', 'all'); return `${r.items.length} results, first=${r.items[0] && r.items[0].title}`; });
    await step('caption render', async () => V.caption(items[0]).length + ' chars');
    await step('poster', async () => { const b = await M.posterBuffer(items[0]); return b ? b.length + ' bytes' : 'none'; });
    await step('quality options', async () => JSON.stringify({ m: (await M.qualityOptions('m')).map((x) => x.name), s: (await M.qualityOptions('s')).map((x) => x.name) }));
    await step('library m/s', async () => { const m = await M.libraryList('m'), s = await M.libraryList('s'); return `${m.length} movies, ${s.length} series`; });
    await step('downloads', async () => { const d = await M.downloads(); return `${d.items.length} items; text ${V.dlText(d).length} chars`; });
    await step('calendar 7/30', async () => { const a = await M.calendar(7), b = await M.calendar(30); return `${a.days.length}/${b.days.length} days`; });
    await step('recent', async () => { const r = await M.recent(); return `${r.imported.length} imported, ${r.added.length} added`; });
    await step('server', async () => { const s = await M.server(); return V.srvText(s).length + ' chars, services ok=' + s.services.filter((x) => x[1].ok).length + '/' + s.services.length; });
    await step('lib card (first library movie)', async () => { const first = (await M.libraryList('m'))[0]; if (!first) return 'skipped: empty library'; const id = first.libId; const o = await M.libObj('m', id); const bz = await M.subtitles('m', id); return V.libCaption('m', o, { bz, profile: 'x' }).length + ' chars, bazarr=' + JSON.stringify(bz); });
    await step('jellyfin link', async () => JSON.stringify(await M.jfLink('m', { title: 'The Pianist', year: 2002, tmdbId: 423 })));
    process.exit(0);
  }
  if (mode === '--demo') {
    // sends a couple of real views to the owner chat (read-only actions)
    const fake = (text) => ({ text, chat: { id: bale.owner, type: 'private' }, from: { id: bale.owner } });
    for (const t of args) { await h.onUpdate({ update_id: 0, message: fake(t) }); await U.sleep(1500); }
    h.stopLive();
    process.exit(0);
  }
  if (mode === '--backup') { console.log((await backup(true)) || 'backup failed'); process.exit(0); }
  if (mode === '--announce') {
    await bale.send(args.join(' ') || V.helpFor(require('./lib/perms').permsOf(bale.owner)), V.menuKb(require('./lib/perms').permsOf(bale.owner)));
    process.exit(0);
  }
};
