## 版本说明（PR #2 内容更新）

本 PR 自 0.3.2 以来经历了两轮演进，当前提交版本为 **0.4.9**：

- **0.3.2 → 0.4.5**（响应审核反馈）：SHA-256 哈希锁定全部下载文件、空默认配置、250MB 下载改为面板显式确认后才开始
- **0.4.5 → 0.4.9**（本轮新增）：
  - **通话自动接管**：发起语音通话后自动检测并接管输入，无需手动点「接管通话」
  - **移除唯一的宿主内部依赖**：自动接管改用官方 SDK 契约探测（`speechInput.acquire({target:"active-call"})`，`E_NO_ACTIVE_INPUT_TARGET` 错误码即"无通话"），不再 `require` 宿主 `call-manager` 内部模块——插件对宿主的依赖面收敛到**纯 SDK 契约**
  - **隐藏采集窗口**：自动接管时若面板未开，创建隐藏 BrowserWindow 启动麦克风采集（getUserMedia+AudioWorklet 必须在渲染进程运行），通话结束自动回收

## 插件功能与使用方式

local-asr 接管 Cyrene 的语音通话/聊天语音输入：插件自有窗口（ui.html，getUserMedia + AudioWorklet 麦克风采集）采集 16kHz PCM，主进程做能量 VAD 分句，识别后经 speech-input 租约 commit 注入当前通话/聊天输入框。

小白零环境可用：启用插件自动体检，无本机 ASR 服务且无内置引擎时，在面板确认后自动从国内源下载轻量引擎（sherpa-onnx NAPI + paraformer int8 模型，约 250MB，支持 HTTP Range 断点续传与取消），CPU 实时率约 4%，无需 Python/显卡/命令行。有本机 FunASR 服务（127.0.0.1:8328）时自动优先走 GPU。

## 申明的宿主能力（deps）及用途

- `speech-input`：获取语音输入租约（acquire / commit / release），将识别文本提交进当前通话/聊天输入框；自动接管亦通过该契约的 acquire 错误码探测通话状态。仅此一项，无其他 deps。

## 网络访问（逐域名）

| 域名 | 用途 | 传输内容 |
|---|---|---|
| registry.npmmirror.com | 下载推理二进制 tgz（8.7MB） | 仅文件下载 |
| modelscope.cn（3 个模型仓库镜像） | 下载模型 243MB + 词表 75KB | 仅文件下载 |
| 127.0.0.1:8328 | 本机 FunASR 服务探活与调用（可选） | WAV 音频片段（本地回环，不出本机） |
| 127.0.0.1:8327 | 本机 TTS 网关探活（仅状态检查） | 空 JSON |

语音数据只在本机识别（内置 CPU 引擎或本机 FunASR），不上传任何云端。

## 文件读写

- 插件私有 storage 目录（`engine/`）：下载的引擎二进制、模型、`.part` 断点文件；`settings.json`（自动接管开关）
- `%APPDATA%/live2d-cyrene/app-settings.json`：**仅当用户点「一键修复」**时写入 `asrEngine` / `ttsMosslandKey` 两个字段（写前自动备份为 `.local-asr-backup`）。背景：宿主 v1.2.1 的 `asrEngine="local"` 是占位枚举（无引擎实现，startCall 必失败），需改为 `mossland`（其 start() 只校验 key 非空、不联网）语音通话才能建立；本插件接管输入后 mossland 不实际接收音频，仅作陪跑引擎，识别全部由本插件完成。

## 子进程启动

仅当用户在「服务配置」里指定了启动命令（路径经文件选择器选取后存插件 storage），或点「启动服务」按钮时，detached 启动该可执行文件（如 `start_asr_silent.bat`）。启动参数不来自自由文本输入，只来自文件选择结果。插件停用不杀进程（外置服务生命周期独立，同宿主行为一致）。

隐藏采集窗口说明：自动接管触发的隐藏 BrowserWindow 仅加载插件自身 `ui.html?autocap=1`（开麦 + VAD），无外部页面加载，通话结束或插件停用时自动销毁。

## 密钥处理

不处理任何 API 密钥（不读、不存、不打日志）。`ttsMosslandKey` 写入的是无意义占位字符串（宿主 mossland 引擎仅校验非空、不联网）。

## 关于动态 require 的说明（review-checklist 三-2）

index.cjs 存在**一处**动态 require：加载本插件自己下载到私有 storage 的 sherpa-onnx 引擎模块。原因：宿主插件 zip 限制 ≤50MiB，243MB 模型无法随插件目录分发，设计为「运行时下载（URL 固定常量、字节数校验）→ 校验后加载」，下载与加载逻辑全部在 index.cjs 内可审计，无隐藏第三方依赖。如认为不符合收录标准，愿按维护者建议调整（如改为收录后由维护者单独审核引擎下载模块）。

## 产物自包含与冒烟

- index.cjs 顶层仅 `require("electron")`（宿主提供，与所有含 UI 的插件一致）及 Node 内置模块；**不再 require 任何宿主 dist 内部模块**（v0.4.9 移除 call-manager 依赖）
- 目录内资源文件用途：`ui.html`（插件面板 + 麦克风采集渲染进程）、`asr-worker.cjs`（Worker 线程执行引擎推理，避免阻塞主进程）
- 注册 2 个工具：`local-asr_status`（safe/read）、`local-asr_stop`（input-control/mutation），id 均以插件 id 为前缀
- IPC 通道均为 `plugin:local-asr:*` 形式（合法字符，≤64 字符）
- `unregister` 幂等可重复调用（事件解绑 + 窗口关闭 + 租约释放 + 定时器清理 + 下载中止）
- 已知限制如实披露：内置引擎为 CPU 推理，识别质量略低于 GPU 版 FunASR；TTS 不在本插件职责内，README 已说明

## 与主干可能的合并冲突说明

`registry.json` / `README.md` 表格仅新增/更新 local-asr 自身条目。若主干在我方提交后新收录了其他插件（如 chat-export）导致合并冲突，**保留双方条目/行**即可，无交叉语义。

## 源码仓库

https://github.com/boring9720/cyrene-local-asr
