'use strict';
// Per-request context (which messenger chat/user an action runs for). Everything that sends messages
// reads the chat from here, so the same handlers serve the owner and granted users.
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
const run = (c, fn) => als.run(c, fn);
const get = () => als.getStore() || null;
const chat = () => (get() && get().chat) || null;
const uid = () => (get() && get().uid) || null;
module.exports = { run, get, chat, uid };
