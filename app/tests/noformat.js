'use strict';
// Guard test: seemore must never format, repartition or wipe a drive.
// Scans the production code (app/lib, app/*.js, host/ scripts, panel/src) for any invocation of a
// formatting / partitioning / wiping tool. Comments are ignored; test fixtures (app/tests) are excluded
// because they build loop images. Also checks that the host helper defines its runtime block-list.
//   node app/tests/noformat.js [repoRoot]      exit 0 = PASS
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const BAD = /(^|[^\w.-])(mkfs(\.\w+)?|mke2fs|mkntfs|mkdosfs|mkexfatfs|wipefs|parted|[cs]?fdisk|sgdisk|gdisk|blkdiscard|shred|BLKDISCARD|BLKSECDISCARD)(?=$|[^\w.-])|\bdd\s+[^\n]*\bof=\/dev\//;
const roots = ['app/lib', 'app/bot.js', 'app/tools.js', 'host', 'panel/src'];
const skip = (p) => /node_modules|\/tests\/|\.(png|svg|ico|lock)$/.test(p);
const files = [];
const walk = (p) => { let st; try { st = fs.statSync(p); } catch { return; } if (st.isDirectory()) { for (const n of fs.readdirSync(p)) walk(path.join(p, n)); } else if (!skip(p)) files.push(p); };
for (const r of roots) walk(path.join(root, r));
const hits = [];
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => {
    let code = l.replace(/(^|\s)#.*$/, '').replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
    if (/runtime guard|for _c in |BLOCKED: /.test(l)) return; // the block-list itself
    if (BAD.test(code)) hits.push(`${path.relative(root, f)}:${i + 1}: ${l.trim().slice(0, 140)}`);
  });
}
const helper = path.join(root, 'host/usb-automount/usb-automount');
const guard = fs.existsSync(helper) && /for _c in mkfs .*wipefs parted fdisk sfdisk/.test(fs.readFileSync(helper, 'utf8'));
console.log(`scanned ${files.length} files`);
if (hits.length) { console.log('FAIL format/partition/wipe call found:\n' + hits.join('\n')); process.exit(1); }
if (!guard) { console.log('FAIL host helper runtime block-list missing'); process.exit(1); }
console.log('PASS no code path formats, repartitions or wipes a drive; host helper blocks these tools at runtime');
