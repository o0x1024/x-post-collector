"use strict";

const DEFAULT_STATE = {
  active: false,
  paused: false,
  sessionId: "",
  startedAt: "",
  stats: { found: 0, saved: 0, duplicate: 0, errors: 0, queued: 0, retries: 0 },
  targetTabId: null
};

let session = structuredClone(DEFAULT_STATE);
let seenKeys = new Set();
let pendingPosts = [];
const rateLimitTabIds = new Set();

function isXTab(tab) {
  return Boolean(tab?.url && /^https:\/\/(www\.)?x\.com\//i.test(tab.url));
}

function cloneState() {
  return { ...session, stats: { ...session.stats }, pending: pendingPosts.length, rateLimitWaiting: rateLimitTabIds.size > 0 };
}

function updateBadge() {
  const waiting = Boolean(session.active) && rateLimitTabIds.size > 0;
  try {
    void chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" }).catch(() => {});
    void chrome.action.setBadgeText({ text: waiting ? "429" : "" }).catch(() => {});
  } catch (_error) {
    // noop
  }
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

async function persist() {
  await chrome.storage.local.set({
    xpcSession: session,
    xpcSeenKeys: [...seenKeys].slice(-20000),
    xpcPendingPosts: pendingPosts.slice(-5000)
  });
}

let restoreInFlight = null;

// Single-flight: on an extension reload the top-level restore and the
// onInstalled/onStartup listeners fire almost together. Concurrent restores
// used to run their fallback injection twice, leaving duplicate collectors
// in every open X tab (one copy of each post reported as "duplicate").
function restore() {
  if (!restoreInFlight) {
    restoreInFlight = restoreOnce().finally(() => {
      // Keep a short window so the startup triggers coalesce into one run.
      setTimeout(() => {
        restoreInFlight = null;
      }, 2000);
    });
  }
  return restoreInFlight;
}

async function restoreOnce() {
  const stored = await chrome.storage.local.get(["xpcSession", "xpcSeenKeys", "xpcPendingPosts"]);
  if (stored.xpcSession?.sessionId) session = { ...DEFAULT_STATE, ...stored.xpcSession, stats: { ...DEFAULT_STATE.stats, ...stored.xpcSession.stats } };
  seenKeys = new Set(Array.isArray(stored.xpcSeenKeys) ? stored.xpcSeenKeys : []);
  pendingPosts = Array.isArray(stored.xpcPendingPosts) ? stored.xpcPendingPosts : [];
  if (!session.active) session.paused = false;
  if (session.active) startContentOnAllTabs().catch(() => {});
  updateBadge();
}

const contentScriptJobs = new Map();

async function pingContent(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return Boolean(response?.ok);
  } catch (_error) {
    return false;
  }
}

function injectContentScript(tabId) {
  // One injection per tab at a time; concurrent callers share the same job.
  if (!contentScriptJobs.has(tabId)) {
    const job = chrome.scripting
      .executeScript({ target: { tabId }, files: ["shared/utils.js", "shared/retry.js", "content.js"] })
      .catch(() => {})
      .finally(() => {
        setTimeout(() => contentScriptJobs.delete(tabId), 800);
      });
    contentScriptJobs.set(tabId, job);
  }
  return contentScriptJobs.get(tabId);
}

async function ensureContentScript(tabId) {
  if (await pingContent(tabId)) return true;
  await injectContentScript(tabId);
  if (await pingContent(tabId)) return true;
  // A fresh injection can be a no-op while a stale instance from a previous
  // extension context still holds the singleton guard; that guard is
  // released within one heartbeat. Retry once so the tab recovers on its own.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (await pingContent(tabId)) return true;
  contentScriptJobs.delete(tabId);
  await injectContentScript(tabId);
  return pingContent(tabId);
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_error) {
    // Only inject after confirming that no live collector answers a ping.
    await ensureContentScript(tabId);
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }
}

async function xTabs() {
  return (await chrome.tabs.query({})).filter(isXTab);
}

async function startContentOnAllTabs() {
  const tabs = await xTabs();
  await Promise.all(tabs.map((tab) => sendToTab(tab.id, { type: "START_COLLECTING" })));
  return tabs;
}

async function stopContentOnAllTabs() {
  const tabs = await xTabs();
  await Promise.all(tabs.map((tab) => sendToTab(tab.id, { type: "STOP_COLLECTING" })));
}

async function startSession() {
  const now = new Date();
  session = {
    ...DEFAULT_STATE,
    active: true,
    paused: false,
    sessionId: now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14),
    startedAt: now.toISOString(),
    stats: { ...DEFAULT_STATE.stats }
  };
  seenKeys = new Set();
  pendingPosts = [];
  rateLimitTabIds.clear();
  updateBadge();
  await persist();
  const tabs = await startContentOnAllTabs();
  if (!session.targetTabId && tabs[0]) session.targetTabId = tabs[0].id;
  await persist();
  broadcast({ type: "STATE", state: cloneState() });
  return cloneState();
}

async function setActive(active) {
  session.active = active;
  session.paused = !active && Boolean(session.sessionId);
  if (active) await startContentOnAllTabs();
  else await stopContentOnAllTabs();
  if (!active) {
    rateLimitTabIds.clear();
    updateBadge();
  }
  await persist();
  broadcast({ type: "STATE", state: cloneState() });
  return cloneState();
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  restore().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => { restore().catch(() => {}); });
restore().catch(() => {});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!session.active || changeInfo.status !== "complete" || !isXTab(tab)) return;
  sendToTab(tabId, { type: "START_COLLECTING" }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (rateLimitTabIds.delete(tabId)) updateBadge();
  if (session.targetTabId === tabId) {
    session.targetTabId = null;
    persist().catch(() => {});
    broadcast({ type: "STATE", state: cloneState() });
  }
});

chrome.runtime.onMessage.addListener((message, sender, rawSendResponse) => {
  // The sender's port can close while our async work is in flight (most
  // often when the extension reloads mid-request). Responding on a dead
  // channel throws and must never surface as an unhandled rejection
  // ("A listener indicated an asynchronous response...").
  let responded = false;
  const sendResponse = (payload) => {
    if (responded) return;
    responded = true;
    try {
      rawSendResponse(payload);
    } catch (_error) {
      // Channel already closed; nothing left to answer.
    }
  };
  (async () => {
    if (message?.type === "GET_STATE") {
      sendResponse({ ok: true, state: cloneState() });
      return;
    }
    if (message?.type === "GET_TABS") {
      const tabs = await xTabs();
      sendResponse({ ok: true, tabs: tabs.map((tab) => ({ id: tab.id, windowId: tab.windowId, title: tab.title || tab.url, url: tab.url })) });
      return;
    }
    if (message?.type === "START_SESSION") {
      sendResponse({ ok: true, state: await startSession() });
      return;
    }
    if (message?.type === "PAUSE_SESSION") {
      sendResponse({ ok: true, state: await setActive(false) });
      return;
    }
    if (message?.type === "RESUME_SESSION") {
      sendResponse({ ok: true, state: await setActive(true) });
      return;
    }
    if (message?.type === "STOP_SESSION") {
      await setActive(false);
      session = { ...DEFAULT_STATE };
      seenKeys = new Set();
      rateLimitTabIds.clear();
      updateBadge();
      await persist();
      broadcast({ type: "SESSION_STOPPED" });
      sendResponse({ ok: true, state: cloneState() });
      return;
    }
    if (message?.type === "SET_TARGET_TAB") {
      session.targetTabId = Number(message.tabId) || null;
      await persist();
      sendResponse({ ok: true, state: cloneState() });
      return;
    }
    if (message?.type === "SET_AUTO_SCROLL") {
      const enabled = Boolean(message.enabled);
      const tabId = Number(message.tabId || session.targetTabId);
      if (!enabled) {
        // Turning the switch off stops auto-scroll on every X tab, so a tab
        // that was selected earlier can never keep scrolling on its own.
        const stopTabs = await xTabs();
        await Promise.all(stopTabs.map((tab) => sendToTab(tab.id, { type: "AUTO_SCROLL", enabled: false })));
        sendResponse({ ok: true, enabled: false });
        return;
      }
      if (!tabId) {
        sendResponse({ ok: false, error: "未选择自动滚动标签页" });
        return;
      }
      // Only one tab may auto-scroll at a time: stop the others first.
      const otherTabs = (await xTabs()).filter((tab) => tab.id !== tabId);
      await Promise.all(otherTabs.map((tab) => sendToTab(tab.id, { type: "AUTO_SCROLL", enabled: false })));
      sendResponse(await sendToTab(tabId, { type: "AUTO_SCROLL", enabled: true, intervalMs: message.intervalMs }));
      return;
    }
    if (message?.type === "GET_CONTENT_STATUS") {
      const tabId = Number(message.tabId || session.targetTabId);
      if (!tabId) {
        sendResponse({ ok: false, error: "未选择标签页" });
        return;
      }
      sendResponse(await sendToTab(tabId, { type: "CONTENT_STATUS" }));
      return;
    }
    if (message?.type === "RATE_LIMIT_EVENT") {
      if (!session.active || !sender.tab || !isXTab(sender.tab)) {
        sendResponse({ ok: true, ignored: true });
        return;
      }
      const phase = String(message.phase || "");
      const tabId = sender.tab.id;
      if (phase === "recovered" || phase === "cleared") {
        rateLimitTabIds.delete(tabId);
      } else if (["detected", "simulated", "scheduled", "rescheduled", "clicked", "warn"].includes(phase)) {
        rateLimitTabIds.add(tabId);
      }
      if (phase === "clicked") session.stats.retries = Number(session.stats.retries || 0) + 1;
      if (message.snapshot) {
        session.lastRateLimitSnapshot = {
          at: new Date().toISOString(),
          url: String(message.url || ""),
          html: String(message.snapshot).slice(0, 2000)
        };
      }
      updateBadge();
      await persist();
      broadcast({
        type: "RATE_LIMIT_EVENT",
        event: {
          phase,
          attempt: Number(message.attempt || 0),
          delaySec: Number(message.delaySec || 0),
          text: String(message.text || ""),
          snapshot: String(message.snapshot || ""),
          tabId
        },
        state: cloneState()
      });
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "SIMULATE_RATE_LIMIT") {
      const tabId = Number(message.tabId || session.targetTabId);
      if (!tabId) {
        sendResponse({ ok: false, error: "未选择标签页" });
        return;
      }
      const result = await sendToTab(tabId, { type: "SIMULATE_RATE_LIMIT" });
      sendResponse({ ok: Boolean(result?.ok), injected: Boolean(result?.injected), error: result?.error });
      return;
    }
    if (message?.type === "SET_RETRY_SETTINGS") {
      const settings = message.settings && typeof message.settings === "object" ? message.settings : {};
      const tabs = await xTabs();
      await Promise.all(tabs.map((tab) => sendToTab(tab.id, { type: "APPLY_RETRY_SETTINGS", settings })));
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "CAPTURE_RATE_LIMIT_DIAGNOSTICS") {
      const tabId = Number(message.tabId || session.targetTabId);
      if (!tabId) {
        sendResponse({ ok: false, error: "未选择标签页" });
        return;
      }
      const result = await sendToTab(tabId, { type: "CAPTURE_RATE_LIMIT_DIAGNOSTICS" });
      if (result?.report) sendResponse({ ok: true, report: result.report });
      else sendResponse({ ok: false, error: result?.error || "页面未响应" });
      return;
    }
    if (message?.type === "POST_FOUND") {
      if (!session.active || !sender.tab || !isXTab(sender.tab)) {
        sendResponse({ ok: false, ignored: true });
        return;
      }
      const key = String(message.post?.dedupe_key || message.post?.post_id || "");
      if (!key || seenKeys.has(key)) {
        session.stats.duplicate += 1;
        sendResponse({ ok: true, duplicate: true });
        return;
      }
      seenKeys.add(key);
      pendingPosts.push({ ...message.post, source_tab_id: sender.tab.id, source_window_id: sender.tab.windowId });
      session.stats.found += 1;
      session.stats.queued = pendingPosts.length;
      if (pendingPosts.length > 5000) pendingPosts = pendingPosts.slice(-5000);
      await persist();
      broadcast({ type: "POST_ACCEPTED", post: pendingPosts[pendingPosts.length - 1], state: cloneState() });
      sendResponse({ ok: true, accepted: true });
      return;
    }
    if (message?.type === "PEEK_PENDING") {
      const posts = pendingPosts.slice();
      sendResponse({ ok: true, posts, state: cloneState() });
      return;
    }
    if (message?.type === "WRITE_RESULT") {
      const savedKeys = new Set(Array.isArray(message.savedKeys) ? message.savedKeys.map(String) : []);
      if (savedKeys.size > 0) {
        const before = pendingPosts.length;
        pendingPosts = pendingPosts.filter((post) => !savedKeys.has(String(post.dedupe_key || post.post_id || "")));
        session.stats.saved += before - pendingPosts.length;
      }
      session.stats.errors += Number(message.errors || 0);
      session.stats.queued = pendingPosts.length;
      await persist();
      broadcast({ type: "STATE", state: cloneState() });
      sendResponse({ ok: true, state: cloneState() });
      return;
    }
    if (message?.type === "AUTO_SCROLL_IDLE") {
      broadcast({ type: "AUTO_SCROLL_IDLE" });
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: "未知消息" });
  })().catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});
