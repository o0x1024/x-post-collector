"use strict";

const assert = require("node:assert/strict");
const utils = require("../shared/utils.js");
const markdown = require("../shared/markdown.js");

assert.equal(utils.normalizeText("  hello\u00a0 world\n\n\nnext  "), "hello world\n\nnext");
assert.equal(utils.extractStatusId("https://x.com/demo/status/123456789"), "123456789");
assert.equal(utils.extractStatusId("https://x.com/demo"), "");
assert.equal(utils.absoluteUrl("/demo/status/1", "https://x.com/home"), "https://x.com/demo/status/1");
assert.equal(utils.shortHash("same input"), utils.shortHash("same input"));
assert.notEqual(utils.shortHash("a"), utils.shortHash("b"));
assert.equal(markdown.safeFileName("123/hello world", "fallback"), "123-hello-world");
assert.equal(markdown.imageExtension("image/png", "https://pbs.twimg.com/media/a"), "png");
assert.match(
  markdown.markdownForPost(
    { author_name: "Alice", post_id: "1", text: "hello", post_url: "https://x.com/a/status/1" },
    [{ localPath: "../media/1-01.jpg", alt: "猫" }]
  ),
  /!\[猫\]\(\.\.\/media\/1-01\.jpg\)/
);
console.log("x-post-collector unit tests passed");
