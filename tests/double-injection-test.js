"use strict";

// Regression test for the double-reporting bug: a duplicated content.js
// injection used to leave two live collectors in one page, so every post was
// reported twice and the background counted one copy as "duplicate".
//
// Covers: (1) a second evaluation must be inert; (2) when the extension
// reloads, the stale instance's heartbeat must release the singleton guard
// so a recovery injection can take over.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const messageListeners = [];
const intervalCallbacks = [];
const clearedIntervalIds = [];

const sandbox = {
  console,
  chrome: {
    runtime: {
      id: "xpc-test",
      onMessage: { addListener: (listener) => messageListeners.push(listener) },
      sendMessage: () => Promise.resolve({ ok: true })
    },
    storage: { local: { get: () => {} } }
  },
  window: {
    location: { href: "https://x.com/home", pathname: "/home" },
    innerHeight: 900,
    addEventListener: () => {},
    setInterval: (callback) => intervalCallbacks.push(callback),
    clearInterval: (id) => clearedIntervalIds.push(id),
    setTimeout: () => 0,
    clearTimeout: () => {}
  },
  document: { querySelectorAll: () => [] }
};

const context = vm.createContext(sandbox);
vm.runInContext(read("shared/utils.js"), context);
vm.runInContext(read("shared/retry.js"), context);
vm.runInContext(read("content.js"), context);

assert.equal(messageListeners.length, 1, "first load must register exactly one listener");
const tokenAfterFirst = vm.runInContext("globalThis.__XPC_CONTENT_ACTIVE__", context);
assert.ok(tokenAfterFirst, "first load must claim the singleton guard");

vm.runInContext(read("content.js"), context);
assert.equal(messageListeners.length, 1, "duplicate load must not register a second listener");
assert.strictEqual(
  vm.runInContext("globalThis.__XPC_CONTENT_ACTIVE__", context),
  tokenAfterFirst,
  "duplicate load must not replace the guard token"
);

// Simulate an extension reload: the old chrome.* context dies and the
// heartbeat must release the guard. intervalCallbacks[0] is the heartbeat
// (intervalCallbacks[1] is the rate-limit poll registered at load).
sandbox.chrome.runtime.id = undefined;
assert.equal(intervalCallbacks.length, 2, "first load must schedule heartbeat + rate-limit poll");
intervalCallbacks[0]();
assert.equal(
  vm.runInContext("globalThis.__XPC_CONTENT_ACTIVE__", context),
  null,
  "dead-context heartbeat must release the guard"
);
assert.equal(clearedIntervalIds.length, 1, "heartbeat must stop itself after releasing");

// The new extension context is alive again; recovery injection must take over.
sandbox.chrome.runtime.id = "xpc-test";
vm.runInContext(read("content.js"), context);
assert.equal(messageListeners.length, 2, "recovery injection must be able to take over");
assert.ok(vm.runInContext("globalThis.__XPC_CONTENT_ACTIVE__", context), "recovery load must claim a fresh guard");

console.log("x-post-collector double-injection test passed");
