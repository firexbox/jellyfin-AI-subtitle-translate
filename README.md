# Jellyfin 双语字幕 AI 翻译器 (Edge/Chrome 扩展)

一个专为 Jellyfin 媒体服务器打造的浏览器扩展，在 Web 客户端播放视频时自动捕获原文字幕，调用 AI 实时翻译，并以双语形式叠加显示在视频画面上。

---

## 功能特点

- **AI 多引擎翻译**：支持 OpenAI（及兼容 API）、Google Gemini、DeepSeek，可自定义 API 地址和模型
- **全格式字幕解析**：SRT、ASS/SSA、WebVTT，支持多行重叠字幕（如 ASS 特效字幕）
- **零延迟播放**：视频加载后后台批量预翻译整集字幕，播放时按时间轴即时匹配显示
- **智能位置适配**：字幕层自动跟随视频位置，支持窗口模式、浏览器全屏、网页全屏无缝切换
- **双语显示模式**：翻译字幕可显示在画面顶部或底部，支持隐藏原文字幕
- **翻译缓存机制**：本地缓存已翻译内容，切换字幕或回放时无需重复请求

---

## 安装方法

### 开发者模式加载

1. 打开 Edge/Chrome 浏览器，访问 `edge://extensions/` 或 `chrome://extensions/`
2. 开启右上角"开发者模式"
3. 点击"加载解压缩的扩展"
4. 选择本项目文件夹

### 打包安装

```bash
cd jellyfin-dual-subtitle-ext
bash package.sh
```

生成的 `jellyfin-dual-subtitle-1.0.0.zip` 可拖拽到扩展管理页面安装。

---

## 配置说明

1. 点击浏览器工具栏的扩展图标打开弹窗
2. 点击"打开设置"进入配置页面
3. 选择 AI 提供商并填写 API Key
4. 设置目标语言（默认中文）和显示选项（位置、字号等）
5. 保存并启用

## 支持的 AI 提供商

| 提供商 | 默认模型 | 说明 |
|---------|---------|------|
| OpenAI | gpt-4o-mini | 需要 OpenAI API Key |
| Google Gemini | gemini-2.0-flash-lite | 需要 Gemini API Key |
| DeepSeek | deepseek-chat | 需要 DeepSeek API Key |
| 自定义 | - | 任意 OpenAI 兼容 API |

---

## 技术架构

```
├── manifest.json              # 扩展清单 (Manifest V3)
├── background/
│   └── background.js           # 后台代理（处理跨域 API 请求）
├── content_scripts/
│   ├── jellyfin-inject.js      # 主注入脚本（Render Loop 核心）
│   ├── subtitle-capturer.js    # 字幕捕获引擎
│   ├── subtitle-renderer.js    # 双语渲染引擎（Shadow DOM）
│   └── dual-subtitle.css       # 辅助样式
├── lib/
│   ├── subtitle-parser.js      # SRT/ASS/VTT 解析库
│   └── ai-providers.js         # AI 翻译接口封装
├── popup/
│   ├── popup.html              # 快速开关弹窗
│   └── popup.js
├── options/
│   ├── options.html            # 详细设置页面
│   └── options.js
└── _locales/                   # 多语言支持 (zh_CN, en)
```

---

## 工作原理

### 1. 字幕捕获（双路径）
- **文件拦截**：通过拦截页面 `fetch` 请求，在 Jellyfin 加载 `.srt/.ass/.vtt` 字幕文件时直接获取原始内容
- **实时监听**：监听 `video` 元素的 `TextTrack` cuechange 事件和 DOM Mutation，捕获当前活跃字幕

### 2. 字幕解析与预翻译
- 使用 `SubtitleParser` 解析字幕文件，建立完整的时间轴索引
- 视频加载后立即在后台**批量预翻译整集字幕**，结果存入缓存
- 播放阶段根据 `video.currentTime` 直接匹配对应时间段的已翻译字幕，实现**零延迟显示**

### 3. Render Loop 驱动显示
采用 `timeupdate` + `requestAnimationFrame` 主循环架构：
```
每帧刷新 → 读取当前播放时间 → 匹配活跃字幕 cues → 
用最新缓存构建显示文本 → 无条件更新渲染层
```
此架构彻底消除了 API 异步回调与视频进度之间的竞态条件。翻译结果一旦进入缓存，下一帧自动被渲染循环 pickup，不会再出现"翻译完成时视频已播放到下一条"的跳过问题。

### 4. Shadow DOM 隔离渲染
字幕层挂载于 `attachShadow({mode: 'closed'})` 中：
- 页面全局 CSS 完全无法穿透，避免 Jellyfin 主题样式污染
- 容器独立于页面 DOM 树，不会被其他脚本的 DOM 操作误移除
- 使用浏览器最大 `z-index: 2147483647`，确保始终置顶
- 防移除守护机制每 2 秒检测，若被移除自动重建

---

## 开发历程与关键问题修复

本项目经历了多轮迭代优化，解决了浏览器扩展在复杂视频播放器环境中常见的各类难题：

| 遇到的问题            | 根本原因                                        | 解决方案                                             |
| ---------------- | ------------------------------------------- | ------------------------------------------------ |
| **翻译字幕完全不显示**    | 字幕层被 Jellyfin 播放器的 `overflow: hidden` 父容器裁剪 | 从 `absolute` 定位改为 `fixed` 视口定位，脱离容器限制            |
| **样式被页面 CSS 覆盖** | Jellyfin 全局样式污染了字幕容器的 `opacity`/`display`   | 使用 Shadow DOM 封闭隔离，彻底阻断外部样式穿透                    |
| **全屏模式下字幕消失**    | 浏览器全屏时 z-index 层级被原生控制条覆盖                   | Shadow DOM + `z-index: 2147483647` + 全屏事件监听重定位   |
| **API 请求造成明显延迟** | 每条新字幕实时请求 AI，往返 300ms~2000ms                | 字幕文件预翻译：视频加载时后台批量翻译整集，播放时直接查缓存                   |
| **多条字幕只显示一条**    | 多个 active cue 被合并成一条大文本翻译，API 返回数组但只取 `[0]` | 将 cues 作为数组逐条处理，每条独立翻译后合并显示                      |
| **翻译结果频繁跳过**     | API 异步回调完成时，视频已播放到下一条，闭包中保存的是旧 cues         | **Render Loop 架构**：放弃事件回调驱动，改用每帧轮询，始终读取当前时间对应的字幕 |
| **字幕更新有拖影/闪烁**   | `transition: opacity` 动画和频繁 DOM 操作冲突        | 移除过渡动画，增加 16ms 帧级去重，强制 `textContent` 更新          |
| **字幕被其他脚本移除**    | Jellyfin 播放器框架的 DOM 操作意外移除了字幕元素             | 防移除守护定时器，检测到 host 消失后自动重建                        |

---

## License

MIT
