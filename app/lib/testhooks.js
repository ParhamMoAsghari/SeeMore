'use strict';
// Fault-injection hooks for crash tests. Inert unless SM_TEST_HOOKS=1 (never set in production).
//   SM_PAUSE_<NAME>=ms   sleep at hook NAME (e.g. SM_PAUSE_COPY_CHUNK=200)
//   SM_CRASH_AT=<name>   SIGKILL this process the first time hook <name> is reached
//                        (a marker file in SM_TEST_DIR makes it one-shot across restarts)
const fs = require('fs');
const path = require('path');
const ON = process.env.SM_TEST_HOOKS === '1';
async function hook(name) {
  if (!ON) return;
  const ms = Number(process.env[`SM_PAUSE_${name.toUpperCase()}`] || 0);
  if (ms) await new Promise((r) => setTimeout(r, ms));
  if (process.env.SM_CRASH_AT === name) {
    const mark = path.join(process.env.SM_TEST_DIR || '/tmp', `crashed-${name}`);
    if (!fs.existsSync(mark)) { fs.writeFileSync(mark, String(Date.now())); console.log(`TESTHOOK crash at ${name}`); process.kill(process.pid, 'SIGKILL'); }
  }
}
module.exports = { hook, ON };
