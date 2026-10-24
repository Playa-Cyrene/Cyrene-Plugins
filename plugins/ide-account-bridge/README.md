# IDE 账号桥接（Qoder / Trae）

把本机**已经登录**的 Qoder 与 Trae 桌面账号接进 Cyrene，不用走 OAuth，也不用去网页上申请
API Key —— 装好插件，把面板给出的 Base URL 和 token 填进模型档案就能用。

支持四个区域。**未登录的区域会在面板上显示为「未登录」，且不启动服务、不占用端口**：

| 区域 | provider | 上游 |
| --- | --- | --- |
| Qoder CN | `qoder-cn` | `gateway.qoder.com.cn` |
| Qoder 国际 | `qoder` | `api3.qoder.sh` |
| Trae CN | `trae` | `trae-api-cn.mchost.guru` |
| Trae 国际 | `trae-global` | `coresg-normal.trae.ai` |

## 它怎么工作

每个区域跑一个绑定在 `127.0.0.1` 固定端口的本地服务（端口首次分配后跨重启复用，见下）：
**对外说 OpenAI 协议，对内翻译成该区域自己的私有协议**（Qoder 的 COSY 签名 + 自定义
body 编码；Trae 的 SOLO 协议）。
Cyrene 只需要把它当成一个普通的「OpenAI 兼容」模型档案。

```
Cyrene 模型档案（OpenAI 兼容）
  -> 127.0.0.1:<端口>/v1            （本插件的回环服务）
  -> COSY 签名 / SOLO 协议
  -> 对应区域的上游网关
```

**真实凭据不出本进程。** Cyrene 拿到的只是这个回环服务的 bearer token（首次生成后
持久保存在插件存储目录里），离开 127.0.0.1 就毫无用处；上游令牌只在插件进程内部使用。

## 安装与启用

1. 在 Cyrene 中 **设置 → 插件 → 导入 ZIP**，选择 `ide-account-bridge-<版本>.zip`
2. 在插件列表里**手动启用**（用户插件默认停用）
3. 点插件页的 **Open / 打开**，打开配置面板

面板会列出每个已登录区域的 **Base URL** 与 **token**，点「复制」即可。

## 配置

在 Cyrene 里 **设置 → 模型 → 新增模型档案**：

| 字段 | 填什么 |
| --- | --- |
| 协议 | **OpenAI 兼容** |
| Base URL | 面板中对应区域的 Base URL |
| API Key / token | 面板中对应区域的 token |
| 模型 ID | 面板中该区域列出的模型 ID（如 `DeepSeek-Flash`） |

四个区域是四个独立的模型档案，各用各的账号与额度。

> **端口与 token 是持久的：配置一次即可，重启 Cyrene 后仍然有效。**
>
> 首次启用时各区域会分配一个固定端口（从 `43110` 起顺次挑选）并生成一个 bearer token，
> 两者都记在插件的存储目录里（`endpoints.json`）。之后每次启动都复用同一组值，
> 所以模型档案不需要因为重启而修改。
>
> 仅在两种情况下会变，届时回到面板重新复制一次即可：
> - **端口被占用**（比如恰好被别的程序先占了），该区域会回退到系统随机端口并记录新值
> - **删除或损坏了 `endpoints.json`**，插件会重新分配

### 面板上的三个按钮

| 按钮 | 作用 |
| --- | --- |
| 刷新状态 | 重新读取各区域端点，并**强制**刷新模型列表（跳过 30 分钟保鲜期） |
| 查询额度 | 读取各区域额度、促销活动与今日签到状态（只读） |
| 领取今日签到 | 向账号领取今日签到额度 —— **本插件唯一会改动账号状态的操作**，点击后会二次确认 |

### 模型目录的自动刷新

模型目录**会自动保持最新**，不需要你手动干预：

- 每次对话请求、每次读模型列表之前，插件都会检查目录是否已过期
- 目录的保鲜期是 **30 分钟**：保鲜期内直接使用缓存，**不会**发起额外请求
- 过期时才重新拉取一次，把上游新增/下线的模型同步进来
- 拉取失败时保留上一份可用目录，不影响正在进行的请求

这份逻辑与 Pi 版一致（Pi 在每次解析 API key 时做同样的检查）。所以你在 Qoder /
Trae 里换了账号、或者上游新增了模型，最长 30 分钟后 Cyrene 这边就能看到——点一下
「刷新状态」会跳过保鲜期、强制重新拉取，立即生效。

刷新只发生在 `/v1/models` 与 `/v1/chat/completions` 上；`/healthz` 保持纯本地检查，
不会因为上游变慢而让健康探针超时。

### 对话工具

插件同时向 Agent 暴露三个工具：

| 工具 | 风险 | 说明 |
| --- | --- | --- |
| `ide-account-bridge_usage` | 只读 | 查询各区域额度与签到状态 |
| `ide-account-bridge_models` | 只读 | 列出各区域可用的模型 ID |
| `ide-account-bridge_checkin` | 改动账号状态 | 领取今日签到。**必须显式传 `confirm=true`**，否则只回报将要执行的动作 |

## 网络访问

插件只访问上述四个区域的上游网关与它们各自的鉴权/额度端点：

- Qoder：`gateway.qoder.com.cn`、`api3.qoder.sh`、`openapi.qoder.com.cn`、`openapi.qoder.sh`
- Trae：`trae-api-cn.mchost.guru`、`coresg-normal.trae.ai`、`growsg-normal.trae.ai`、`solo.trae.cn`、`api.trae.cn`

发送内容就是**你自己在 Cyrene 里发出的对话请求**（模型 ID、消息、工具声明），
以及用于鉴权的账号令牌。没有遥测，没有第三方上报，插件自身不连接任何其他服务器。

## 文件读写

**读取**（仅本机，只读，不修改）：

- `%APPDATA%\<Qoder 应用名>\User\globalStorage\state.vscdb`
  —— 应用名取自 `QoderCN` / `Qoder CN` / `QoderWork CN` / `Qoder` / `QoderWork`
- `%APPDATA%\<Trae 应用名>\User\globalStorage\storage.json`
  —— 应用名取自 `Trae CN` / `trae-cn` / `Trae` / `TRAE SOLO CN` / `TRAE SOLO`

这两个文件是桌面应用自己保存登录态的数据库，插件只读它们来复用你已有的登录。

**写入**（只写插件自己的存储目录，由宿主分配）：

- Qoder 模型目录缓存 —— 只含模型元数据，**不含任何令牌**
- `endpoints.json` —— 各区域回环服务的端口与 bearer token，用来让模型档案跨重启保持有效。**token 为明文**；服务只监听 `127.0.0.1`，该 token 离开本机没有意义，它的作用是挡住同机其他程序。写入时同样传入 `mode: 0o600`，Windows 会忽略该参数（见下）。
- Trae 刷新后的凭据副本（`.trae-auth.<区域>.json`）—— **这是一个明文 JSON 文件，内含 `accessToken` 与 `refreshToken`**。Trae 的 access token 有有效期，刷新后写一份副本，这样两个区域同时登录时不会互相覆盖。写入时传入 `mode: 0o600`，但请注意：**POSIX 平台才会以 0600 创建；Windows 会忽略该参数**，实际权限继承自 `ctx.storage.rootDir()` 所在目录的 ACL。请知悉它等同于一枚可用的账号令牌，落在插件的存储目录之下。该设计继承自上游 DSH 插件，本插件未做改动。

插件**不会**写入 Qoder / Trae 应用自己的任何文件。

## 子进程

读取 Qoder 凭据的过程会启动**两个**子进程，都在读取登录态时发生，都不接受任何用户输入。

**其一：`powershell.exe`（解 OSCrypt 密钥）**

Windows 上解开 Chromium 的 OSCrypt 密钥只能通过**系统 DPAPI**。插件用 `execFileSync` 启动一次
`powershell.exe`，传入一段固定的、不含任何用户输入的内联脚本，由它调用
`ProtectedData.Unprotect` 解出密钥，结果经临时文件回传。

- 脚本内容是常量，不拼接任何外部数据，不存在命令注入面
- 仅在 Windows 上执行；其他平台走不同的分支
- 调用是同步的，每次运行只解一次（结果有缓存）

**其二：厂商自带的 `runtime-info.exe`（取机器标识）**

Qoder 的部分接口需要一个机器标识，由 Qoder 自己安装目录下的
`<install>\resources\umid\runtime-info.exe` 生成。插件以 `execFileSync` 执行它：

- **无参数**调用（`execFileSync(binary, [], …)`），5 秒超时，`stdio` 只保留 stdout 管道
- 不走 shell（没有 `shell: true`），参数不来自用户输入，无注入面
- 执行的是**厂商安装目录下的可执行文件**，不是插件自带的二进制
- 二进制不存在或超时都会降级为「无机器标识」，不阻塞其余功能

两处调用的实际动作与工具的 `risk: "shell"` 声明一致。

## 已知限制与风险

- **必须先在桌面应用里登录。** 插件读的是桌面应用的登录态；没登录的区域不会出现在面板里，
  也不会占用端口。没有桌面登录时可退回环境变量 `QODERCN_PAT` / `QODER_PAT` 等（Qoder）。
- **上游协议是私有的。** 这套协议由上游插件的作者实测还原，随时可能因为厂商改版而失效。
  它不是厂商公开承诺的 API，出问题时只能等适配更新。
- **请自行确认各厂商的使用条款。** 本插件复用你自己的账号额度，但「第三方客户端接入」
  是否被条款允许，由厂商解释，本插件不对此负责。
- **模型 ID 取自上游的展示名。** 上游给模型改名时，模型档案里的 ID 需要跟着改。
  新模型是新增而非改名，所以既有配置通常不受影响。
- **签到会改动账号状态。** 这是插件里唯一有副作用的操作，工具与面板都做了确认环节，
  且会先读状态、已领取过的不重复请求。
- **Trae 国际版未做端到端实测**：开发机上没有该区域的登录，代码路径与国内版共用，
  但国际版走的是订阅计费分支，未经真实账号验证。

## 源码

协议层复用自 DeepSeek Harness 插件 `@eghrhegpe/dsh-connect-qoder` 与 `dsh-connect-trae`
（均为 MIT），经由它们在 Pi coding agent 上的移植版。

本插件的完整源码（入口、面板、用量与签到、构建脚本）与 Pi 版共用同一个仓库：

**https://github.com/citie114514/pi-connect/tree/main/cyrene/ide-account-bridge**

相对协议层只改了三处：凭据与缓存根路径改为由宿主注入、移除 Pi 专属的 provider 注册、
用量与签到改为返回结构化数据。逐项归属与改动说明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 目录内文件说明

| 文件 | 用途 |
| --- | --- |
| `manifest.json` | 插件清单 |
| `index.cjs` | 入口（esbuild 打包的 CommonJS，自包含） |
| `panel/index.html`、`panel/panel.js` | 配置面板：由 `open()` 以 `BrowserWindow` 加载，展示各区域端点与模型、提供刷新/额度/签到按钮 |
| `THIRD_PARTY_NOTICES.md` | 上游 MIT 归属与改动说明 |

## 许可

MIT。
