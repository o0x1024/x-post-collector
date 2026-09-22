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
  autoRetry: document.querySelector("#autoRetry"),
  retryBase: document.querySelector("#retryBase"),
  retryMax: document.querySelector("#retryMax"),
  simulateRateLimit: document.querySelector("#simulateRateLimit"),
  captureDiagnostics: document.querySelector("#captureDiagnostics"),
  statusBadge: document.querySelector("#statusBadge"),
  log: document.querySelector("#log"),
  found: document.querySelector("#found"),
  saved: document.querySelector("#saved"),
  duplicate: document.querySelector("#duplicate"),
  queued: document.querySelector("#queued"),
  errors: document.querySelector("#errors"),
  retries: document.querySelector("#retries")
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

const SETTINGS_KEY = "xpcSettings";

function collectRetrySettings() {
  return XPostRetry.normalizeSettings({
    autoRetry: ui.autoRetry.checked,
    retryBaseSec: Number(ui.retryBase.value),
    retryMaxSec: Number(ui.retryMax.value)
  });
}

async function loadRetrySettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = XPostRetry.normalizeSettings(stored?.[SETTINGS_KEY]);
  ui.autoRetry.checked = settings.autoRetry;
  ui.retryBase.value = String(settings.retryBaseSec);
  ui.retryMax.value = String(settings.retryMaxSec);
}

async function saveRetrySettings() {
  const settings = collectRetrySettings();
  ui.autoRetry.checked = settings.autoRetry;
  ui.retryBase.value = String(settings.retryBaseSec);
  ui.retryMax.value = String(settings.retryMaxSec);
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  await chrome.runtime.sendMessage({ type: "SET_RETRY_SETTINGS", settings }).catch(() => {});
  log(`自动重试设置已保存：${settings.autoRetry ? "已开启" : "已关闭"}，首次等待${settings.retryBaseSec}秒，最大等待${settings.retryMaxSec}秒。`);
}

async function writeDiagnosticFile(name, content) {
  if (!directoryHandle) return "";
  if (!(await verifyPermission(directoryHandle, false))) return "";
  const diagnosticsDirectory = await directoryHandle.getDirectoryHandle("diagnostics", { create: true });
  const fileHandle = await diagnosticsDirectory.getFileHandle(name, { create: true });
  const writer = await fileHandle.createWritable();
  await writer.write(content);
  await writer.close();
  return `diagnostics/${name}`;
}

async function saveDetectedSnapshot(html) {
  try {
    const saved = await writeDiagnosticFile(`rate-limit-detected-${Date.now()}.html`, html);
    if (saved) log(`已保存限流现场快照：${saved}`);
  } catch (error) {
    log(`限流快照保存失败：${String(error)}`);
  }
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
  let saved = 0;
  try {
    saved = await writeBatch(batch);
  } catch (error) {
    writeQueue.unshift(...batch);
    await chrome.runtime.sendMessage({ type: "WRITE_RESULT", saved: 0, errors: batch.length, savedKeys: [] }).catch(() => {});
    log(`写入失败，已保留待重试队列：${String(error)}`);
    if (writeQueue.length > 0) scheduleFlush();
    return;
  }
  await chrome.runtime.sendMessage({
    type: "WRITE_RESULT",
    saved,
    savedKeys: batch.map((post) => String(post.dedupe_key || post.post_id || "")),
    errors: 0
  }).catch(() => {});
  log(`已写入${saved}条帖子。`);
  if (writeQueue.length > 0) scheduleFlush();
}

function scheduleFlush() {
  if (!writeTimer) writeTimer = window.setTimeout(() => { flushQueue().catch((error) => log(String(error))); }, 1000);
}

async function drainPending() {
  let response = null;
  try {
    response = await chrome.runtime.sendMessage({ type: "PEEK_PENDING" });
  } catch (error) {
    log(`读取后台缓存失败：${String(error)}`);
  }
  if (response?.posts?.length) {
    writeQueue.push(...response.posts);
    log(`恢复${response.posts.length}条后台缓存帖子。`);
    scheduleFlush();
  }
}

function renderState(state) {
  currentState = state;
  if (state.active && state.rateLimitWaiting) {
    ui.statusBadge.className = "badge waiting";
    ui.statusBadge.textContent = "限流·自动重试中";
  } else {
    const status = state.active ? "running" : state.paused ? "paused" : "idle";
    ui.statusBadge.className = `badge ${status}`;
    ui.statusBadge.textContent = status === "running" ? "采集中" : status === "paused" ? "已暂停" : "未开始";
  }
  ui.found.textContent = state.stats?.found || 0;
  ui.saved.textContent = state.stats?.saved || 0;
  ui.duplicate.textContent = state.stats?.duplicate || 0;
  ui.queued.textContent = Math.max(state.stats?.queued || 0, writeQueue.length);
  ui.errors.textContent = state.stats?.errors || 0;
  ui.retries.textContent = state.stats?.retries || 0;
  ui.start.disabled = Boolean(state.active);
  ui.pause.disabled = !state.active;
  ui.stop.disabled = !state.active && !state.paused;
}

async function refreshTabs() {
  let response = null;
  try {
    response = await chrome.runtime.sendMessage({ type: "GET_TABS" });
  } catch (error) {
    log(`刷新标签页列表失败：${String(error)}`);
  }
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
  if (!selected && tabs[0]) await chrome.runtime.sendMessage({ type: "SET_TARGET_TAB", tabId: tabs[0].id }).catch(() => {});
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
  try {
    const response = await chrome.runtime.sendMessage({ type: "PAUSE_SESSION" });
    renderState(response.state);
    log("采集已暂停。");
  } catch (error) {
    log(`暂停失败：${String(error)}`);
  }
});
ui.stop.addEventListener("click", async () => {
  try {
    await flushQueue();
    if (manifest) {
      manifest.status = "stopped";
      await writeManifest().catch((error) => log(`清单写入失败：${String(error)}`));
    }
    const response = await chrome.runtime.sendMessage({ type: "STOP_SESSION" });
    renderState(response.state);
    log("采集已停止，文件已完成刷新。");
  } catch (error) {
    log(`停止失败：${String(error)}`);
  }
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

ui.autoRetry.addEventListener("change", () => {
  saveRetrySettings().catch((error) => log(`保存自动重试设置失败：${String(error)}`));
});
ui.retryBase.addEventListener("change", () => {
  saveRetrySettings().catch((error) => log(`保存自动重试设置失败：${String(error)}`));
});
ui.retryMax.addEventListener("change", () => {
  saveRetrySettings().catch((error) => log(`保存自动重试设置失败：${String(error)}`));
});
ui.simulateRateLimit.addEventListener("click", async () => {
  try {
    const tabId = Number(ui.targetTab.value) || undefined;
    const response = await chrome.runtime.sendMessage({ type: "SIMULATE_RATE_LIMIT", tabId });
    if (response?.ok && response.injected) log("已注入模拟限流UI，观察运行日志中的自动重试过程。");
    else log(`模拟失败：${response?.error || "请先开始采集，并确认目标为X标签页。"}`);
  } catch (error) {
    log(`模拟失败：${String(error)}`);
  }
});
ui.captureDiagnostics.addEventListener("click", async () => {
  try {
    const tabId = Number(ui.targetTab.value) || undefined;
    const response = await chrome.runtime.sendMessage({ type: "CAPTURE_RATE_LIMIT_DIAGNOSTICS", tabId });
    if (!response?.ok || !response.report) {
      log(`诊断失败：${response?.error || "请确认已打开X标签页。"}`);
      return;
    }
    const report = response.report;
    log(`诊断：精确命中=${report.exact_match ? "是" : "否"}，疑似Retry候选=${report.loose_candidates.length}个，错误文案命中=${report.phrase_hits.length}处。`);
    try {
      const saved = await writeDiagnosticFile(`rate-limit-diag-${Date.now()}.json`, JSON.stringify(report, null, 2));
      if (saved) log(`诊断详情已保存：${saved}`);
      else log(`（未选择保存目录）诊断摘要：${JSON.stringify(report).slice(0, 700)}`);
    } catch (error) {
      log(`诊断文件写入失败：${String(error)}`);
    }
  } catch (error) {
    log(`诊断失败：${String(error)}`);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "STATE") renderState(message.state);
  if (message?.type === "RATE_LIMIT_EVENT") {
    if (message.event?.text) log(message.event.text);
    if (message.event?.snapshot) saveDetectedSnapshot(message.event.snapshot).catch(() => {});
    if (message.state) renderState(message.state);
  }
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

async function syncAutoScrollState() {
  try {
    const tabId = Number(ui.targetTab.value) || Number(currentState?.targetTabId) || 0;
    if (!tabId) return;
    const status = await chrome.runtime.sendMessage({ type: "GET_CONTENT_STATUS", tabId });
    if (status?.ok) ui.autoScroll.checked = Boolean(status.autoScroll);
  } catch (_error) {
    // 状态同步失败不影响面板其它功能。
  }
}

(async function init() {
  try {
    await restoreDirectory();
    await loadRetrySettings();
    const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    renderState(response.state);
    await loadManifest(response.state.sessionId);
    await refreshTabs();
    await syncAutoScrollState();
    if (response.state.active) await drainPending();
  } catch (error) {
    log(`初始化失败：${String(error)}`);
  }
})();
