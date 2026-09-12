<h1 align="center">星驿 · Astral Relay</h1>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.5.0-ff69b4?style=flat-square" alt="version">
  <img src="https://img.shields.io/badge/TypeScript-strict-ff69b4?style=flat-square" alt="typescript">
  <img src="https://img.shields.io/badge/node-24%20LTS-ff69b4?style=flat-square" alt="node">
  <img src="https://img.shields.io/badge/platform-Cyrene%20Plugin%20API%20v1-ff69b4?style=flat-square" alt="platform">
  <img src="https://img.shields.io/badge/runtime%20deps-0-ff69b4?style=flat-square" alt="zero deps">
</p>

BYOS（Bring Your Own Subscription）中转站：用**你自己的订阅额度**驱动 Cyrene，
不用再单独买按量付费额度。

Grok 与 MiniMax 支持 Chat、Work、Learn、Code 全模式。
仅 Qwen / 腾讯 Coding Plan 限制为 Code 交互会话。技术兼容不等于厂商公开 API 保证。

## 支持的厂商

| 厂商 | 放行范围 | 连接方式 | 参考文档 |
|---|---|---|---|
| xAI Grok 订阅 | 全模式 · **实验性** | 浏览器 OAuth（回环回调 / 设备码）；OpenAI 兼容协议 | [文档](https://x.ai/news/grok-opencode) |
| MiniMax Token Plan | 全模式 | `sk-cp-` | [文档](https://platform.minimax.io/docs/token-plan/intro) |
| 通义千问 Coding Plan | 仅 Code 模式 | `sk-sp-` | [文档](https://help.aliyun.com/zh/model-studio/coding-plan) |
| 腾讯云 Coding Plan | 仅 Code 模式 | `sk-sp-` | [文档](https://cloud.tencent.com/document/product/1823/130092) |
| GitHub Copilot | 未实现 | — | [文档](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate) |

MiniMax 支持国际站与中国大陆双端点，在面板里切换。

**明确不收录**，且不接受 PR 添加：

- **Z.ai GLM Coding Plan** —— 条款点名禁止用于「自有应用、机器人、网站、SaaS」，支持工具是封闭列表
- **Anthropic Claude 订阅** —— 第三方产品不得提供 claude.ai 登录或额度
- **ChatGPT / Codex 订阅** —— `chatgpt.com/backend-api/codex` 是私有后端，没有面向第三方的公开契约（[openai/codex#36886](https://github.com/openai/codex/issues/36886) 至今无官方答复）。**要用 Codex 并不需要本插件**：把本机已登录的 codex CLI 作为 MCP server 接进 Cyrene（`codex mcp-server`）即可，额度同样走你自己的 ChatGPT 订阅
- **Google Gemini** —— 官方文档点名禁止第三方软件复用 Gemini CLI 的 OAuth

### 关于 GitHub Copilot

Copilot 是本目录里唯一「条款允许、但技术上还没做」的一个。GitHub 明确支持
第三方应用用 OAuth 代表用户发请求、并计入该用户自己的订阅额度，这点没有问题。

卡住的是打包：`@github/copilot-sdk` 依赖 koffi 原生模块，并自带一份 Copilot CLI
二进制，与 Cyrene 插件「目录自包含 + 零运行时依赖 + ZIP ≤ 50MiB」的收录要求冲突。

可行路线已经想清楚了：驱动**你自己安装并登录**的 `copilot` CLI
（`copilot --headless --port N`，走 JSON-RPC），既不打包二进制，也不需要
OAuth App 的 client id 与 secret。但本机没装 CLI，协议没法实测——
不带未验证的实现上线，所以面板里先置灰。

### Grok 接入（实验性）

采用 PKCE 浏览器授权、仅本机回调与安全存储，另提供设备码登录（RFC 8628）。
支持取消登录、断开连接、到期自动刷新与读取模型目录。
所有出站 HTTP 统一使用 **Electron `net.fetch()`**，不回退到 Node 全局 fetch。

client id 与 scope 用的是 **xAI 的共享 OAuth 客户端**：xAI 明确支持第三方工具复用用户自己的
SuperGrok / X Premium 订阅额度，且不提供第三方自建 client 的注册入口，共享客户端即官方路径。
因此授权页可能显示 Grok Build，这是[有文档记载的已知行为](https://docs.openclaw.ai/providers/xai)。
端点取自 xAI 自己发布的 [OIDC discovery](https://auth.x.ai/.well-known/openid-configuration)。

**标为实验性的原因**：开发机没有 SuperGrok / X Premium 账号，无法完成一次真实授权。
代码有单元测试覆盖（含设备码轮询、pending/slow_down 处理、取消与错误码不回显），
但**没有端到端实测**。请求头如实标明 `astral-relay/0.5.0`，不伪装官方 CLI。

## 它怎么工作

通用 BYOS 面板由插件页的 **Open / 打开** 按钮进入，每家厂商独立连接 OAuth 或配置订阅 Key。

**装一个 ZIP 就能用，不需要改宿主的任何一行代码。** 编程套餐的「仅 Code 模式」是这样成立的：

1. 宿主按 `modes` / `sources` 过滤 prompt provider。本插件声明
   `modes:["code"] + sources:["conversation"]`，所以只有 Code 模式的交互式会话会调到它，
   定时任务与发帖决策根本进不来。入参里带着本轮的 mode、source 和用户输入。
2. provider 被调用时再自己核对一次 mode / source，然后登记这段用户输入的指纹
   （SHA-256，折叠空白；不保存原文）。
3. 代理收到编程套餐请求时，从请求体里取最后一条 user 消息，算同样的指纹。
   登记过才放行，否则 403，不访问上游。
4. 通用套餐不受此限制，任意模式放行——条款没有这条限制，硬加只是功能阉割。

provider 在宿主构建请求之前就被 await，用户输入又原样出现在出站请求体里，
所以「登记」必然早于「验证」，顺序上不存在竞态。工具续轮与流式重试沿用同一条 user 消息，
因此不会被打断；登记按 TTL 与条目上限收口，另一轮结束不会撤销本轮。

这拦住的是真实存在的误用：定时任务、朋友圈发帖、模型档案的「连接测试」，
以及在 Chat / Work / Learn 里随手拿编程套餐档案发消息。**拦不住的也写清楚**：
同一段文本在 Code 模式发过之后，TTL 内在其它模式重发一次也会通过；
本机上拿到代理 token 的程序可以重放同样的文本。后者在插件的信任模型下本来就不成立。

如果宿主愿意逐请求签名本轮模式（HMAC 的 `ar1` 凭据），代理会优先采信签名，
此时上面那个「重发同一段文本」的缺口也不存在。这是**可选**的，见
[宿主集成](docs/host-integration.md)；上游 Cyrene 没有这项改动，本插件也不要求它有。

凭据只用于本地代理鉴权，转发上游时替换为订阅 Key 或 OAuth access token。
一个端口服务全部厂商，厂商 id 写在路径里。不靠模型名猜厂商——多家有同名模型时必然出错。

## 安装

```bash
npm install
npm run deploy   # 构建并拷贝到 %APPDATA%/live2d-cyrene/plugins/
```

不需要任何宿主改动：全部厂商（含 Qwen / 腾讯 Coding Plan）在标准 Cyrene 上装上就能用，
只要宿主实现了插件 API v1 的 prompt provider。开发环境已确认 Node 24.19.0。

然后在 Cyrene 插件面板点「刷新插件」，手动启用，再点「Open / 打开」配置。

## 配置

1. Grok 点击「连接订阅」并在浏览器授权；其它厂商填写订阅 Key。凭据仅写入宿主安全存储。
2. OAuth 连接后点击「读取模型」，复制需要的模型 ID。
3. 把卡片的 **Base URL**、模型 ID 和底部 **token** 填进 Cyrene 模型档案。所有已实现厂商均选择 **OpenAI 兼容**。
4. Grok / MiniMax 可在任意模式发消息测试；Qwen / 腾讯 Coding Plan 需在 Code 模式测试。
5. Base URL 端口和 token 每次启用都重新生成，重启或重新启用后都需要重新复制。

## 已知限制

- GitHub Copilot 尚未实现，面板置灰。
- 模型档案的「连接测试」不是 Code 轮次，编程套餐一定会拒绝；请在 Code 模式直接发消息测试。
- Code 轮次登记默认保留 2 小时、最多 64 条，超出后淘汰最旧的；停用插件即全部清空。
- 内容绑定证明的是「这段输入确实来自一次 Code 交互」，不是「这个请求由那一轮发出」：
  同一段文本在 TTL 内于其它模式重发会通过，也不隔离持有本地 token 的本机程序。
- 可选的 `ar1` 签名凭据最长有效 24 小时，且首次使用后 2 小时内有效；插件重启会使旧凭据失效。
- Grok 标为实验性：单元测试覆盖完整，但没有真实订阅账号做过端到端授权与推理验证。
- 移除 Codex 后，`server.ts` 里 protocol 不匹配的 400 分支暂无厂商覆盖（Grok 是唯一 OAuth 厂商且走 OpenAI 兼容），分支保留给将来的 responses 厂商。

## 免责

条款随时会变，最终解释权在各厂商。**使用前请自己点开上表的条款链接复核**，
本插件不对你的账号状态负责。
