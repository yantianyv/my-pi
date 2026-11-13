---
name: web-ui-review
description: 按 Web Interface Guidelines 逐条审查前端 UI 代码（可访问性、焦点、表单、动效、排版、性能、深链、触摸、暗色、i18n、水合、文案）。当被要求「审查我的 UI」「检查可访问性」「审一下设计」「UX 走查」「页面符合最佳实践吗」时使用。
---

# Web UI 审查

对指定文件逐条对照下面的规则，输出 `file:line + 问题`。这是**合规检查**，不是冗余审查——两件事分工不同：合规看「有没有做到该做的」，冗余看「有没有多写不该写的」。同一段代码不要两边各报一遍。

## 怎么用

1. 用户给了文件或 glob 就用它；没给就问「审哪些文件」。
2. 读文件，逐节过一遍规则。
3. 只报**命中**的条目，跳过的不用说明。全部通过的文件写 `✓ pass`。
4. 不解释显而易见的修法。修法不直观时才补一句。

## 输出格式

按文件分组，`file:line` 形式（编辑器可跳转）：

```
## src/Button.tsx

src/Button.tsx:42 - 图标按钮缺 aria-label
src/Button.tsx:18 - input 缺 label
src/Button.tsx:55 - 动效没有 prefers-reduced-motion 兜底
src/Button.tsx:67 - transition: all → 列出具体属性

## src/Modal.tsx

src/Modal.tsx:12 - 缺 overscroll-behavior: contain

## src/Card.tsx

✓ pass
```

只写问题 + 位置。不写前言，不写总结。

## 规则

### 可访问性

- 纯图标按钮需要 `aria-label`
- 表单控件需要 `<label>` 或 `aria-label`
- 可交互元素需要键盘处理（`onKeyDown` / `onKeyUp`）
- 动作用 `<button>`，跳转用 `<a>` / `<Link>`，不用 `<div onClick>`
- 图片需要 `alt`（纯装饰用 `alt=""`）
- 装饰性图标需要 `aria-hidden="true"`
- 异步更新（toast、校验提示）需要 `aria-live="polite"`
- 优先语义 HTML（`<button>`、`<a>`、`<label>`、`<table>`），语义不够才上 ARIA
- 标题层级严格 `<h1>`–`<h6>`；主内容前加 skip link
- 标题锚点加 `scroll-margin-top`
- 有信息的媒体需要字幕、文字稿或描述
- 媒体控件要支持键盘；纯装饰媒体对辅助技术隐藏

### 焦点态

- 可交互元素必须有可见焦点：`focus-visible:ring-*` 或等价方案
- 不要在没有替代焦点样式的情况下用 `outline-none` / `outline: none`
- 用 `:focus-visible` 而非 `:focus`（避免鼠标点击也出焦点环）
- 复合控件用 `:focus-within` 做整组焦点
- 吸顶头尾、浮层不得遮住已聚焦元素

### 表单

- 输入框需要 `autocomplete` 与有意义的 `name`
- 用正确的 `type`（`email`、`tel`、`url`、`number`）与 `inputmode`
- 不要拦截粘贴（`onPaste` + `preventDefault`）
- label 可点（`htmlFor` 或包裹控件）
- 邮箱、验证码、用户名关掉拼写检查（`spellCheck={false}`）
- 复选框／单选框：label 与控件共用同一个点击区域，不留死区
- 提交按钮在请求开始前保持可用，请求中转为 spinner
- 错误信息就近显示在字段旁；提交时聚焦第一个错误
- placeholder 以 `…` 结尾并给出示例格式
- 非认证类字段加 `autocomplete="off"`，避免密码管理器误触发
- 有未保存内容时导航前警告（`beforeunload` 或路由守卫）

### 动效

- 遵守 `prefers-reduced-motion`（提供简化版或直接关掉）
- 只动 `transform` / `opacity`（合成器友好）
- 不用 `transition: all`，逐条列出属性
- 设对 `transform-origin`
- SVG 变换放在 `<g>` 上，配 `transform-box: fill-box; transform-origin: center`
- 动效可被中断，用户输入时立即响应
- 超过 5 秒的自动播放动效，若与其他内容并存需提供暂停／停止／隐藏
- 静音循环动效在 `prefers-reduced-motion` 下必须停下

### 排版

- 用 `…` 不用 `...`
- 数字列与对比数字用 `font-variant-numeric: tabular-nums`
- 标题用 `text-wrap: balance` 或 `text-pretty`，避免孤字
- 加载态以 `…` 结尾：`"Loading…"`、`"Saving…"`

**仅英文文案**（中文界面跳过这两条）：弯引号 `“ ”` 而非直引号 `"`；不可断空格 `10&nbsp;MB`、`⌘&nbsp;K`、品牌名。

### 内容承载

- 文本容器要处理长内容：`truncate`、`line-clamp-*` 或 `break-words`
- flex 子项加 `min-w-0`，否则文字截断失效
- 处理空状态，空字符串／空数组不能渲染出残缺 UI
- 用户生成内容要考虑极短、常规、极长三种输入

### 图片

- `<img>` 需要显式 `width` 与 `height`（防 CLS）
- 首屏以下的图：`loading="lazy"`
- 首屏关键图：`priority` 或 `fetchpriority="high"`

### 性能

- 大列表（>50 项）要虚拟化（`virtua`、`content-visibility: auto`）
- 渲染期不读布局（`getBoundingClientRect`、`offsetHeight`、`offsetWidth`、`scrollTop`）
- 批量读写 DOM，不要交替穿插
- 优先非受控输入；受控输入每次按键的开销要低
- CDN／资源域加 `<link rel="preconnect">`
- 关键字体用 `<link rel="preload" as="font">` 配 `font-display: swap`
- 动图优先用 `<video autoplay muted loop playsinline>` 替代 GIF，并提供静态替代
- Safari 下的短循环：H.264 MP4 `<picture>` 源 + `prefers-reduced-motion` 条件 + 静态兜底

### 导航与状态

- URL 反映状态：筛选、标签页、分页、展开面板都进 query 参数
- 链接用 `<a>` / `<Link>`（保住 Cmd/Ctrl 点击、中键新开）
- 有状态的 UI 尽量深链（用了 `useState` 就考虑用 `nuqs` 之类同步到 URL）
- 破坏性操作要二次确认或撤销窗口，绝不立即执行

### 触摸与手势

- `touch-action: manipulation`（去掉双击缩放延迟）
- `-webkit-tap-highlight-color` 要有意设置
- 模态、抽屉、底部面板加 `overscroll-behavior: contain`
- 回弹抑制：`@media (pointer: fine)` 内给 `<html>` 置 `overscroll-behavior: none`，粗指针保留页面下拉刷新；`none` 同时会禁用滚动链与原生侧滑返回，混合输入设备要实测
- 拖拽时禁用文本选择，被拖元素加 `inert`
- 拖、滑、捏、划路径的手势必须有点击与键盘替代，除非该交互非它不可
- `autoFocus` 慎用：桌面端且只有一个主输入框时才行，移动端避开

### 安全区与布局

- 满宽布局需要 `env(safe-area-inset-*)` 适配刘海
- 消除意外滚动条：容器 `overflow-x-hidden`，从根上修内容溢出
- 布局优先 flex/grid，不要用 JS 量尺寸

### 暗色与主题

- 暗色主题在 `<html>` 上设 `color-scheme: dark`（修正滚动条与表单控件）
- `<meta name="theme-color">` 与页面背景一致
- 原生 `<select>` 显式设置 `background-color` 与 `color`（Windows 暗色下会发白）

### 语言与本地化

- 日期时间用 `Intl.DateTimeFormat`，不硬编码格式
- 数字与货币用 `Intl.NumberFormat`，不硬编码格式
- 语言检测用 `Accept-Language` / `navigator.languages`，不靠 IP
- 品牌名、代码标识、ID 加 `translate="no"`，防止浏览器自动翻译误伤

### 水合安全

- 带 `value` 的输入必须配 `onChange`（或改用 `defaultValue` 走非受控）
- 日期时间渲染要防服务端与客户端不一致
- `suppressHydrationWarning` 只在确实需要处使用

### 悬停与交互反馈

- 按钮与链接要有 `hover:` 态
- 交互态的对比度递增：hover / active / focus 都要比静止态更醒目

### 文案

- 主动语态：「安装 CLI」而非「CLI 将被安装」
- 数量用数字：`8 次部署` 而非 `八次部署`
- 按钮标签写具体动作：「保存 API Key」而非「继续」
- 错误信息给出修复办法或下一步，不能只说问题
- 第二人称，避免第一人称
- 空间紧张时用 `&` 代替 `and`（仅英文）

**仅英文文案**（中文界面跳过）：标题与按钮用 Title Case（Chicago 风格）。

## 常见反模式（看到就报）

- `user-scalable=no` 或 `maximum-scale=1` 禁止缩放
- `onPaste` 配 `preventDefault`
- `transition: all`
- `outline-none` 没有 `focus-visible` 替代
- 行内 `onClick` 做导航而非 `<a>`
- `<div>` / `<span>` 挂点击事件（应为 `<button>`）
- 图片没有尺寸
- 大数组直接 `.map()` 不虚拟化
- 表单输入没有 label
- 图标按钮没有 `aria-label`
- 硬编码日期／数字格式（应用 `Intl.*`）
- 没有充分理由的 `autoFocus`
- 该用压缩视频却用动图
- 只有手势、没有点击与键盘替代

---

规则文本来自 [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines)（MIT License），随本 skill 一起分发以保证离线可用。上游若有更新，重新取 `command.md` 并替换本文件「规则」一节即可，取用地址：`https://cdn.jsdelivr.net/gh/vercel-labs/web-interface-guidelines@main/command.md`。
