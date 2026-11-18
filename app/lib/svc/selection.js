'use strict';
// Library selection -> concrete files (videos + subtitles next to them), shared by "copy to drive"
// and "download links". Based on the filesystem library scan (usb.library) so the folder layout on the
// drive / inside the archive is the archive layout: "<Movie (Year)>/file", "<Series>/Season 01/file".
//
// sel = {
//   movies: ["Movie (2020)", ...],                        folder names
//   series: [{ name: "Show", seasons: [1,2] },            whole seasons
//            { name: "Show", eps: ["/data/media/tv/..."] } or explicit episode files (absolute src paths)
//            { name: "Show" }]                            the whole series
//   subs: true                                            include subtitles (default true)
// }
const S = require('../usb');

async function resolve(sel = {}) {
  const lib = await S.library();
  const withSubs = sel.subs !== false;
  const files = []; const titles = [];
  const push = (f, dir) => {
    files.push({ src: f.src, size: f.size, dst: `${dir}/${f.name}`, arc: `${dir}/${f.name}` });
    if (withSubs) for (const s of f.subs || []) files.push({ src: s.src, size: s.size, dst: `${dir}/${s.name}`, arc: `${dir}/${s.name}`, sub: true });
  };
  for (const name of sel.movies || []) {
    const mv = lib.m.find((x) => x.name === name); if (!mv) continue;
    for (const f of mv.files) push(f, mv.name);
    titles.push(`🎬 ${mv.name}`);
  }
  for (const s of sel.series || []) {
    const sr = lib.s.find((x) => x.name === s.name); if (!sr) continue;
    let eps = sr.eps;
    if (Array.isArray(s.eps) && s.eps.length) { const want = new Set(s.eps); eps = eps.filter((e) => want.has(e.src)); }
    else if (Array.isArray(s.seasons) && s.seasons.length) { const want = new Set(s.seasons.map(Number)); eps = eps.filter((e) => want.has(e.s)); }
    for (const e of eps) push(e, e.rel ? `${sr.name}/${e.rel}` : `${sr.name}/Season ${String(e.s).padStart(2, '0')}`);
    const ss = [...new Set(eps.map((e) => e.s))];
    if (eps.length) titles.push(`📺 ${sr.name} · ${eps.length} قسمت${ss.length === 1 ? ` از فصل ${ss[0]}` : ss.length > 1 ? ` از ${ss.length} فصل` : ''}`);
  }
  const title = titles.length <= 2 ? titles.join(' + ') : `${titles.slice(0, 2).join(' + ')} + ${titles.length - 2} مورد دیگر`;
  return { title, files };
}
module.exports = { resolve };
