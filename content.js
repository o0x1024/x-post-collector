(function initXPostCollector() {
  "use strict";

  const utils = globalThis.XPostUtils;
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
    mutationObserver: null
  };

  const EXCLUDED_PATHS = ["/messages", "/settings", "/notifications", "/i/"];

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

  function emitPost(article) {
    if (!state.active) return false;
    const post = extractPost(article);
    if (!post || state.seen.has(post.dedupe_key)) return false;
    state.seen.add(post.dedupe_key);
    state.lastFoundCount += 1;
    void chrome.runtime.sendMessage({ type: "POST_FOUND", post });
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

  function startAutoScroll(intervalMs) {
    stopAutoScroll();
    state.autoScroll = true;
    state.autoScrollTicksWithoutNewPosts = 0;
    const interval = Math.max(800, Math.min(Number(intervalMs) || 1500, 10000));
    state.autoScrollTimer = window.setInterval(() => {
      if (!state.active || Date.now() - state.lastUserActivityAt < 1200) return;
      const before = state.lastFoundCount;
      const host = findScrollHost();
      const beforeMetrics = scrollMetrics(host);
      scrollHostBy(host, Math.max(320, Math.floor(window.innerHeight * 0.78)));
      window.setTimeout(() => {
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
          void chrome.runtime.sendMessage({ type: "AUTO_SCROLL_IDLE" });
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
    if (!isAllowedPage()) return;

    state.intersectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) emitPost(entry.target);
      }
    }, { threshold: 0.1 });
    state.mutationObserver = new MutationObserver(() => observeAllArticles());
    state.mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
    observeAllArticles();
    scanVisiblePosts();
  }

  function stopCollectors() {
    state.active = false;
    stopAutoScroll();
    state.scrollHost = null;
    stopObservers();
  }

  ["wheel", "touchstart", "mousedown", "keydown"].forEach((eventName) => {
    window.addEventListener(eventName, () => { state.lastUserActivityAt = Date.now(); }, { passive: true });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "START_COLLECTING") {
      startCollectors();
      sendResponse({ ok: true, active: state.active, pageAllowed: isAllowedPage() });
      return true;
    }
    if (message?.type === "STOP_COLLECTING") {
      stopCollectors();
      sendResponse({ ok: true, active: false });
      return true;
    }
    if (message?.type === "AUTO_SCROLL") {
      if (message.enabled) startAutoScroll(message.intervalMs);
      else stopAutoScroll();
      sendResponse({ ok: true, enabled: state.autoScroll });
      return true;
    }
    if (message?.type === "CONTENT_STATUS") {
      sendResponse({ ok: true, active: state.active, autoScroll: state.autoScroll, found: state.lastFoundCount });
      return true;
    }
    return false;
  });
})();
