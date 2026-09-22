(function initXPostRetry(global) {
  "use strict";

  const DEFAULT_SETTINGS = { autoRetry: true, retryBaseSec: 30, retryMaxSec: 360 };
  const RETRY_LABELS = new Set(["retry", "重试"]);
  const ERROR_PATTERNS = [
    /something went wrong/i,
    /try reloading/i,
    /try again/i,
    /rate limit/i,
    /too many requests/i,
    /出错了/,
    /稍后重试/,
    /频率限制/
  ];

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeLabel(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .replace(/[.!。！]+$/, "");
  }

  function matchRetryLabel(value) {
    return RETRY_LABELS.has(normalizeLabel(value));
  }

  function containsErrorPhrase(value) {
    const text = String(value || "");
    return ERROR_PATTERNS.some((pattern) => pattern.test(text));
  }

  function normalizeSettings(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    let baseSec = Number(source.retryBaseSec);
    let maxSec = Number(source.retryMaxSec);
    if (!Number.isFinite(baseSec)) baseSec = DEFAULT_SETTINGS.retryBaseSec;
    if (!Number.isFinite(maxSec)) maxSec = DEFAULT_SETTINGS.retryMaxSec;
    baseSec = clamp(Math.round(baseSec), 3, 600);
    maxSec = clamp(Math.round(maxSec), 10, 3600);
    if (maxSec < baseSec) maxSec = baseSec;
    return { autoRetry: source.autoRetry !== false, retryBaseSec: baseSec, retryMaxSec: maxSec };
  }

  function computeBackoffDelayMs(attempt, baseMs, maxMs, random) {
    const step = Math.max(1, Math.floor(Number(attempt) || 1));
    const base = Math.max(1000, Number(baseMs) || DEFAULT_SETTINGS.retryBaseSec * 1000);
    const cap = Math.max(base, Number(maxMs) || DEFAULT_SETTINGS.retryMaxSec * 1000);
    const rand = typeof random === "function" ? clamp(Number(random()) || 0, 0, 1) : 0.5;
    const exponent = Math.min(step - 1, 20);
    const rawDelay = Math.min(base * Math.pow(2, exponent), cap);
    const jitter = 0.8 + 0.4 * rand;
    return Math.min(cap, Math.max(1000, Math.round(rawDelay * jitter)));
  }

  const api = {
    DEFAULT_SETTINGS,
    RETRY_LABELS,
    ERROR_PATTERNS,
    normalizeLabel,
    matchRetryLabel,
    containsErrorPhrase,
    normalizeSettings,
    computeBackoffDelayMs
  };
  global.XPostRetry = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
