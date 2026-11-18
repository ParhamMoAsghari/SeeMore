'use strict';
// Run a send-function once per recipient (owner + active users holding perm), each in its own chat context.
const P = require('./perms');
const ctx = require('./ctx');
async function fan(perm, fn) {
  let first;
  for (const uid of P.recipients(perm)) {
    try { const r = await ctx.run({ chat: uid, uid }, fn); if (first === undefined) first = r; } catch {}
  }
  return first;
}
const asUser = (uid, fn) => ctx.run({ chat: uid, uid }, fn);
module.exports = { fan, asUser };
