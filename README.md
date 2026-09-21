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

## 检查

在仓库根目录执行：

```bash
node x-post-collector/tests/unit-test.js
node --check x-post-collector/background.js
node --check x-post-collector/content.js
node --check x-post-collector/sidepanel.js
```
