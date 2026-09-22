# X可见帖子采集器

这是一个Manifest V3 Chrome扩展，用于采集已打开的`x.com`标签页中进入浏览器视窗的公开帖子，并写入用户选择的本地目录。

## 使用

1. 打开Chrome，访问 `chrome://extensions`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本目录 `x-post-collector`。
4. 打开一个或多个X标签页并登录。
5. 点击扩展图标，打开侧边栏。
6. 选择保存目录，点击“开始采集”。
7. 正常滚动X页面；进入视窗的新帖子会自动保存。
8. 如需自动滚动，选择目标标签页后打开“自动滚动当前标签页”。
9. 点击“停止”完成当前会话。

输出文件：

- `posts/<post-id>.md`：每条帖子一个Markdown文件；
- `media/<post-id>-01.jpg`：帖子中的图片文件；
- `session-manifest-<session>.json`：会话统计、Markdown文件和媒体文件列表。

Markdown文件会使用相对路径嵌入已经下载的图片。图片下载失败时会保留原始远程图片链接，不会丢弃帖子正文。

## 采集边界

- 只读取页面已经渲染并进入视窗的DOM内容，不调用X内部API。
- 默认排除`/messages`、`/settings`、`/notifications`和`/i/`路径。
- 不读取Cookie、Token或其他浏览器凭证。
- 默认保存正文、作者、时间、帖子链接、图片Alt文本，并尝试下载图片二进制到`media/`目录。
- X调整页面DOM后，帖子选择器可能需要更新。

## 限流自动重试（v0.2.0）

采集过程中如果X页面出现限流错误（例如 "Something went wrong. Try reloading." 与 Retry 按钮），扩展会自动处理，无需手动点击：

- 自动识别该错误提示（英文/中文文案均支持）；
- 按退避策略等待后自动点击 Retry：默认首次等待30秒，之后逐次翻倍（30→60→120→240→360秒封顶），带随机抖动；
- 等待期间暂停自动滚动，恢复后自动继续，不会误判为“已到当前内容底部”；
- 全过程写入侧栏“运行日志”，并计入“重试”统计。

侧栏“采集控制”中可调整：是否自动重试、首次等待秒数、最大等待秒数（默认30/360，保存在浏览器本地）。

自测方式：开始采集后，点击“自测：模拟限流并验证自动重试”，扩展会注入一个模拟错误UI，约40秒内在运行日志中可看到“检测 → 等待 → 自动点击 → 恢复”的完整过程。

诊断方式：真实限流发生时，扩展会自动把现场快照保存到保存目录的 `diagnostics/` 文件夹；如果发现限流未被自动处理，点击“诊断：捕获当前限流信息”，会把“精确命中/疑似Retry候选/错误文案位置”报告一并保存（未选择目录时显示摘要），用于校准识别规则。

注意：Chrome会节流后台标签页的定时器，长时间在后台可能延迟重试，建议保持目标X标签页可见；更新代码后需在 `chrome://extensions` 点击“重新加载”使扩展生效。

## 检查

在仓库根目录执行：

```bash
node x-post-collector/tests/unit-test.js
node x-post-collector/tests/double-injection-test.js
node x-post-collector/tests/messaging-contract-test.js
node x-post-collector/tests/context-invalidation-test.js
node --check x-post-collector/background.js
node --check x-post-collector/content.js
node --check x-post-collector/sidepanel.js
```

## 故障排查

- 面板报错“A listener indicated an asynchronous response by returning true...”：扩展重载瞬间旧消息通道被关闭所致；v0.2.2 起所有监听器要么同步应答（content）、要么对已关闭通道静默丢弃（background/sidepanel），不再产生该报错。
- 未开启自动滚动但页面仍在滚动：页面里残留了更新前的旧实例；刷新X标签页即可清除（v0.2.2 起旧实例会在扩展重载后约1秒内自动停止）。关闭“自动滚动”开关现在会停止所有X标签页的滚动。
- 页面控制台报“Uncaught Error: Extension context invalidated.”：扩展重载后，旧页面实例失去 chrome.* 权限时产生的残留报错；v0.2.3 起所有 chrome.* 调用都有保护，旧实例在重载后第一次活动（滚动/新帖子/观察回调）时立即自我清理，不再等待心跳、也不再可能抛出未捕获错误。重新加载扩展并刷新X标签页即可清除。
