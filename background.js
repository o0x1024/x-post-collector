"use strict";

const DEFAULT_STATE = {
  active: false,
  paused: false,
  sessionId: "",
  startedAt: "",
  stats: { found: 0, saved: 0, duplicate: 0, errors: 0, queued: 0 },
  targetTabId: null
};

let session = structuredClone(DEFAULT_STATE);
let seenKeys = new Set();
let pendingPosts = [];

function isXTab(tab) {
  return Boolean(tab?.url && /^https:\/\/(www\.)?x\.com\//i.test(tab.url));
}

function cloneState() {
  return { ...session, stats: { ...session.stats }, pending: pendingPosts.length };
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

async function restore() {
  const stored = await chrome.storage.local.get(["xpcSession", "xpcSeenKeys", "xpcPendingPosts"]);
  if (stored.xpcSession?.sessionId) session = { ...DEFAULT_STATE, ...stored.xpcSession, stats: { ...DEFAULT_STATE.stats, ...stored.xpcSession.stats } };
  seenKeys = new Set(Array.isArray(stored.xpcSeenKeys) ? stored.xpcSeenKeys : []);
  pendingPosts = Array.isArray(stored.xpcPendingPosts) ? stored.xpcPendingPosts : [];
  if (!session.active) session.paused = false;
  if (session.active) startContentOnAllTabs().catch(() => {});
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_error) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["shared/utils.js", "content.js"] });
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
  if (session.targetTabId === tabId) {
    session.targetTabId = null;
    persist().catch(() => {});
    broadcast({ type: "STATE", state: cloneState() });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
      const tabId = Number(message.tabId || session.targetTabId);
      if (!tabId) {
        sendResponse({ ok: false, error: "未选择自动滚动标签页" });
        return;
      }
      sendResponse(await sendToTab(tabId, { type: "AUTO_SCROLL", enabled: Boolean(message.enabled), intervalMs: message.intervalMs }));
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
