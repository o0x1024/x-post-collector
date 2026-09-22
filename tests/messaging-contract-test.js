"use strict";

// Regression test for the reported failures:
// 1) "A listener indicated an asynchronous response by returning true, but
//    the message channel closed before a response was received": content.js
//    answers synchronously, so its listener must return false; a late
//    answer on a closed channel must be swallowed instead of thrown.
// 2) Orphaned content instances (extension reloaded) must stop the
//    auto-scroll timer and release the singleton guard via the heartbeat.
// 3) background.js must answer once per request and never throw when the
//    caller's port has already closed.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const contentListeners = [];
const contentIntervals = [];
const contentCleared = [];

const contentSandbox = {
  console,
  chrome: {
    runtime: {
      id: "xpc-test",
      onMessage: { addListener: (listener) => contentListeners.push(listener) },
      sendMessage: () => Promise.resolve({ ok: true })
    },
    storage: { local: { get: () => {} } }
  },
  window: {
    location: { href: "https://x.com/messages", pathname: "/messages" },
    innerHeight: 900,
    addEventListener: () => {},
    setInterval: (callback) => contentIntervals.push(callback),
    clearInterval: (id) => contentCleared.push(id),
    setTimeout: () => 0,
    clearTimeout: () => {}
  },
  document: {
    querySelectorAll: () => [],
    body: {},
    createTreeWalker: () => ({ nextNode: () => null })
  },
  NodeFilter: { SHOW_TEXT: 4 }
};

const contentContext = vm.createContext(contentSandbox);
vm.runInContext(read("shared/utils.js"), contentContext);
vm.runInContext(read("shared/retry.js"), contentContext);
vm.runInContext(read("content.js"), contentContext);

assert.equal(contentListeners.length, 1, "content must register exactly one listener");
const onContentMessage = contentListeners[0];

// --- content.js: answering contract ---
// Every answer is produced synchronously and the listener must return false;
// returning true claimed an async response that never came, which Chrome
// reported as "message channel closed before a response was received".
const contentCases = [
  { type: "PING" },
  { type: "CONTENT_STATUS" },
  { type: "START_COLLECTING" },
  { type: "STOP_COLLECTING" },
  { type: "AUTO_SCROLL", enabled: true, intervalMs: 1500 },
  { type: "AUTO_SCROLL", enabled: false },
  { type: "SIMULATE_RATE_LIMIT" },
  { type: "APPLY_RETRY_SETTINGS", settings: { autoRetry: false, retryBaseSec: 30, retryMaxSec: 360 } },
  { type: "CAPTURE_RATE_LIMIT_DIAGNOSTICS" }
];
for (const message of contentCases) {
  let calls = 0;
  let payload = null;
  const returned = onContentMessage(message, {}, (response) => {
    calls += 1;
    payload = response;
  });
  assert.equal(returned, false, `content must not claim async for ${message.type}`);
  assert.equal(calls, 1, `content must answer ${message.type} exactly once`);
  assert.equal(Boolean(payload && payload.ok), true, `content must answer ok for ${message.type}`);
}
// A late answer on an already-closed channel must be swallowed, not thrown.
let escaped = 0;
try {
  onContentMessage({ type: "PING" }, {}, () => { throw new Error("channel closed"); });
} catch (_error) {
  escaped += 1;
}
assert.equal(escaped, 0, "closed content channel must not throw out of the listener");
// --- content.js: orphaned instance self-cleanup ---
const readStatus = () => {
  let status = null;
  onContentMessage({ type: "CONTENT_STATUS" }, {}, (response) => { status = response; });
  return status;
};
onContentMessage({ type: "START_COLLECTING" }, {}, () => {});
onContentMessage({ type: "AUTO_SCROLL", enabled: true, intervalMs: 1500 }, {}, () => {});
assert.equal(readStatus().autoScroll, true, "auto-scroll must run before the reload");
assert.equal(readStatus().active, true, "collector must run before the reload");
contentSandbox.chrome.runtime.id = undefined; // extension reloaded: context is gone
const scrollTimerId = contentIntervals.length;
contentIntervals[contentIntervals.length - 1](); // one auto-scroll tick on a dead context
assert.equal(vm.runInContext("globalThis.__XPC_CONTENT_ACTIVE__", contentContext), null,
  "orphan must release the singleton guard");
assert.ok(contentCleared.includes(scrollTimerId), "orphan must clear its auto-scroll timer");
assert.equal(readStatus().autoScroll, false, "orphan must stop auto-scrolling");
assert.equal(readStatus().active, false, "orphan must stop collecting");
contentIntervals[0](); // heartbeat tick on a dead context
assert.ok(contentCleared.includes(1), "orphan heartbeat must clear itself");
// --- background.js: single guarded response per request ---
const backgroundListeners = [];
let sentMessages = [];
const backgroundSandbox = {
  console,
  structuredClone,
  setTimeout: () => 0,
  clearTimeout: () => {},
  chrome: {
    runtime: {
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: (listener) => backgroundListeners.push(listener) },
      sendMessage: (message) => {
        sentMessages.push(message);
        return Promise.resolve();
      }
    },
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve()
      }
    },
    action: {
      setBadgeBackgroundColor: () => Promise.resolve(),
      setBadgeText: () => Promise.resolve()
    },
    tabs: {
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      query: () => Promise.resolve([
        { id: 1, url: "https://x.com/home" },
        { id: 2, url: "https://x.com/explore" }
      ]),
      sendMessage: (tabId, message) => {
        sentMessages.push({ tabId, message });
        return Promise.resolve({ ok: true });
      }
    },
    scripting: { executeScript: () => Promise.resolve([]) },
    sidePanel: { setPanelBehavior: () => Promise.resolve() }
  }
};
const backgroundContext = vm.createContext(backgroundSandbox);
vm.runInContext(read("background.js"), backgroundContext);
assert.equal(backgroundListeners.length, 1, "background must register one listener");
const onBackgroundMessage = backgroundListeners[0];
const waitTick = () => new Promise((resolve) => setImmediate(resolve));
(async () => {
  let closedEscaped = 0;
  try {
    onBackgroundMessage({ type: "GET_STATE" }, {}, () => { throw new Error("channel closed"); });
  } catch (_error) {
    closedEscaped += 1;
  }
  assert.equal(closedEscaped, 0, "closed background channel must be swallowed");
  await waitTick();
  sentMessages = [];
  let answers = 0;
  let lastPayload = null;
  onBackgroundMessage({ type: "SET_AUTO_SCROLL", enabled: false }, {}, (payload) => {
    answers += 1;
    lastPayload = payload;
  });
  await waitTick();
  await waitTick();
  assert.equal(answers, 1, "background must answer SET_AUTO_SCROLL exactly once");
  assert.equal(lastPayload?.ok, true, "background must acknowledge the stop");
  const tabStops = sentMessages.filter((entry) => entry.tabId);
  assert.equal(tabStops.length, 2, "both X tabs must receive the stop");
  for (const entry of tabStops) {
    assert.equal(entry.message.type, "AUTO_SCROLL");
    assert.equal(entry.message.enabled, false);
  }
  console.log("x-post-collector messaging contract test passed");
})().catch((error) => {
  console.error(String((error && error.stack) || error));
  process.exit(1);
});
