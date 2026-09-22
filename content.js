(function initXPostCollector() {
  "use strict";

  // Only one instance of this script may run per page. Duplicate injection
  // (the background fallback after a transient messaging failure) used to
  // leave two live collectors that each reported every post, so the
  // background counted one copy as "found" and the other as "duplicate".
  const INSTANCE_FLAG = "__XPC_CONTENT_ACTIVE__";
  const INSTANCE_TOKEN = {};
  const CONTEXT_HEARTBEAT_MS = 1000;

  function isExtensionContextAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (_error) {
      return false;
    }
  }

  if (globalThis[INSTANCE_FLAG]) return;
  // The extension can be reloaded between injecting this script and running
  // it; a dead context throws "Extension context invalidated" on any chrome.*
  // call, so bail out before touching one.
  if (!isExtensionContextAlive()) return;
  globalThis[INSTANCE_FLAG] = INSTANCE_TOKEN;

  // Used by every long-lived timer below. Once the extension context is gone
  // (reload, update, uninstall) the chrome.* APIs are dead: release the
  // singleton guard and stop all activity so no orphan instance keeps
  // scrolling or clicking the page.
  function releaseGuardIfOrphaned() {
    if (isExtensionContextAlive()) return false;
    if (globalThis[INSTANCE_FLAG] === INSTANCE_TOKEN) {
      globalThis[INSTANCE_FLAG] = null;
    }
    try {
      stopCollectors();
    } catch (_error) {
      // noop
    }
    return true;
  }

  // After an extension reload/update the previous instance loses its chrome.*
  // context. The heartbeat releases the guard (and stops the stale collectors)
  // so the next injection can take over the page.
  const contextHeartbeat = window.setInterval(() => {
    if (!releaseGuardIfOrphaned()) return;
    window.clearInterval(contextHeartbeat);
  }, CONTEXT_HEARTBEAT_MS);

  const utils = globalThis.XPostUtils;
  const retry = globalThis.XPostRetry;
  const retryDefaults = retry?.DEFAULT_SETTINGS || { autoRetry: true, retryBaseSec: 30, retryMaxSec: 360 };
  const state = {
    active: false,
    autoScroll: false,
    autoScrollTimer: null,
    autoScrollTicksWithoutNewPosts: 0,
    autoScrollIdleSince: 0,
    lastFoundCount: 0,
    lastUserActivityAt: 0,
    scrollHost: null,
    seen: new Set(),
    intersectionObserver: null,
    mutationObserver: null,
    retrySettings: {
      enabled: retryDefaults.autoRetry,
      baseMs: retryDefaults.retryBaseSec * 1000,
      maxMs: retryDefaults.retryMaxSec * 1000
    },
    rateLimit: {
      episodeActive: false,
      absentSince: 0,
      clicksInRun: 0,
      attemptsThisEpisode: 0,
      warnedLevel: 0,
      lastClickAt: 0,
      pendingTimer: null,
      verifyTimer: null,
      resetTimer: null,
      checkTimer: null
    }
  };

  const EXCLUDED_PATHS = ["/messages", "/settings", "/notifications", "/i/"];
  const RECOVERY_GRACE_MS = 6000;
  const CLICK_COOLDOWN_MS = 3000;
  const VERIFY_AFTER_MS = 8000;
  const CLEAN_WINDOW_MS = 120000;
  const WARN_AFTER_CLICKS = 6;
  const RATE_LIMIT_POLL_MS = 2000;

  function isAllowedPage() {
    const path = window.location.pathname;
    return !EXCLUDED_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  }

  function firstText(root, selectors) {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      const value = utils.normalizeText(node?.textContent);
      if (value) return value;
    }
    return "";
  }

  function extractPost(article) {
    if (!isVisible(article) || !isAllowedPage()) return null;

    const statusLink = [...article.querySelectorAll('a[href*="/status/"]')]
      .map((node) => utils.absoluteUrl(node.getAttribute("href"), window.location.href))
      .find((href) => utils.extractStatusId(href));
    const postId = utils.extractStatusId(statusLink);
    const text = firstText(article, ['[data-testid="tweetText"]']) || utils.normalizeText(article.innerText);
    const publishedNode = article.querySelector("time[datetime]");
    const publishedAt = publishedNode?.getAttribute("datetime") || "";
    const authorHandle = firstText(article, ['[data-testid="User-Name"] a[href^="/"]']);
    const authorName = firstText(article, ['[data-testid="User-Name"]']);
    const mediaAlt = [...article.querySelectorAll("img[alt]")]
      .map((node) => utils.normalizeText(node.getAttribute("alt")))
      .filter(Boolean);
    const imageUrls = [...article.querySelectorAll("img[src]")]
      .map((node) => utils.absoluteUrl(node.getAttribute("src"), window.location.href))
      .filter(Boolean);
    const mediaUrls = [...article.querySelectorAll("img[src], video[src]")]
      .map((node) => utils.absoluteUrl(node.getAttribute("src"), window.location.href))
      .filter(Boolean);
    const canonicalKey = postId || utils.shortHash(`${statusLink}|${authorHandle}|${publishedAt}|${text}`);
    if (!canonicalKey || !text) return null;

    return {
      post_id: postId,
      dedupe_key: canonicalKey,
      post_url: statusLink || window.location.href,
      author_name: authorName,
      author_handle: authorHandle,
      text,
      published_at: publishedAt,
      captured_at: new Date().toISOString(),
      source_url: window.location.href,
      media_alt: [...new Set(mediaAlt)],
      media_urls: [...new Set(mediaUrls)],
      image_urls: [...new Set(imageUrls)]
    };
  }

  // Single safe channel to the background: never throws when the extension
  // context has just been invalidated (stale instance waiting for the
  // heartbeat cleanup) and never leaves an unhandled rejection behind.
  function sendToBackground(message) {
    try {
      const sent = chrome.runtime.sendMessage(message);
      if (sent && typeof sent.catch === "function") sent.catch(() => {});
    } catch (_error) {
      // noop
    }
  }

  function emitPost(article) {
    // Every reported post funnels through here. If the extension context
    // died (reload/update) stop the orphan instance on this first activity
    // instead of letting it keep touching dead chrome.* APIs until the
    // heartbeat fires.
    if (releaseGuardIfOrphaned()) return false;
    if (!state.active) return false;
    const post = extractPost(article);
    if (!post || state.seen.has(post.dedupe_key)) return false;
    state.seen.add(post.dedupe_key);
    state.lastFoundCount += 1;
    sendToBackground({ type: "POST_FOUND", post });
    return true;
  }

  function scanVisiblePosts() {
    let found = 0;
    for (const article of document.querySelectorAll("article")) {
      if (emitPost(article)) found += 1;
    }
    return found;
  }

  function observeArticle(article) {
    if (!(article instanceof Element) || article.dataset.xpcObserved === "1") return;
    article.dataset.xpcObserved = "1";
    state.intersectionObserver?.observe(article);
    if (isVisible(article)) emitPost(article);
  }

  function observeAllArticles() {
    for (const article of document.querySelectorAll("article")) observeArticle(article);
  }

  function stopObservers() {
    state.intersectionObserver?.disconnect();
    state.mutationObserver?.disconnect();
    state.intersectionObserver = null;
    state.mutationObserver = null;
    for (const article of document.querySelectorAll('article[data-xpc-observed="1"]')) {
      delete article.dataset.xpcObserved;
    }
  }

  function stopAutoScroll() {
    if (state.autoScrollTimer) window.clearInterval(state.autoScrollTimer);
    state.autoScrollTimer = null;
    state.autoScroll = false;
    state.autoScrollTicksWithoutNewPosts = 0;
    state.autoScrollIdleSince = 0;
  }

  function isScrollableElement(element) {
    if (!(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const overflowY = style.overflowY;
    return ["auto", "scroll", "overlay"].includes(overflowY)
      && element.scrollHeight > element.clientHeight + 4;
  }

  function findScrollHost() {
    if (state.scrollHost && state.scrollHost.isConnected && isScrollableElement(state.scrollHost)) {
      return state.scrollHost;
    }

    // X normally scrolls a nested column rather than the window. Start at the
    // last visible post so the selected feed wins when other panels are also
    // scrollable, then fall back to the document root.
    const tweetArticles = [...document.querySelectorAll('article[data-testid="tweet"]')];
    const articleCandidates = tweetArticles.length > 0 ? tweetArticles : [...document.querySelectorAll("article")];
    const visibleArticle = articleCandidates.reverse().find(isVisible);
    for (let node = visibleArticle; node; node = node.parentElement) {
      if (isScrollableElement(node)) {
        state.scrollHost = node;
        return node;
      }
    }

    const root = document.scrollingElement;
    if (root && (isScrollableElement(root) || root.scrollHeight > root.clientHeight + 4)) {
      state.scrollHost = root;
      return root;
    }
    state.scrollHost = window;
    return window;
  }

  function scrollHostBy(host, amount) {
    if (host === window) {
      window.scrollBy({ top: amount, behavior: "smooth" });
      return;
    }
    if (typeof host.scrollBy === "function") {
      host.scrollBy({ top: amount, behavior: "smooth" });
    } else {
      host.scrollTop += amount;
    }
  }

  function scrollMetrics(host) {
    const root = document.scrollingElement;
    if (host === window) {
      return {
        top: window.scrollY || root?.scrollTop || 0,
        height: root?.scrollHeight || document.documentElement.scrollHeight,
        viewport: window.innerHeight
      };
    }
    return { top: host.scrollTop, height: host.scrollHeight, viewport: host.clientHeight };
  }

  function isAtScrollEnd(metrics) {
    return metrics.top + metrics.viewport >= metrics.height - Math.max(24, metrics.viewport * 0.08);
  }

  function isStyleVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  }

  function findRateLimitUI() {
    if (!retry) return null;
    const matches = [];
    for (const element of document.querySelectorAll('button, [role="button"]')) {
      const labelText = String(element.textContent || "").slice(0, 120);
      const ariaLabel = element.getAttribute("aria-label") || "";
      if (!retry.matchRetryLabel(labelText) && !retry.matchRetryLabel(ariaLabel)) continue;
      const hostArticle = element.closest("article");
      if (hostArticle && !retry.containsErrorPhrase(String(hostArticle.innerText || "").slice(0, 6000))) continue;
      if (!isStyleVisible(element)) continue;
      let node = element.parentElement;
      let container = null;
      for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
        const text = String(node.innerText || node.textContent || "").slice(0, 4000);
        if (retry.containsErrorPhrase(text)) {
          container = node;
          break;
        }
      }
      if (container) matches.push({ button: element, container });
    }
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      matches.sort((a, b) => {
        const aRank = a.button.closest('[data-testid="primaryColumn"]') ? 0 : 1;
        const bRank = b.button.closest('[data-testid="primaryColumn"]') ? 0 : 1;
        return aRank - bRank;
      });
    }
    return matches[0];
  }

  function robustClick(element) {
    try {
      const rect = element.getBoundingClientRect();
      const base = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2)
      };
      element.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      element.dispatchEvent(new MouseEvent("mousedown", base));
      element.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      element.dispatchEvent(new MouseEvent("mouseup", base));
      element.dispatchEvent(new MouseEvent("click", base));
    } catch (_error) {
      try {
        element.click();
      } catch (_ignored) {
        // noop
      }
    }
  }

  function sendRetryEvent(phase, payload) {
    sendToBackground({
      type: "RATE_LIMIT_EVENT",
      phase,
      attempt: Number(payload?.attempt || 0),
      delaySec: Number(payload?.delaySec || 0),
      text: String(payload?.text || ""),
      snapshot: String(payload?.snapshot || "").slice(0, 2000),
      url: window.location.href
    });
  }

  function scheduleRateLimitCheck() {
    const rateLimit = state.rateLimit;
    if (rateLimit.checkTimer) return;
    rateLimit.checkTimer = window.setTimeout(() => {
      rateLimit.checkTimer = null;
      rateLimitTick();
    }, 400);
  }

  function rateLimitTick() {
    if (!retry || !state.active || !isAllowedPage() || !state.retrySettings.enabled) return;
    const rateLimit = state.rateLimit;
    const now = Date.now();
    const match = findRateLimitUI();
    if (match) {
      rateLimit.absentSince = 0;
      if (!rateLimit.episodeActive) {
        rateLimit.episodeActive = true;
        rateLimit.attemptsThisEpisode = 0;
        if (rateLimit.resetTimer) {
          window.clearTimeout(rateLimit.resetTimer);
          rateLimit.resetTimer = null;
        }
        state.autoScrollTicksWithoutNewPosts = 0;
        state.autoScrollIdleSince = 0;
        sendRetryEvent("detected", {
          text: "检测到X限流/加载错误提示，开始自动重试。",
          snapshot: match ? String(match.container.outerHTML || "").slice(0, 1200) : ""
        });
      }
      if (!rateLimit.pendingTimer && !rateLimit.verifyTimer && now - rateLimit.lastClickAt >= CLICK_COOLDOWN_MS) {
        scheduleRetryAttempt(rateLimit.clicksInRun > 0);
      }
    } else if (rateLimit.episodeActive) {
      if (!rateLimit.absentSince) rateLimit.absentSince = now;
      if (now - rateLimit.absentSince >= RECOVERY_GRACE_MS) {
        finishRateLimitEpisode(rateLimit.attemptsThisEpisode > 0 ? "recovered" : "cleared");
      }
    }
  }

  function scheduleRetryAttempt(isReschedule) {
    const rateLimit = state.rateLimit;
    if (rateLimit.pendingTimer) {
      window.clearTimeout(rateLimit.pendingTimer);
      rateLimit.pendingTimer = null;
    }
    const attempt = rateLimit.clicksInRun + 1;
    const delayMs = retry.computeBackoffDelayMs(attempt, state.retrySettings.baseMs, state.retrySettings.maxMs, Math.random);
    rateLimit.pendingTimer = window.setTimeout(() => {
      rateLimit.pendingTimer = null;
      performRetryClick();
    }, delayMs);
    const delaySec = Math.max(1, Math.round(delayMs / 1000));
    const text = isReschedule
      ? `仍被限流，约${delaySec}秒后再次自动点击 Retry（第${attempt}次）。`
      : `约${delaySec}秒后自动点击 Retry（第${attempt}次）。`;
    sendRetryEvent(isReschedule ? "rescheduled" : "scheduled", { attempt, delaySec, text });
  }

  function performRetryClick() {
    const rateLimit = state.rateLimit;
    if (!retry || !state.active || !isAllowedPage() || !state.retrySettings.enabled) return;
    const match = findRateLimitUI();
    if (!match) return;
    const disabled = match.button.disabled === true || match.button.getAttribute("aria-disabled") === "true";
    if (disabled || Date.now() - rateLimit.lastClickAt < CLICK_COOLDOWN_MS) {
      scheduleRetryAttempt(true);
      return;
    }
    robustClick(match.button);
    rateLimit.lastClickAt = Date.now();
    rateLimit.clicksInRun += 1;
    rateLimit.attemptsThisEpisode += 1;
    sendRetryEvent("clicked", { attempt: rateLimit.clicksInRun, text: `已自动点击 Retry（第${rateLimit.clicksInRun}次）。` });
    if (rateLimit.verifyTimer) window.clearTimeout(rateLimit.verifyTimer);
    rateLimit.verifyTimer = window.setTimeout(() => {
      rateLimit.verifyTimer = null;
      if (!retry || !state.active || !state.retrySettings.enabled) return;
      if (findRateLimitUI()) {
        warnIfRetryFlooding();
        scheduleRetryAttempt(true);
      }
    }, VERIFY_AFTER_MS);
  }

  function warnIfRetryFlooding() {
    const rateLimit = state.rateLimit;
    const level = Math.floor(rateLimit.clicksInRun / WARN_AFTER_CLICKS);
    if (level >= 1 && level > rateLimit.warnedLevel) {
      rateLimit.warnedLevel = level;
      const maxSec = Math.round(state.retrySettings.maxMs / 1000);
      sendRetryEvent("warn", {
        attempt: rateLimit.clicksInRun,
        text: `连续重试${rateLimit.clicksInRun}次仍未恢复，将继续按最长${maxSec}秒间隔自动重试；建议保持X标签页可见。`
      });
    }
  }

  function finishRateLimitEpisode(reason) {
    const rateLimit = state.rateLimit;
    if (rateLimit.pendingTimer) {
      window.clearTimeout(rateLimit.pendingTimer);
      rateLimit.pendingTimer = null;
    }
    if (rateLimit.verifyTimer) {
      window.clearTimeout(rateLimit.verifyTimer);
      rateLimit.verifyTimer = null;
    }
    const attempts = rateLimit.attemptsThisEpisode;
    rateLimit.episodeActive = false;
    rateLimit.absentSince = 0;
    rateLimit.attemptsThisEpisode = 0;
    state.autoScrollTicksWithoutNewPosts = 0;
    state.autoScrollIdleSince = 0;
    if (rateLimit.resetTimer) window.clearTimeout(rateLimit.resetTimer);
    rateLimit.resetTimer = window.setTimeout(() => {
      rateLimit.resetTimer = null;
      rateLimit.clicksInRun = 0;
      rateLimit.warnedLevel = 0;
    }, CLEAN_WINDOW_MS);
    const text = reason === "recovered"
      ? `内容已恢复加载，自动滚动继续（本轮点击${attempts}次）。`
      : "错误提示已自行消失，无需点击，自动滚动继续。";
    sendRetryEvent(reason, { attempt: attempts, text });
  }

  function cancelRateLimitActivity() {
    const rateLimit = state.rateLimit;
    if (rateLimit.pendingTimer) {
      window.clearTimeout(rateLimit.pendingTimer);
      rateLimit.pendingTimer = null;
    }
    if (rateLimit.verifyTimer) {
      window.clearTimeout(rateLimit.verifyTimer);
      rateLimit.verifyTimer = null;
    }
    if (rateLimit.checkTimer) {
      window.clearTimeout(rateLimit.checkTimer);
      rateLimit.checkTimer = null;
    }
    rateLimit.episodeActive = false;
    rateLimit.absentSince = 0;
  }

  function resetRateLimitSession() {
    cancelRateLimitActivity();
    const rateLimit = state.rateLimit;
    if (rateLimit.resetTimer) {
      window.clearTimeout(rateLimit.resetTimer);
      rateLimit.resetTimer = null;
    }
    rateLimit.clicksInRun = 0;
    rateLimit.attemptsThisEpisode = 0;
    rateLimit.warnedLevel = 0;
    rateLimit.lastClickAt = 0;
    for (const node of document.querySelectorAll('[data-xpc-mock="1"]')) node.remove();
  }

  function applyRetrySettings(raw) {
    if (!retry) return;
    const settings = retry.normalizeSettings(raw);
    state.retrySettings = {
      enabled: settings.autoRetry,
      baseMs: settings.retryBaseSec * 1000,
      maxMs: settings.retryMaxSec * 1000
    };
    if (!settings.autoRetry) cancelRateLimitActivity();
  }

  function buildRateLimitDiagnostics() {
    const report = {
      captured_at: new Date().toISOString(),
      url: window.location.href,
      collecting: state.active,
      exact_match: false,
      match_button_html: "",
      match_container_html: "",
      loose_candidates: [],
      phrase_hits: []
    };
    const match = findRateLimitUI();
    if (match) {
      report.exact_match = true;
      report.match_button_html = String(match.button.outerHTML || "").slice(0, 800);
      report.match_container_html = String(match.container.outerHTML || "").slice(0, 2000);
    }
    for (const element of document.querySelectorAll('button, [role="button"]')) {
      if (report.loose_candidates.length >= 8) break;
      const label = String(element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
      const aria = String(element.getAttribute("aria-label") || "").trim().slice(0, 40);
      const haystack = `${label} ${aria}`.toLowerCase();
      if (!haystack.includes("retry") && !haystack.includes("重试")) continue;
      report.loose_candidates.push({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || "",
        label,
        aria,
        in_article: Boolean(element.closest("article")),
        parent_text: String(element.parentElement?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160)
      });
    }
    if (retry) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && report.phrase_hits.length < 3) {
        const text = node.nodeValue || "";
        if (retry.containsErrorPhrase(text)) {
          const parent = node.parentElement;
          report.phrase_hits.push({
            text: text.replace(/\s+/g, " ").trim().slice(0, 120),
            tag: parent?.tagName?.toLowerCase() || "",
            testid: parent?.getAttribute?.("data-testid") || "",
            in_article: Boolean(parent?.closest?.("article"))
          });
        }
        node = walker.nextNode();
      }
    }
    return report;
  }

  function injectMockRateLimitUI() {
    if (!state.active || !isAllowedPage()) return false;
    for (const node of document.querySelectorAll('[data-xpc-mock="1"]')) node.remove();
    const wrapper = document.createElement("div");
    wrapper.dataset.xpcMock = "1";
    wrapper.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:2147483646;max-width:300px;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:14px 16px;box-shadow:0 10px 30px rgba(15,23,42,.2);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f1419;";
    const errorText = document.createElement("div");
    errorText.textContent = "Something went wrong. Try reloading.";
    const retryButton = document.createElement("div");
    retryButton.setAttribute("role", "button");
    retryButton.tabIndex = 0;
    retryButton.textContent = "Retry";
    retryButton.style.cssText = "display:inline-block;margin-top:10px;padding:6px 14px;border-radius:999px;color:#1d9bf0;background:rgba(29,155,240,.12);font-weight:600;cursor:pointer;";
    retryButton.addEventListener("click", () => wrapper.remove());
    wrapper.append(errorText, retryButton);
    document.body.append(wrapper);
    window.setTimeout(() => {
      if (wrapper.isConnected) wrapper.remove();
    }, 180000);
    const note = state.retrySettings.enabled ? "" : "（自动重试当前已关闭，本次不会自动点击。）";
    sendRetryEvent("simulated", { text: `已注入模拟限流UI，开始验证自动重试链路${note}` });
    scheduleRateLimitCheck();
    return true;
  }

  function startAutoScroll(intervalMs) {
    stopAutoScroll();
    state.autoScroll = true;
    state.autoScrollTicksWithoutNewPosts = 0;
    const interval = Math.max(800, Math.min(Number(intervalMs) || 1500, 10000));
    state.autoScrollTimer = window.setInterval(() => {
      if (releaseGuardIfOrphaned()) return;
      if (!state.active || Date.now() - state.lastUserActivityAt < 1200) return;
      if (state.rateLimit.episodeActive) return;
      const before = state.lastFoundCount;
      const host = findScrollHost();
      const beforeMetrics = scrollMetrics(host);
      scrollHostBy(host, Math.max(320, Math.floor(window.innerHeight * 0.78)));
      window.setTimeout(() => {
        if (state.rateLimit.episodeActive) return;
        // X may append or recycle posts after the intersection callback. Scan
        // once more after the scroll settles before deciding that it is idle.
        scanVisiblePosts();
        const afterMetrics = scrollMetrics(host);
        const foundNewPost = state.lastFoundCount !== before;
        const moved = afterMetrics.top > beforeMetrics.top + 4 || afterMetrics.height > beforeMetrics.height + 4;
        const atEnd = isAtScrollEnd(afterMetrics);
        if (foundNewPost || moved || !atEnd) {
          state.autoScrollTicksWithoutNewPosts = 0;
          state.autoScrollIdleSince = 0;
        } else {
          if (!state.autoScrollIdleSince) state.autoScrollIdleSince = Date.now();
          state.autoScrollTicksWithoutNewPosts += 1;
        }
        // Lack of a newly extracted post is only meaningful at the actual end
        // of the feed, and must persist for a grace period for lazy loading.
        if (state.autoScrollTicksWithoutNewPosts >= 5
          && Date.now() - state.autoScrollIdleSince >= 5000) {
          sendToBackground({ type: "AUTO_SCROLL_IDLE" });
          stopAutoScroll();
        }
      }, Math.min(interval - 100, 1200));
    }, interval);
  }

  function startCollectors() {
    if (state.active) return;
    state.active = true;
    state.seen.clear();
    state.lastFoundCount = 0;
    state.lastUserActivityAt = 0;
    state.scrollHost = null;
    resetRateLimitSession();
    if (!isAllowedPage()) return;

    state.intersectionObserver = new IntersectionObserver((entries) => {
      if (releaseGuardIfOrphaned()) return;
      for (const entry of entries) {
        if (entry.isIntersecting) emitPost(entry.target);
      }
    }, { threshold: 0.1 });
    state.mutationObserver = new MutationObserver(() => {
      if (releaseGuardIfOrphaned()) return;
      observeAllArticles();
      scheduleRateLimitCheck();
    });
    state.mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
    observeAllArticles();
    scanVisiblePosts();
    rateLimitTick();
  }

  function stopCollectors() {
    state.active = false;
    stopAutoScroll();
    state.scrollHost = null;
    stopObservers();
    resetRateLimitSession();
  }

  ["wheel", "touchstart", "mousedown", "keydown"].forEach((eventName) => {
    window.addEventListener(eventName, () => { state.lastUserActivityAt = Date.now(); }, { passive: true });
  });

  window.setInterval(() => {
    if (releaseGuardIfOrphaned()) return;
    if (state.active) rateLimitTick();
  }, RATE_LIMIT_POLL_MS);

  try {
    chrome.storage.local.get(["xpcSettings"], (stored) => applyRetrySettings(stored?.xpcSettings));
  } catch (_error) {
    // The extension may have been reloaded mid-injection; keep the defaults.
  }

  const handleRuntimeMessage = (message, _sender, sendResponse) => {
    // Every response below is produced synchronously, so answer once and
    // return false. The previous shape ("sendResponse(...); return true;")
    // claimed an asynchronous response that was never coming; whenever the
    // channel closed first (extension reload / stale instance) callers saw
    // "A listener indicated an asynchronous response by returning true,
    // but the message channel closed before a response was received".
    const respond = (payload) => {
      try {
        sendResponse(payload);
      } catch (_error) {
        // The channel may already be closed (e.g. the extension reloaded
        // mid-request); dropping a late response is safe.
      }
    };
    if (message?.type === "START_COLLECTING") {
      startCollectors();
      respond({ ok: true, active: state.active, pageAllowed: isAllowedPage() });
      return false;
    }
    if (message?.type === "STOP_COLLECTING") {
      stopCollectors();
      respond({ ok: true, active: false });
      return false;
    }
    if (message?.type === "AUTO_SCROLL") {
      if (message.enabled) startAutoScroll(message.intervalMs);
      else stopAutoScroll();
      respond({ ok: true, enabled: state.autoScroll });
      return false;
    }
    if (message?.type === "CONTENT_STATUS") {
      respond({ ok: true, active: state.active, autoScroll: state.autoScroll, found: state.lastFoundCount });
      return false;
    }
    if (message?.type === "SIMULATE_RATE_LIMIT") {
      respond({ ok: true, injected: injectMockRateLimitUI() });
      return false;
    }
    if (message?.type === "APPLY_RETRY_SETTINGS") {
      applyRetrySettings(message.settings);
      respond({ ok: true });
      return false;
    }
    if (message?.type === "CAPTURE_RATE_LIMIT_DIAGNOSTICS") {
      respond({ ok: true, report: buildRateLimitDiagnostics() });
      return false;
    }
    if (message?.type === "PING") {
      respond({ ok: true, active: state.active });
      return false;
    }
    return false;
  };

  try {
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  } catch (_error) {
    // The extension may have been reloaded mid-injection; the heartbeat will
    // release the guard shortly.
  }
})();
