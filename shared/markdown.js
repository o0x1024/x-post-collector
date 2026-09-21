(function initXPostMarkdown(global) {
  "use strict";

  function safeFileName(value, fallback) {
    const cleaned = String(value || "")
      .replace(/[^a-zA-Z0-9._@-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return cleaned || fallback || "x-post";
  }

  function imageExtension(contentType, url) {
    const type = String(contentType || "").split(";")[0].toLowerCase();
    const byType = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/avif": "avif"
    };
    if (byType[type]) return byType[type];
    try {
      const suffix = new URL(url).pathname.match(/\.(jpe?g|png|gif|webp|avif)$/i);
      if (suffix) return suffix[1].toLowerCase().replace("jpeg", "jpg");
    } catch (_error) {
      // Use the safe default below when an image URL is malformed.
    }
    return "jpg";
  }

  function markdownForPost(post, imageRefs) {
    const title = post.author_name || post.author_handle || post.post_id || "X帖子";
    const author = [post.author_name, post.author_handle].filter(Boolean).join(" ");
    const metadata = [
      `- 作者：${author || "未知"}`,
      `- 发布时间：${post.published_at || "未知"}`,
      `- 原帖：[打开帖子](${post.post_url || post.source_url || ""})`,
      `- 采集时间：${post.captured_at || "未知"}`
    ].join("\n");
    const body = post.text || "（无文字内容）";
    const images = (imageRefs || []).map((image, index) => {
      const alt = image.alt || `图片${index + 1}`;
      const target = image.localPath || image.remoteUrl;
      return target ? `![${alt}](${target})` : `<!-- 图片${index + 1}下载失败 -->`;
    }).join("\n\n");
    return `# ${title}\n\n${metadata}\n\n---\n\n${body}\n${images ? `\n\n## 图片\n\n${images}\n` : ""}`;
  }

  const api = { safeFileName, imageExtension, markdownForPost };
  global.XPostMarkdown = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
