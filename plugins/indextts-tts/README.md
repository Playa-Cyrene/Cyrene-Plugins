# IndexTTS 本地语音（indextts-tts）

在本机启动一个 **IndexTTS 2.x** 语音合成服务，暴露 GPT-SoVITS 兼容的 `/tts` 接口，
供 Cyrene 现有的 **GPT-SoVITS 通道**直接调用。插件只负责「起服务 / 停服务 / 配置」，
语音链路（自动朗读、消息回听、缓存、通话）继续复用 Cyrene 本体内置实现。

## 更新说明

**1.1.0**

- 新增**下载镜像回退**（「高级选项 → 镜像」）：一律**先走官方源，官方失败才走镜像**，全部失败才报错。覆盖 IndexTTS 仓库 zip、`uv` 可执行文件、`uv sync`（PyPI / CPython）与模型权重下载。镜像可留空 = 只用官方源；模型权重另按「模型来源」决定先试哪条路，失败自动换另一条。
- 修复「停止服务」在 Python 进程未能真正终止时仍显示「服务已停止」的问题，现在会如实提示失败原因。
- 新增配置项都是可选的，**旧配置无需迁移**（升级后镜像字段会填上默认值）。

## 前置要求

**用「一键安装」时不需要手动准备任何环境**（插件会自动下载仓库、uv、Python 与依赖、模型）。
以下仅针对**手动配置**（在「高级选项」里自己填 Python 与模型目录）：

1. 本机已有一个能跑 `index-tts` 的 Python 环境（`pip install index-tts` + `torch`）。
2. 已下载 IndexTTS 模型 checkpoint 目录（目录内需包含 `config.yaml`）。
3. 无需安装任何额外的 pip 包：本插件的服务端只用 Python 标准库 `http.server`。

## 使用方式

**一键配置 / 一键安装（推荐）**

1. 在 Cyrene 插件列表中启用本插件。
2. 打开插件窗口，点「选择」挑一个 **安装目录**，再点 **「一键配置并启动」**：
   - **已经装好 IndexTTS**：插件自动识别 Python 与模型目录，保存配置并直接启动。
   - **还没装过**：插件会先弹窗确认，然后**从 GitHub 全自动安装**——下载 IndexTTS 仓库 → 下载 `uv` → `uv sync`（自动装 Python 与 torch 等依赖）→ 下载模型权重**与辅助模型**（`checkpoints/hf_cache/`，含 `w2v-bert-2.0`、BigVGAN、semantic_codec、campplus）。首次约 10–30 分钟、数 GB 流量，请确保网络与磁盘空间充足。
3. 在 Cyrene 的 **设置 → TTS → 选择「GPT-SoVITS」**，把 **API 地址** 填成插件窗口显示的地址（默认 `http://127.0.0.1:9880`），并按 GPT-SoVITS 的常规方式填写 **参考音频路径** 与 **参考音频对应的文本**（后者仅为满足宿主契约，IndexTTS 只需要参考音频，不使用该文本）。
4. 之后 Cyrene 的自动朗读、消息回听、通话语音都会走本插件的本地服务。

**手动配置**：展开窗口底部的「高级选项」，自行填写模型目录 / Python 路径 / 端口 / 引擎版本。

也可以直接对昔涟说「启动 IndexTTS 服务」「IndexTTS 服务状态」，由 AI 调用插件工具完成。

## 配置项

一键配置只需指定 **IndexTTS 安装目录**；以下细节项在「高级选项」里：

| 配置 | 说明 |
| --- | --- |
| IndexTTS 安装目录 | 一键配置用：自动从中识别 Python 解释器与模型目录 |
| 模型目录 | IndexTTS checkpoint 目录（含 `config.yaml`） |
| Python 路径 | 已安装 `index-tts` 与 `torch` 的 Python 解释器 |
| 端口 | 本地服务监听端口，默认 `9880` |
| 引擎版本 | `v2`（IndexTTS 2.0，默认）/ `v2_5`（IndexTTS 2.5，best-effort）。**下拉框只是建议值**：实际以模型目录 `config.yaml` 里的 `version` 为准，插件会自动校正（选错会拿 2.5 的代码加载 2.0 的模型而崩溃） |
| 启用插件时自动启动服务 | 勾选后插件启用即拉起服务 |
| 文本情感引导 | 按合成文本的情感改变语气；开启会**额外加载 QwenEmotion 情感模型**（占更多内存），默认关闭 |
| GitHub 镜像前缀 | 仓库 zip / `uv` / CPython 的镜像前缀（默认 `https://gh-proxy.com/`、`https://ghfast.top/`），**仅在官方源失败后回退**；多个用逗号分隔，留空 = 只用官方 |
| PyPI 镜像 | `uv sync` 装依赖**失败后**回退用的索引（默认清华源 `https://pypi.tuna.tsinghua.edu.cn/simple`），留空 = 只用官方 PyPI |
| 模型来源 | `自动`（默认，上游按网络探测）/ `ModelScope / hf-mirror`（国内）/ `官方 HuggingFace`。它决定**先试哪条路**：失败会自动换另一条路再试一次 |

## 提供的工具

- `indextts-tts_status`：查询服务运行状态、地址与配置
- `indextts-tts_start`：启动本地服务
- `indextts-tts_stop`：停止本地服务并释放显存

## 行为说明

- **子进程**：插件启用（或点击启动）时，用你配置的 Python 解释器执行插件目录内的 `indextts_server.py`，参数为你填写的模型目录、端口与引擎版本；停用插件或点击停止时会终止该进程。若进程未能真正终止（被安全软件拦截等），窗口会提示「停止失败」并让你手动结束，**不会谎报已停止**。
- **网络**：服务仅监听 `127.0.0.1`，不对外暴露；服务运行期间插件只向该本地地址做 `/health` 就绪探测（一键安装时的网络访问见下一条）。
- **一键安装时的网络访问**（仅当你点击「一键配置并启动」且本地没有可用安装时发生，会先弹窗确认）：
  - `codeload.github.com`：下载 IndexTTS 仓库 zip（**上游 `main` 分支，未固定版本、未做哈希校验**，仅校验解压后必须含 `pyproject.toml`）；
  - `github.com/astral-sh/uv/releases/latest`：下载 `uv` 可执行文件（**取最新版，未固定版本、未做哈希校验**；下载会校验 `Content-Length`）；
  - `uv sync` 会访问 PyPI / `download.pytorch.org` 等依赖源安装 Python 与 torch；
  - 模型权重与辅助模型由 IndexTTS 自带的下载器拉取，按网络环境自动选择 HuggingFace 或 ModelScope。
- **镜像回退（可选，默认已填好一组国内镜像）**：以上下载**一律先走官方源，只有官方失败时才按「高级选项 → 镜像」的配置重试**，全部失败才报错。镜像请求都由本机发起、只承载上面这些公开资源，**不上传任何用户数据、不涉及密钥**：
  - GitHub 镜像前缀（默认 `gh-proxy.com`、`ghfast.top`）：`codeload.github.com` 与 `github.com` 两处下载失败时，改为经该代理拉取；同一前缀也用于 `UV_PYTHON_INSTALL_MIRROR`（uv 自己下载的 CPython 来自 `github.com/astral-sh/python-build-standalone/releases`）；
  - PyPI 镜像（默认 `pypi.tuna.tsinghua.edu.cn`）：`uv sync` 失败后作为 uv 的默认索引（`UV_DEFAULT_INDEX` / `UV_INDEX_URL`）重试；
  - 模型权重：先按「模型来源」选的路径下载，失败后换另一条路再试一次——带 `USE_MODELSCOPE=true`（并设 `HF_ENDPOINT=hf-mirror.com`）走 ModelScope / hf-mirror，或带 `USE_MODELSCOPE=false` 走官方 HuggingFace。这两个是 IndexTTS 自带下载器认的变量（`indextts/utils/network_detection.py`），`hf-mirror.com` 也是上游自己就有的回退点。
  - **信任提示**：仓库 zip 与 `uv` 二进制下载下来是要执行的，经第三方代理下载等于信任该代理不会替换内容；上游 zip 本身又是 `main` 分支、未固定版本、未做哈希校验（见上）。介意的话把镜像前缀清空，即只用官方源。
- **文件读写**：服务运行期间只读取插件目录内的 `indextts_server.py`、你指定的模型目录，以及 Cyrene 请求中携带的参考音频路径；**不写宿主数据目录**。**一键安装会写你指定的安装目录**（IndexTTS 仓库文件、`.venv/`、`checkpoints/` 以及下载缓存 `.cyrene-bootstrap/`）。配置保存在 Cyrene 的插件私有存储中（卸载重装不丢）。
- **密钥**：不涉及任何 API key，不读取、不落盘。
- **输出格式**：默认返回**原始 WAV 字节**（GPT-SoVITS api_v2 契约——Cyrene 的 GPT-SoVITS 通道用 `resp.arrayBuffer()` 直接读字节）。IndexTTS 推理只产出 WAV，本服务不含 mp3 编码器，故不谎报格式。

## 已知限制

- 一键安装需要 **NVIDIA 显卡 + 较新的显卡驱动**（IndexTTS 用 CUDA 版 torch）；macOS 暂不支持自动安装，需手动准备环境。
- 一键安装用 `uv sync`（不带 extras），跳过 deepspeed / flash-attn 等易装失败的组件，只装推理所需依赖。
- 镜像**不覆盖 `download.pytorch.org` 的 torch CUDA wheel**：若该域名在你的网络不可达，需要在安装目录用 `uv.toml` 或 `UV_INDEX` 自行覆盖 `pytorch-cuda` 索引。
- PyPI / CPython 镜像依赖 uv 的环境变量（`UV_DEFAULT_INDEX` / `UV_PYTHON_INSTALL_MIRROR`）：插件会下载最新版 uv，用户机器上残留的旧版 uv 可能忽略这些变量，此时 `uv sync` 的镜像回退无效（会如实报错）。
- 安装目录会写入 IndexTTS 仓库文件、`.venv/`、`checkpoints/`（含辅助模型 `hf_cache/`）以及下载缓存 `.cyrene-bootstrap/`。
- `v2_5`（IndexTTS 2.5）为 best-effort：不同构建的 `infer_v2_5` 参数可能不一致，推荐使用默认的 `v2`（2.0）。
- 首次启动需加载模型，可能耗时 1-3 分钟（CPU 更久），期间窗口显示「启动中」，此时可点「停止」取消。
- **手动配置**且 `checkpoints/hf_cache/` 不存在时，首次启动会先下载辅助模型（数 GB），可能超出就绪窗口而失败——建议改用一键安装（会预下载）。
- 连续崩溃 / 启动失败 3 次后会停止自动重启（**就绪后崩溃也计入**；稳定运行 60s 才重置计数），需要检查配置后手动启动。
- 若目标端口已被其它服务占用（例如你另外跑着 GPT-SoVITS / IndexTTS），插件会报启动失败并**停止重试**，不会反复拉起 Python 进程。
- 在 Cyrene 的 GPT-SoVITS 设置里，**「输出格式」请选 wav**（本服务只产出 wav）。
- **语速不生效**：Cyrene 会传 `speed_factor`，但 IndexTTS 推理接口没有速度参数，本服务忽略它。
- **文本情感引导（可选，默认关）**：开启后 IndexTTS 用 QwenEmotion 按文本情感调整语气，代价是额外加载一个 Qwen 模型（`device_map="auto"`，显存紧张时会被卸载到内存）。
- 情感引导目前只能根据**合成文本本身**判断情感。Cyrene 的心情（`feeling`）保存在主进程内存中、未向插件开放，因此暂时无法把 Cyrene 的心情直接喂给它——那需要宿主提供插件可读的运行时状态接口（可作为后续讨论）。
- **内存占用**：服务会把模型常驻内存（IndexTTS 2.0 + torch/CUDA 上下文通常数 GB），这是模型本身的占用、不是泄漏；停止服务或停用插件即释放。

## 开发者

Downfallofthedownfall
