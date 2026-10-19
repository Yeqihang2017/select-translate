# 划词翻译 · 本地优先

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](https://developer.chrome.com/docs/extensions/develop/migrate)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

一个轻量的 Chrome 划词翻译扩展。**Chrome 内置本地模型优先，云 API 兜底**，默认零配置、零 Key、零网络请求即可工作。

## 功能

| 能力 | 说明 |
|---|---|
| 划词翻译 | 选中任意文字，鼠标松开即出译文 |
| 句子 / 段落 | 长文本按句切块（800 字符/块）顺序翻译，避免模型输入过长导致质量下降 |
| 原文 + 译文 | 弹窗上下分区，原文可滚动、可选中 |
| 点词查义 | 原文按词切分，点任意单词查该词释义（中英文都支持，中文靠 `Intl.Segmenter` 分词） |
| 生词本 | 词卡内一键收藏，存入 `chrome.storage.local`；下次划到包含该词的句子时，词在原文中高亮（琥珀色下划线） |
| 音标 | 英文单词自动补 IPA 音标（dictionaryapi.dev，失败静默） |

## 安装

1. 打开 `chrome://extensions`
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录
4. 任意网页选中文字即可

点工具栏图标会在**侧边栏**打开设置，不占用标签页、不抢页面焦点。生词本也可以在侧边栏里直接管理；需要更大视野时，在 `chrome://extensions` 里点「扩展程序选项」会以整页打开同一份界面。

> 要求 Chrome 138+ 桌面版（内置 Translator API）。低版本只能用云端引擎。

## 配置

点工具栏图标打开侧边栏。

### 引擎策略

- **自动**（默认）：先走本地模型，语向不支持时自动降级到云端
- **仅本地**：完全离线，不支持时直接报错
- **仅云端**：始终走云 API，质量更稳定

### 云端兜底（可选）

**DeepL**
- 免费额度每月 50 万字符，Key 以 `:fx` 结尾
- 注册：https://www.deepl.com/pro-api

**百度翻译**
- 个人认证后每月 100 万字符免费，国内直连 30–60 ms
- 注册：https://fanyi-api.baidu.com

密钥只存在本地 `chrome.storage.local`，不会上传。

## 结构

```
manifest.json     MV3 清单
background.js     Service worker：云 API 代理、音标查询、offscreen 调度
content.js        选区捕获、弹窗渲染、本地模型调用、分词与生词本
offscreen.html/js 扩展上下文中的内置模型宿主（content script 拿不到 Translator 时兜底）
options.html/js   设置与生词本管理（同时作为侧边栏和扩展选项页）
```

### 为什么本地调用放在 content script

`Translator.create()` 需要用户手势（user activation）。content script 在 `mouseup` 上触发，天然带手势；同时省掉一次消息往返。若某些页面拿不到 `Translator`，会自动回退到 offscreen document（由 service worker 创建）。

### 长文本为什么切块

Chrome 内置翻译是串行处理的，且单次输入过长会明显掉质量。`splitChunks()` 用 `Intl.Segmenter` 按句切分，再按 800 字符聚合，逐块翻译后拼接，拼接结果与原文逐字一致。

## 已知限制

- **仅顶层 frame**：`all_frames: false`，iframe 内的选区不会触发
- **移动端不支持**：Chrome 内置 Translator API 只在桌面版提供
- **小语种**：内置模型约支持 40 种语言，未覆盖的语向需配云端
- **页面高亮**：生词只在弹窗内高亮，不会改写网页 DOM（避免破坏页面结构）
- **字符上限**：单次选中超过 5000 字符不触发

## 调试

### 划词没反应时

点工具栏图标进入设置页，滚到底部「诊断」→「检测当前标签页」，会直接告诉你内容脚本有没有注入、页面拿不拿得到 `Translator`、当前选区是什么。

> 在侧边栏里，诊断直接取当前窗口的活动标签页；若界面是以整页方式打开的，service worker 会维护一个最近激活标签页的栈（存在 `storage.session` 中），自动跳过设置页本身，取"上一个普通标签页"。输出里的「运行位置」「目标标签页 ID」「页面地址」就是实际被检测的对象。

判定顺序：

1. **内容脚本未响应** → 扩展没注入。依次检查：`chrome://extensions` 是否有报错并点「重新加载」、页面是否为 `chrome://` / 扩展商店 / PDF、`file://` 页面是否开启「允许访问文件网址」、Chrome 是否 ≥ 138。
2. **内容脚本已响应，但选区为空** → 页面把选区清掉了（部分阅读器、看板类站点会这么做），或文字在 canvas 里（如 Google Docs 部分视图）。
3. **选区正常但翻译失败** → 看弹窗内的错误文案，或页面 Console 里 `[划词翻译]` 的 warn。

### 其他

- 页面 Console 会输出 `[划词翻译] content script ready` 和每次选区长度，需在 DevTools 里开启 Verbose 级别才能看到
- 云 API 失败：`chrome://extensions` → 本扩展 → 「Service Worker」查看网络错误
- 本地模型状态：设置页点「检测本地引擎」，返回 `available` / `downloadable` / `unavailable`

## 协议

[MIT](LICENSE) © 2026 select-translate contributors
