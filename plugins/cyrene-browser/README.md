# Cyrene 内置浏览器

可安装插件。它直接使用 Cyrene 随 Electron 携带的 Chromium，在独立窗口中显示网页；用户和 Agent 操作的是同一组标签页，不会启动系统 Edge。

## 0.3.0 更新

- 修复窗口被遮挡、最小化或 Chromium 节流动画帧时，元素操作可能一直不返回的问题；页面脚本和等待轮询现在都有明确超时。
- 页面快照新增 `scope=document`，可发现视口外的交互元素，再通过 `scrollIntoView` 操作。
- Agent 标签页工具新增后退、前进、刷新和停止加载。
- 修正带 CSS 缩放的同源 iframe 元素坐标，并让拖拽过程更接近真实指针移动。
- 截图自动只保留最近 50 张；同时加强网页边界转义，避免网页伪造工具输出边界。

## 已实现

- 与 Cyrene 宿主一致的无边框珍珠色标题栏、圆角窗口和圆形窗口按钮
- 地址栏、前进、后退、刷新和多标签页
- 独立持久会话（Cookie、站点存储和缓存会在重启后保留）
- Agent 导航、增强页面快照、点击、填写、按键、滚动和标签页/历史控制
- 可靠等待：支持加载完成、URL、文字、CSS 选择器出现或隐藏，最长 30 秒且支持任务取消
- 页面快照提供 `pageRevision`、元素视口坐标、下拉选项、DOM 版本，并遍历同源 iframe 与开放 Shadow DOM；可选发现视口外元素
- 高级交互：双击、悬停、下拉选择、勾选/取消、滚入视口、拖拽和基于当前快照的坐标点击
- 点击、填写、按键、滚动与高级交互后自动报告可观测的 URL、标题、DOM 和滚动变化
- 当前视口截图并保存到插件私有数据目录，自动只保留最近 50 张
- `Ctrl+L`、`Ctrl+T`、`Ctrl+W`、`Ctrl+R`、`Alt+Left`、`Alt+Right` 快捷键
- 远程页面禁用 Node.js，启用 context isolation、Chromium sandbox 和 web security
- 摄像头、麦克风、地理位置、通知等站点权限默认拒绝

## 安装

把插件目录中的 `manifest.json`、`index.cjs`、`browser-page.cjs`、`browser-input.cjs`、`preload.cjs`、`ui.html` 和 `icon.svg` 压入 ZIP 根目录，然后在 Cyrene 的插件面板中导入、启用并点击“打开”。

在 Chat 模式使用 Agent 工具时，还需要在工具面板开启“Chat 工具增强”，并明确勾选 `cyrene-browser_*` 工具。Work、Code、Learn 模式按正常工具设置使用。

## 使用约定

Agent 在点击、填写或高级交互前应先调用 `cyrene-browser_snapshot`，使用当前快照返回的 `[e1]`、`[e2]` 等元素引用，并把同一快照的 `pageRevision` 随操作传回。操作或页面变化后应重新获取快照；旧引用和旧页面版本会失效。

动态页面应调用 `cyrene-browser_wait` 等待明确条件，不依赖固定延时。Canvas 等缺少可访问 DOM 的界面可以先截图，再使用 `cyrene-browser_interact` 的 `clickAt`；坐标点击强制校验当前 `pageRevision`。

默认的 `scope=viewport` 只返回当前视口内的交互元素和文字。需要操作页面下方尚未出现的控件时，可调用 `cyrene-browser_snapshot` 并传入 `scope=document`；结果会把这些引用标为“视口外”，随后可用 `cyrene-browser_interact` 的 `scrollIntoView` 将其滚入视口。为控制传给模型的数据量，正文文字仍只读取当前可见范围。

密码框不会暴露值，也拒绝由 Agent 自动填写。验证码、登录、付款、文件选择和其他敏感步骤应由用户在可见窗口中手动完成。

截图工具只返回本地文件路径；若需要视觉理解，让 Agent 再调用 Cyrene 的 `read_image`。

## 网络、数据与存储

- 浏览器会访问用户在可见地址栏或 Agent 工具中指定的任意 HTTP(S) 地址；无法识别为网址的文本会作为查询发送给 Bing 搜索。
- 只有调用页面快照工具时，当前可见网页文字、控件名称和非密码字段值才会进入工具结果，并发送给当前配置的模型。密码值不会读取，密码框也拒绝 Agent 自动填写。`scope=document` 还会发送视口外交互元素的名称和位置，但不会扩展正文文字范围。
- Cookie、站点存储和缓存保存在 Electron 持久分区 `persist:cyrene-browser-v1` 中，会随 Cyrene 用户数据保留。插件不内置遥测，也不会把浏览数据发送到自己的服务器。
- 截图保存在插件数据目录的 `screenshots` 子目录，只保留最近 50 张。网页发起下载时使用 Electron/系统保存窗口，只有用户确认后才写入用户选择的位置。
- 摄像头、麦克风、位置、通知等网页权限默认全部拒绝。

## 需要宿主作者配合的后续接口

以下两项无法仅靠当前插件 API 安全实现，建议 Cyrene 作者在后续宿主版本中提供稳定接口；插件在接口出现前继续使用“截图路径 + 独立窗口”的兼容方案。

1. **原生多模态工具结果**：当前 `PluginTool.execute` 只能返回字符串。希望支持包含文本与本地图片的结构化结果，使网页截图能直接作为 image content 进入模型，同时由宿主统一做路径授权、大小限制和生命周期管理。
2. **可停靠浏览器面板**：希望提供由宿主管理的 panel/view 插槽，让插件把 `WebContentsView` 停靠在聊天窗口侧边或底部，并获得布局、聚焦、关闭和主题事件；不建议插件依赖宿主私有 DOM 或窗口层级。

## 当前限制

- 同源 iframe 和开放 Shadow DOM 可读取、定位及交互；跨域 iframe、关闭的 Shadow DOM 和 Canvas 不能直接解析，只能结合可见窗口、截图和坐标操作。
- 截图不能作为插件工具的原生多模态结果直接进入主模型。
- 浏览器是插件独立窗口，尚不能停靠到 Cyrene 主聊天窗口内。
- 浏览器扩展、密码管理器、WebAuthn、DRM 和部分反自动化网站可能不可用。
