(function initXPostUtils(global) {
  "use strict";

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function extractStatusId(href) {
    const match = String(href || "").match(/\/status\/(\d+)/i);
    return match ? match[1] : "";
  }

  function absoluteUrl(href, base) {
    try {
      return new URL(href, base || global.location?.href).href;
    } catch (_error) {
      return "";
    }
  }

  function shortHash(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  const api = { normalizeText, extractStatusId, absoluteUrl, shortHash };
  global.XPostUtils = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
