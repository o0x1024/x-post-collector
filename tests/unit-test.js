"use strict";

const assert = require("node:assert/strict");
const utils = require("../shared/utils.js");
const markdown = require("../shared/markdown.js");
const retry = require("../shared/retry.js");

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
assert.equal(retry.matchRetryLabel("Retry"), true);
assert.equal(retry.matchRetryLabel(" retry. "), true);
assert.equal(retry.matchRetryLabel("重试"), true);
assert.equal(retry.matchRetryLabel("Retry now"), false);
assert.equal(retry.containsErrorPhrase("Something went wrong. Try reloading."), true);
assert.equal(retry.containsErrorPhrase("all good here"), false);
const retryDefaults = retry.normalizeSettings(undefined);
assert.equal(retryDefaults.autoRetry, true);
assert.equal(retryDefaults.retryBaseSec, 30);
assert.equal(retryDefaults.retryMaxSec, 360);
assert.equal(retry.normalizeSettings({ retryBaseSec: 1 }).retryBaseSec, 3);
assert.equal(retry.normalizeSettings({ retryBaseSec: 300, retryMaxSec: 60 }).retryMaxSec, 300);
assert.equal(retry.normalizeSettings({ autoRetry: false }).autoRetry, false);
const midJitter = (step) => retry.computeBackoffDelayMs(step, 30000, 360000, () => 0.5);
assert.deepEqual(
  [1, 2, 3, 4, 5, 6, 20].map(midJitter),
  [30000, 60000, 120000, 240000, 360000, 360000, 360000]
);
assert.equal(retry.computeBackoffDelayMs(1, 30000, 360000, () => 1), 36000);
assert.equal(retry.computeBackoffDelayMs(5, 30000, 360000, () => 1), 360000);
console.log("x-post-collector unit tests passed");
