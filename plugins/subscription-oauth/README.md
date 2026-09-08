# 订阅 OAuth（ChatGPT / Claude / Grok）

用已订阅的账号登录 OpenAI / Anthropic / xAI，在 Cyrene 里通过**本地代理**直接使用这些订阅模型——不需要再填 API Key。

> 更新说明：`1.2.x` 起档案写入改走宿主的模型配置 API（立即生效）；`1.1.x` 起代理按各订阅**原生协议**直通（修复 ChatGPT 400 问题）；`1.0.x` 为初版。

---

## 功能

| 订阅 | 登录方式 | 模型前缀 | 上游端点 |
|---|---|---|---|
| ChatGPT Plus / Pro | Codex CLI OAuth | `gpt-*` / `o1-*` / `o3-*` / `o4-*` | `chatgpt.com/backend-api/codex/responses` |
| Claude Pro / Max | Claude Code OAuth | `claude-*` | `api.anthropic.com/v1/messages` |
| SuperGrok / X Premium+ | Grok Build CLI OAuth | `grok-*` | `api.x.ai/v1/chat/completions` |

- **本地代理**：在 `127.0.0.1:6231` 起一个 HTTP 服务，按各订阅原生协议转发请求并注入 OAuth 凭据
- **多账号**：每个订阅可登录多个账号，随时切换；同账号重复登录会更新凭据而非新增
- **模型目录**：从订阅接口拉取可用模型（含隐藏模型），显示每个模型的**思考档位**与**上下文长度**
- **一键写入档案**：把模型目录写成 Cyrene 模型档案，聊天窗口的模型选择器立即可选
- **用量查询**：显示 5 小时窗口 / 每周窗口的已用百分比与重置时间

---

## 安装与启用

1. Cyrene → **插件** → 右上角 **添加** → 选择本插件 ZIP
2. 在插件卡片上点 **启用**（用户插件默认停用）
3. 点卡片上的 **打开** 弹出插件窗口

## 使用步骤

1. 插件弹窗里对需要的订阅点 **登录**（浏览器打开官方 OAuth 授权页，本地回调端口接收 code）
2. 点 **查看用量/模型** → **一键写入全部模型档案**
3. 回聊天窗口 → 模型选择器 → 选「ChatGPT（OpenAI）订阅 · gpt-5.6-sol」等档案即可对话
4. 思考强度下拉会显示该订阅模型的真实档位（如 GPT-5.6 系列：低 / 中 / 高 / 极高 / 最强 / 极限）

> 档案的 baseUrl 指向本插件代理，API Key 为占位符（代理不校验）。
> 目录里没有的模型可在弹窗底部手动输入模型 ID 添加。

---

## 网络访问（如实披露）

本插件会向以下域名发起 HTTPS 请求，**只传输完成登录/拉取/转发所必需的内容**：

| 域名 | 用途 | 传输内容 |
|---|---|---|
| `auth.openai.com` / `chatgpt.com` | ChatGPT 登录、模型目录、用量、对话转发 | OAuth 授权码/凭据、提示词与模型响应 |
| `claude.ai` / `console.anthropic.com` / `api.anthropic.com` | Claude 登录、模型目录、用量、对话转发 | 同上 |
| `auth.x.ai` / `api.x.ai` / `cli-chat-proxy.grok.com` | Grok 登录、模型目录、用量、对话转发 | 同上 |

- 代理只监听 `127.0.0.1`，不对外网暴露；仅本机的 Cyrene 会连接
- 不向任何第三方服务器发送数据；没有遥测、没有回传

## 本地数据与文件读写

- **凭据**：OAuth token 只经宿主的 `secrets` 服务（Electron safeStorage 加密）存取，**不落明文文件、不写日志**；`secrets` 不可用时拒绝保存并报错
- **配置文件**：点击「一键写入模型档案」时，通过宿主公开的模型配置 API（`window.settings.saveModelProfile`）写入 `userData/model-settings.json`；若当时没有可用的宿主窗口，则直接写该文件并提示重启 Cyrene
- **端口**：占用本机 `127.0.0.1:6231`（被占用时会报错，不会静默失败）

## 代理端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 存活检查 |
| `GET` | `/v1/models` | 已登录订阅的模型目录（合并） |
| `POST` | `/v1/chat/completions` | Grok（OpenAI 兼容） |
| `POST` | `/v1/responses` | ChatGPT（Responses 协议） |
| `POST` | `/v1/messages` | Claude（Messages 协议） |

端点与模型族做了串线校验：用 `grok-*` 打 `/v1/responses` 会直接返回 400，不会误发给错误上游。

---

## 已知限制

- **非官方客户端复用**：本插件复用各家 CLI 客户端的公开 OAuth 流程（Codex CLI / Claude Code / Grok Build CLI）。官方可能变更接口或收紧策略，届时需要更新插件；请遵守各服务条款，仅用于你本人合法订阅的账号
- **端口固定**：默认 `6231`，被占用时需先释放该端口
- **跨协议切换建议新建对话**：同一会话在 Chat Completions ↔ Responses 之间切换时，历史里的工具调用回放可能不兼容（宿主行为），换协议后建议新建对话
- **模型可用性由服务端决定**：目录里未列出的模型（如 `gpt-6-astra`）手动添加后仍可能被后端拒绝（返回 `not supported`）
- **用量窗口可能为空**：部分账号/周期后端不返回窗口数据，此时只显示计划名

## 卸载

在插件面板停用/卸载即可。凭据随插件数据保留（卸载只删程序目录）；如需清除，可在弹窗中删除账号。
