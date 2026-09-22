"use strict";

// Regression test for the reported failure:
//   Uncaught Error: Extension context invalidated.
//   at content.js (emitPost) <- (observeArticle) <- (observeAllArticles) <- (anonymous callback)
//
// When the extension is reloaded/updated, the page keeps running the previous
// content-script instance ("orphan") whose chrome.* bindings are dead. X's SPA
// keeps mutating the DOM, so the orphan's MutationObserver / IntersectionObserver
// callbacks used to keep reaching emitPost -> chrome.runtime.sendMessage, which
// throws "Extension context invalidated" synchronously and surfaced as an
// uncaught page error.
//
// The fixed collector must:
//   1) self-clean on its first activity after the context dies (not wait for the
//      heartbeat) and never attempt a chrome.* call on a dead context;
//   2) bail out silently when injected into an already-dead context, without
//      registering timers/listeners, reading storage or throwing;
//   3) release the singleton guard so a recovery injection can take over.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

class FakeElement {}

function makeArticle(statusId) {
  const article = new FakeElement();
  article.dataset = {};
  article.innerText = `post ${statusId}`;
  article.parentElement = null;
  article.scrollTop = 0;
  article.scrollHeight = 5000;
  article.clientHeight = 900;
  article.__scrollable = true;
  article.scrollBy = () => {};
  article.getBoundingClientRect = () => ({ width: 120, height: 40, top: 10, bottom: 50, left: 0, right: 120 });
  article.querySelectorAll = (selector) => {
    if (selector === 'a[href*="/status/"]') {
      return [{ getAttribute: () => `https://x.com/u/status/${statusId}` }];
    }
    return [];
  };
  article.querySelector = (selector) => {
    if (selector === '[data-testid="tweetText"]') return { textContent: `post ${statusId}` };
    return null;
  };
  return article;
}

function createEnvironment() {
  const caps = {
    messageListeners: [],
    intervals: [],
    clearedIntervals: [],
    timeouts: [],
    sentMessages: [],
    deadAttempts: 0,
    storageGets: 0,
    observerDisconnects: { mutation: 0, intersection: 0 }
  };
  const articles = [makeArticle("1234567890")];

  const MutationObserverStub = class {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      caps.mutationObserver = this;
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
      caps.observerDisconnects.mutation += 1;
    }
  };
  const IntersectionObserverStub = class {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      caps.intersectionObserver = this;
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
      caps.observerDisconnects.intersection += 1;
    }
  };

  const sandbox = {
    console,
    URL,
    Element: FakeElement,
    chrome: {
      runtime: {
        id: "xpc-test",
        onMessage: { addListener: (listener) => caps.messageListeners.push(listener) },
        sendMessage: (message) => {
          if (!sandbox.chrome.runtime.id) {
            caps.deadAttempts += 1;
            throw new Error("Extension context invalidated.");
          }
          caps.sentMessages.push(message);
          return Promise.resolve({ ok: true });
        }
      },
      storage: {
        local: {
          get: () => {
            caps.storageGets += 1;
            if (!sandbox.chrome.runtime.id) throw new Error("Extension context invalidated.");
          }
        }
      }
    },
    window: {
      location: { href: "https://x.com/home", pathname: "/home" },
      innerHeight: 900,
      addEventListener: () => {},
      getComputedStyle: (element) => ({
        display: "block",
        visibility: "visible",
        opacity: "1",
        overflowY: element && element.__scrollable ? "auto" : "visible"
      }),
      setInterval: (callback) => caps.intervals.push(callback),
      clearInterval: (id) => caps.clearedIntervals.push(id),
      setTimeout: (callback) => caps.timeouts.push(callback),
      clearTimeout: () => {}
    },
    document: {
      documentElement: {},
      scrollingElement: null,
      querySelectorAll: (selector) => {
        if (selector === "article") return articles.slice();
        if (selector === 'article[data-xpc-observed="1"]') {
          return articles.filter((article) => article.dataset.xpcObserved === "1");
        }
        return [];
      }
    },
    MutationObserver: MutationObserverStub,
    IntersectionObserver: IntersectionObserverStub
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(read("shared/utils.js"), context);
  vm.runInContext(read("shared/retry.js"), context);
  return { sandbox, context, caps, articles };
}
// --- Scenario A: the reported chain -----------------------------------------
// The extension reloads while X keeps mutating; the orphan's observer
// callbacks must self-clean without throwing and without any chrome.* contact.
const a = createEnvironment();
vm.runInContext(read("content.js"), a.context);
assert.equal(a.caps.messageListeners.length, 1, "content must register exactly one listener");
assert.ok(vm.runInContext("globalThis.__XPC_CONTENT_ACTIVE__", a.context), "live load must claim the guard");

let startPayload = null;
a.caps.messageListeners[0]({ type: "START_COLLECTING" }, {}, (payload) => { startPayload = payload; });
assert.equal(startPayload.ok, true, "START_COLLECTING must answer ok");
assert.equal(startPayload.active, true, "collector must start");
assert.equal(a.caps.sentMessages.length, 1, "the visible post must be reported once");
assert.equal(a.caps.sentMessages[0].type, "POST_FOUND");

// Reload: chrome.runtime.id disappears; every chrome.* call on the orphan
// now throws, exactly like a real invalidated context.
a.sandbox.chrome.runtime.id = undefined;

let escaped = null;
try {
  a.caps.mutationObserver.callback(); // MutationObserver -> observeAllArticles -> observeArticle -> emitPost
} catch (error) {
  escaped = error;
}
assert.equal(escaped, null, "orphan observer activity must not throw");
assert.equal(a.caps.deadAttempts, 0, "no chrome.* call may be attempted on a dead context");
assert.equal(vm.runInContext("globalThis.__XPC_CONTENT_ACTIVE__", a.context), null,
  "orphan must release the singleton guard on first activity");
assert.equal(a.caps.mutationObserver.disconnected, true, "orphan must disconnect its MutationObserver");
assert.equal(a.caps.intersectionObserver.disconnected, true, "orphan must disconnect its IntersectionObserver");

// X keeps mutating after the cleanup: repeated callbacks must stay inert.
escaped = null;
try {
  a.caps.mutationObserver.callback();
  a.caps.intersectionObserver.callback([{ isIntersecting: true, target: a.articles[0] }]);
} catch (error) {
  escaped = error;
}
assert.equal(escaped, null, "repeated observer activity must stay inert");
assert.equal(a.caps.deadAttempts, 0, "no chrome.* call may be attempted on a dead context");

// Recovery: a fresh injection takes over and reports again.
a.sandbox.chrome.runtime.id = "xpc-test";
vm.runInContext(read("content.js"), a.context);
assert.equal(a.caps.messageListeners.length, 2, "recovery injection must register a listener");
assert.ok(vm.runInContext("globalThis.__XPC_CONTENT_ACTIVE__", a.context), "recovery load must claim a fresh guard");
let resumePayload = null;
a.caps.messageListeners[1]({ type: "START_COLLECTING" }, {}, (payload) => { resumePayload = payload; });
assert.equal(resumePayload.active, true, "recovery collector must start");
assert.equal(a.caps.sentMessages.length, 2, "recovery collector must report the post again");
assert.equal(a.caps.sentMessages[1].type, "POST_FOUND");
// --- Scenario B: injection into an already-dead context ---------------------
// The background fallback can inject while the extension is mid-reload; the
// script must bail out silently instead of throwing on chrome.* access.
const b = createEnvironment();
b.sandbox.chrome.runtime.id = undefined;
let loadError = null;
try {
  vm.runInContext(read("content.js"), b.context);
} catch (error) {
  loadError = error;
}
assert.equal(loadError, null, "dead-context injection must not throw");
assert.equal(b.caps.messageListeners.length, 0, "dead-context injection must not register a listener");
assert.equal(b.caps.storageGets, 0, "dead-context injection must not read storage");
assert.equal(b.caps.intervals.length, 0, "dead-context injection must not schedule timers");
assert.ok(!vm.runInContext("globalThis.__XPC_CONTENT_ACTIVE__", b.context),
  "dead-context injection must not claim the guard");

// --- Scenario C: the last unguarded entry point (auto-scroll settle scan) ---
// scanVisiblePosts() runs inside a setTimeout after a scroll; if the context
// dies in between, emitPost's own guard must catch the dead context.
const c = createEnvironment();
vm.runInContext(read("content.js"), c.context);
c.caps.messageListeners[0]({ type: "START_COLLECTING" }, {}, () => {});
c.caps.messageListeners[0]({ type: "AUTO_SCROLL", enabled: true, intervalMs: 1500 }, {}, () => {});
c.caps.intervals[c.caps.intervals.length - 1](); // alive tick -> schedules the settle scan
assert.equal(c.caps.timeouts.length, 1, "the settle scan must be scheduled exactly once");

c.sandbox.chrome.runtime.id = undefined;
c.articles.push(makeArticle("999")); // a new post appears after the reload
let settleEscaped = null;
try {
  c.caps.timeouts[0](); // settle scan -> scanVisiblePosts -> emitPost
} catch (error) {
  settleEscaped = error;
}
assert.equal(settleEscaped, null, "dead-context settle scan must not throw");
assert.equal(c.caps.deadAttempts, 0, "no chrome.* call may be attempted on a dead context");
assert.equal(c.caps.sentMessages.length, 1, "dead-context scan must not report posts");
assert.equal(vm.runInContext("globalThis.__XPC_CONTENT_ACTIVE__", c.context), null,
  "emitPost must release the guard when it meets a dead context");
assert.ok(c.caps.clearedIntervals.includes(3), "the orphan must stop its auto-scroll timer");

console.log("x-post-collector context-invalidation test passed");
