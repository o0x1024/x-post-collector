"use strict";

const DB_NAME = "x-post-collector";
const DB_VERSION = 1;
const HANDLE_STORE = "handles";

const ui = {
  chooseDirectory: document.querySelector("#chooseDirectory"),
  directoryLabel: document.querySelector("#directoryLabel"),
  start: document.querySelector("#start"),
  pause: document.querySelector("#pause"),
  stop: document.querySelector("#stop"),
  autoScroll: document.querySelector("#autoScroll"),
  scrollInterval: document.querySelector("#scrollInterval"),
  targetTab: document.querySelector("#targetTab"),
  statusBadge: document.querySelector("#statusBadge"),
  log: document.querySelector("#log"),
  found: document.querySelector("#found"),
  saved: document.querySelector("#saved"),
  duplicate: document.querySelector("#duplicate"),
  queued: document.querySelector("#queued"),
  errors: document.querySelector("#errors")
};

let directoryHandle = null;
let currentState = null;
let writeQueue = [];
let writeTimer = null;
let partNumber = 0;
let manifest = null;
const imageHostAllowlist = new Set(["pbs.twimg.com", "video.twimg.com", "abs.twimg.com"]);

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  ui.log.textContent = `${line}\n${ui.log.textContent}`.slice(0, 4000);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(HANDLE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readHandle() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(HANDLE_STORE, "readonly").objectStore(HANDLE_STORE).get("directory");
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function saveHandle(handle) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(HANDLE_STORE, "readwrite").objectStore(HANDLE_STORE).put(handle, "directory");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function verifyPermission(handle, requestPermission) {
  if (!handle) return false;
  const options = { mode: "readwrite" };
  if (await handle.queryPermission(options) === "granted") return true;
  return requestPermission && (await handle.requestPermission(options)) === "granted";
}

async function chooseDirectory() {
  if (!window.showDirectoryPicker) throw new Error("当前Chrome不支持目录选择，请升级Chrome。");
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  if (!(await verifyPermission(handle, true))) throw new Error("未获得目录写入权限。");
  directoryHandle = handle;
  await saveHandle(handle);
  ui.directoryLabel.textContent = handle.name;
  log(`已选择目录：${handle.name}`);
  if (writeQueue.length > 0) scheduleFlush();
}

async function restoreDirectory() {
  try {
    const handle = await readHandle();
    if (handle && await verifyPermission(handle, false)) {
      directoryHandle = handle;
      ui.directoryLabel.textContent = handle.name;
      log(`已恢复目录：${handle.name}`);
    }
  } catch (error) {
    log(`恢复目录失败：${String(error)}`);
  }
}

function sessionPrefix() {
  return currentState?.sessionId || `adhoc-${Date.now()}`;
}

async function writeBatch(posts) {
  if (!directoryHandle || posts.length === 0) return 0;
  if (!(await verifyPermission(directoryHandle, true))) throw new Error("目录写入权限已失效。");
  const postsDirectory = await directoryHandle.getDirectoryHandle("posts", { create: true });
  const mediaDirectory = await directoryHandle.getDirectoryHandle("media", { create: true });
  let mediaFailures = 0;
  const savedFiles = [];
  if (!manifest) manifest = { session_id: sessionPrefix(), started_at: new Date().toISOString(), parts: [], media_files: [], post_count: 0, status: "running" };
  manifest.media_files = manifest.media_files || [];
  for (const post of posts) {
    const postKey = XPostMarkdown.safeFileName(post.post_id || post.dedupe_key, `post-${Date.now()}`);
    const imageRefs = [];
    const imageUrls = [...new Set(Array.isArray(post.image_urls) ? post.image_urls : [])].slice(0, 12);
    for (let index = 0; index < imageUrls.length; index += 1) {
      const remoteUrl = imageUrls[index];
      let parsedUrl;
      try {
        parsedUrl = new URL(remoteUrl);
      } catch (_error) {
        mediaFailures += 1;
        imageRefs.push({ remoteUrl, alt: post.media_alt?.[index] || `图片${index + 1}` });
        continue;
      }
      if (parsedUrl.protocol !== "https:" || !imageHostAllowlist.has(parsedUrl.hostname)) {
        mediaFailures += 1;
        imageRefs.push({ remoteUrl, alt: post.media_alt?.[index] || `图片${index + 1}` });
        continue;
      }
      try {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 15000);
        const response = await fetch(remoteUrl, { credentials: "include", signal: controller.signal });
        window.clearTimeout(timeout);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.toLowerCase().startsWith("image/")) throw new Error("响应不是图片");
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("图片超过20MB限制");
        const extension = XPostMarkdown.imageExtension(contentType, remoteUrl);
        const mediaName = `${postKey}-${String(index + 1).padStart(2, "0")}.${extension}`;
        const mediaHandle = await mediaDirectory.getFileHandle(mediaName, { create: true });
        const mediaWriter = await mediaHandle.createWritable();
        await mediaWriter.write(bytes);
        await mediaWriter.close();
        imageRefs.push({ localPath: `../media/${mediaName}`, remoteUrl, alt: post.media_alt?.[index] || `图片${index + 1}` });
        manifest.media_files.push(`media/${mediaName}`);
      } catch (error) {
        mediaFailures += 1;
        imageRefs.push({ remoteUrl, alt: post.media_alt?.[index] || `图片${index + 1}` });
        log(`图片下载失败，Markdown保留远程链接：${String(error)}`);
      }
    }
    const markdownName = `${postKey}.md`;
    const markdownHandle = await postsDirectory.getFileHandle(markdownName, { create: true });
    const markdownWriter = await markdownHandle.createWritable();
    await markdownWriter.write(XPostMarkdown.markdownForPost(post, imageRefs));
    await markdownWriter.close();
    savedFiles.push(`posts/${markdownName}`);
  }
  manifest.parts.push(...savedFiles);
  manifest.post_count += posts.length;
  try {
    await writeManifest();
  } catch (error) {
    log(`清单刷新失败，但帖子Markdown已写入：${String(error)}`);
  }
  if (mediaFailures > 0) log(`${mediaFailures}张图片未能下载，已在Markdown中保留远程链接。`);
  return posts.length;
}

async function loadManifest(sessionId) {
  if (!directoryHandle || !sessionId) return;
  try {
    const handle = await directoryHandle.getFileHandle(`session-manifest-${sessionId}.json`);
    const file = await handle.getFile();
    const existing = JSON.parse(await file.text());
    if (existing && existing.session_id === sessionId) {
      manifest = existing;
      partNumber = Array.isArray(existing.parts) ? existing.parts.length : 0;
    }
  } catch (_error) {
    manifest = null;
  }
}

async function writeManifest() {
  if (!directoryHandle || !manifest) return;
  const name = `session-manifest-${sessionPrefix()}.json`;
  const fileHandle = await directoryHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify({ ...manifest, updated_at: new Date().toISOString() }, null, 2));
  await writable.close();
}

async function flushQueue() {
  if (writeTimer) {
    window.clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (!directoryHandle || writeQueue.length === 0) return;
  const batch = writeQueue.splice(0, 50);
  try {
    const saved = await writeBatch(batch);
    await chrome.runtime.sendMessage({
      type: "WRITE_RESULT",
      saved,
      savedKeys: batch.map((post) => String(post.dedupe_key || post.post_id || "")),
      errors: 0
    });
    log(`已写入${saved}条帖子。`);
  } catch (error) {
    writeQueue.unshift(...batch);
    await chrome.runtime.sendMessage({ type: "WRITE_RESULT", saved: 0, errors: batch.length, savedKeys: [] });
    log(`写入失败，已保留待重试队列：${String(error)}`);
  }
  if (writeQueue.length > 0) scheduleFlush();
}

function scheduleFlush() {
  if (!writeTimer) writeTimer = window.setTimeout(() => { flushQueue().catch((error) => log(String(error))); }, 1000);
}

async function drainPending() {
  const response = await chrome.runtime.sendMessage({ type: "PEEK_PENDING" });
  if (response?.posts?.length) {
    writeQueue.push(...response.posts);
    log(`恢复${response.posts.length}条后台缓存帖子。`);
    scheduleFlush();
  }
}

function renderState(state) {
  currentState = state;
  const status = state.active ? "running" : state.paused ? "paused" : "idle";
  ui.statusBadge.className = `badge ${status}`;
  ui.statusBadge.textContent = status === "running" ? "采集中" : status === "paused" ? "已暂停" : "未开始";
  ui.found.textContent = state.stats?.found || 0;
  ui.saved.textContent = state.stats?.saved || 0;
  ui.duplicate.textContent = state.stats?.duplicate || 0;
  ui.queued.textContent = Math.max(state.stats?.queued || 0, writeQueue.length);
  ui.errors.textContent = state.stats?.errors || 0;
  ui.start.disabled = Boolean(state.active);
  ui.pause.disabled = !state.active;
  ui.stop.disabled = !state.active && !state.paused;
}

async function refreshTabs() {
  const response = await chrome.runtime.sendMessage({ type: "GET_TABS" });
  const tabs = response?.tabs || [];
  const selected = currentState?.targetTabId;
  ui.targetTab.replaceChildren();
  for (const tab of tabs) {
    const option = document.createElement("option");
    option.value = String(tab.id);
    option.textContent = `${tab.title.slice(0, 42)}（${tab.id}）`;
    option.selected = tab.id === selected;
    ui.targetTab.append(option);
  }
  if (!selected && tabs[0]) await chrome.runtime.sendMessage({ type: "SET_TARGET_TAB", tabId: tabs[0].id });
}

ui.chooseDirectory.addEventListener("click", () => chooseDirectory().catch((error) => log(`选择目录失败：${String(error)}`)));
ui.start.addEventListener("click", async () => {
  try {
    if (!directoryHandle) await chooseDirectory();
    const response = await chrome.runtime.sendMessage({ type: "START_SESSION" });
    renderState(response.state);
    if (!manifest || manifest.session_id !== response.state.sessionId) {
      manifest = { session_id: response.state.sessionId, started_at: response.state.startedAt, parts: [], post_count: 0, status: "running" };
      partNumber = 0;
    }
    await drainPending();
    log("采集已开始。请在X页面滚动以发现新帖子。");
  } catch (error) { log(`开始失败：${String(error)}`); }
});
ui.pause.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "PAUSE_SESSION" });
  renderState(response.state);
  log("采集已暂停。");
});
ui.stop.addEventListener("click", async () => {
  await flushQueue();
  if (manifest) { manifest.status = "stopped"; await writeManifest(); }
  const response = await chrome.runtime.sendMessage({ type: "STOP_SESSION" });
  renderState(response.state);
  log("采集已停止，文件已完成刷新。");
});
ui.targetTab.addEventListener("change", async () => {
  try {
    const tabId = Number(ui.targetTab.value);
    await chrome.runtime.sendMessage({ type: "SET_TARGET_TAB", tabId });
    if (ui.autoScroll.checked) {
      const response = await chrome.runtime.sendMessage({
        type: "SET_AUTO_SCROLL",
        enabled: true,
        tabId,
        intervalMs: Number(ui.scrollInterval.value)
      });
      if (!response?.ok) {
        ui.autoScroll.checked = false;
        log(`自动滚动失败：${response?.error || "未知错误"}`);
      }
    }
  } catch (error) {
    ui.autoScroll.checked = false;
    log(`切换自动滚动标签页失败：${String(error)}`);
  }
});
ui.autoScroll.addEventListener("change", async () => {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "SET_AUTO_SCROLL",
      enabled: ui.autoScroll.checked,
      tabId: Number(ui.targetTab.value),
      intervalMs: Number(ui.scrollInterval.value)
    });
    if (!response?.ok) {
      ui.autoScroll.checked = false;
      log(`自动滚动失败：${response?.error || "未知错误"}`);
    } else {
      ui.autoScroll.checked = Boolean(response.enabled);
      log(ui.autoScroll.checked ? "已开启自动滚动。" : "已关闭自动滚动。");
    }
  } catch (error) {
    ui.autoScroll.checked = false;
    log(`自动滚动失败：${String(error)}`);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "STATE") renderState(message.state);
  if (message?.type === "POST_ACCEPTED") {
    writeQueue.push(message.post);
    renderState(message.state);
    scheduleFlush();
  }
  if (message?.type === "AUTO_SCROLL_IDLE") {
    ui.autoScroll.checked = false;
    log("已到当前内容底部，等待后仍无新帖子，自动滚动已暂停。");
  }
  if (message?.type === "SESSION_STOPPED" && manifest) { manifest.status = "stopped"; writeManifest().catch(() => {}); }
});

(async function init() {
  await restoreDirectory();
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  renderState(response.state);
  await loadManifest(response.state.sessionId);
  await refreshTabs();
  if (response.state.active) await drainPending();
})();
