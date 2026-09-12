<p align="center">
  <img src="./cyrene-image.png" width="160" alt="Cyrene-Plugins" />
</p>

# Cyrene-Plugins

Cyrene 昔涟官方插件收录仓库：开发者通过 Pull Request 提交插件，审核通过后收录进本仓库，供用户下载安装。

- 主程序：[Cyrene-Agent](https://github.com/Playa-0v0/Cyrene-Agent)
- SDK：[@playa0v0/cyrene-plugin-sdk](https://www.npmjs.com/package/@playa0v0/cyrene-plugin-sdk)
- 开发指南：[docs/plugins/plugin-dev-guide.md](https://github.com/Playa-0v0/Cyrene-Agent/blob/master/docs/plugins/plugin-dev-guide.md)

---

## 已收录插件

| 插件 | 版本 | 简介 | 直接下载 | 开发者 | 原仓库 |
| --- | --- | --- | --- | --- | --- |
| [weather-tool](./plugins/weather-tool) | 0.1.0 | 查询城市天气：优先使用用户配置的 OpenWeather 密钥，未配置时自动降级到免密钥的 Open-Meteo | —（示例，不分发） | Cyrene 示例 | — |
| [long-term-memory](./plugins/long-term-memory) | 0.1.0 | 监听轮次结束事件，自动摘要对话并存档，把长期记忆注入下一轮上下文 | —（示例，不分发） | Cyrene 示例 | — |
| [scheduled-automation](./plugins/scheduled-automation) | 0.1.0 | 通过对话创建、管理自己的定时任务（创建后需在宿主界面确认启用） | —（示例，不分发） | Cyrene 示例 | — |
| [local-asr-contract](./plugins/local-asr-contract) | 0.1.0 | 本地语音识别契约示例：演示语音输入租约的获取、提交与释放 | —（示例，不分发） | Cyrene 示例 | — |
| [system-status](./plugins/system-status) | 0.1.0 | 查询本机系统状态：CPU、内存、磁盘、电池与开机时长，附带可视化状态面板 | [ZIP](https://github.com/Playa-0v0/Cyrene-Plugins/releases/download/system-status-0.1.0/system-status-0.1.0.zip) | Playa | — |
| [subscription-oauth](./plugins/subscription-oauth) | 1.2.7 | 用订阅账号登录 ChatGPT / Claude / Grok，经本地代理按各家原生协议直通；支持工具调用、多账号切换、模型目录与用量显示 | [ZIP](https://github.com/Playa-0v0/Cyrene-Plugins/releases/download/subscription-oauth-1.2.7/subscription-oauth-1.2.7.zip) | 1971687396 | — |
| [indextts-tts](./plugins/indextts-tts) | 1.0.0 | 在本机启动 IndexTTS 2.x 语音合成服务，供 Cyrene 的 GPT-SoVITS 通道直接调用 | [ZIP](https://github.com/Playa-0v0/Cyrene-Plugins/releases/download/indextts-tts-1.0.0/indextts-tts-1.0.0.zip) | Downfallofthedownfall | — |
| [ripples-of-aion](./plugins/ripples-of-aion) | 0.6.0 | 结构化记忆层：自动沉淀对话事实，混合检索 + LLM 精排、实体属性时间轴、autoDream 整合与五页可视化面板 | [ZIP](https://github.com/Playa-0v0/Cyrene-Plugins/releases/download/ripples-of-aion-0.6.0/ripples-of-aion-0.6.0.zip) | modusensus | [Ripples-of-Aion](https://github.com/modusensus/Ripples-of-Aion) |
| [chat-export](./plugins/chat-export) | 1.0.0 | 把本地聊天存档导出为人可读的 HTML / Markdown：聊天气泡界面、双方头像、思考过程与工具调用折叠展示 | [ZIP](https://github.com/Playa-0v0/Cyrene-Plugins/releases/download/chat-export-1.0.0/chat-export-1.0.0.zip) | Playa | — |
| [local-asr](./plugins/local-asr) | 0.4.9 | 本地语音识别：麦克风语音转文字自动进输入框，通话开始自动接管（纯 SDK 接口实现）；零环境小白可用（无引擎时面板一键下载轻量 CPU 引擎，SHA-256 校验，断点续传） | — | boring9720 | [boring9720/cyrene-local-asr](https://github.com/boring9720/cyrene-local-asr) |

---

## 用户：如何安装插件

1. 在上方表格点击插件对应的 **ZIP** 链接直接下载（安装包以 GitHub Release 附件形式分发）
2. 在 Cyrene 中打开 **设置 → 插件 → 导入 ZIP**，选择下载的压缩包
3. 安装完成后在插件列表中**手动启用**

说明：

- 安装包由维护者从审核过的 `plugins/` 源码统一打包，以 GitHub Release 附件形式分发，与源码目录一一对应
- 想查看插件源码：进入对应 `plugins/<插件id>/` 目录
- 官方示例插件仅作开发参考，不通过市场分发，无下载链接
- 用户插件首次安装后默认停用，启用后才会生效
- 插件更新：重新导入新版 ZIP 即可，插件数据（存储、密钥）不会丢失

---

## 开发者：如何提交插件

简述流程（详见 [CONTRIBUTING.md](./CONTRIBUTING.md)）：

1. 用 `npm install @playa0v0/cyrene-plugin-sdk` 开发与测试插件
2. 把**可直接安装的产物**（`manifest.json` + 编译后的入口文件）放进 `plugins/<你的插件id>/` 目录
3. 在 `registry.json` 中登记插件信息，并在 README「已收录插件」表格末尾添加一行（详见 [CONTRIBUTING.md](./CONTRIBUTING.md)）
4. 提交 Pull Request，等待安全审核（审核标准见 [review-checklist.md](./review-checklist.md)）

注意：**提交者不需要也不应该上传 ZIP**。ZIP 由维护者在你合并后统一打包，保证用户下载的内容与审核过的源码一致。

---

## 安全说明

- 本仓库所有插件经过人工安全审核后才收录，但**审核不构成担保**，请只安装你信任的插件
- 插件与 Cyrene 运行在同一进程，拥有完整 Node.js 权限（可读写文件、联网、启动子进程）
- 所有用户插件首次安装后默认停用；定时任务、密钥写入等敏感操作需你在宿主界面二次确认

---

## 目录结构

```text
Cyrene-Plugins/
├── plugins/              # 已收录插件源码（每个子目录一个插件，可在线阅读）
│   └── <插件id>/
│       ├── manifest.json # 插件清单
│       ├── index.cjs     # 编译后的入口
│       └── README.md     # 插件说明
├── scripts/
│   ├── publish-plugins.ps1     # 发布脚本（维护者工具：合并 PR 后打包并发布 GitHub Release）
│   └── aggregate-downloads.mjs # 下载量聚合脚本（GitHub Action 每日自动运行）
├── registry.json         # 收录索引（插件元数据登记处）
├── CONTRIBUTING.md       # 提交规范（面向插件开发者）
└── review-checklist.md   # 审核清单（面向维护者，也可供提交者自查）
```
