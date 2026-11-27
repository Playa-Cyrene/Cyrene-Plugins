# Blender 工作台 0.1.0

插件作者（市场显示）：**抽卡保底真君**  
原仓库：[sixtysevenlf/dsh-blender-plugin](https://github.com/sixtysevenlf/dsh-blender-plugin)。上游作者、版权和许可证声明保留在随附源码与 `THIRD_PARTY_NOTICES.md` 中。

把本机 Blender 接入 Cyrene。中文设置面板提供连接检查、场景清单、视口截图、静帧和动画渲染队列。对话工具可以按名称调整现有物体的位置、旋转和缩放，也可以保存独立工程副本。

这是第一版适配插件，基于固定版本的 dsh-blender-plugin 网关与扩展，不需要安装 DSH 主程序。当前只支持 Windows、一个 Blender 实例。它提供制作动态壁纸的操作基础，不会自动完成家具建模、角色动作或壁纸与聊天事件的联动。

## 安装

1. 在 Cyrene 的插件管理中选择从 ZIP 安装 `cyrene-blender-0.1.0.zip`，安装后手动启用「Blender 工作台」。也可把解压后的 `cyrene-blender` 整个目录放入当前 Cyrene 用户数据目录下的 `plugins`，重启再启用。
2. 准备 Node.js 24.9 或更高版本，以及具有实际 `blender.exe` 的 Blender 4.2+。前一轮适配使用 Blender 4.5.15 LTS；本轮修复的后台验证使用 Linux Blender 4.3.2，Windows 宿主全流程尚未重测。微软商店的 `blender-launcher.exe` 不适合作为后台渲染程序，因为它不会可靠转交输出和退出码；建议用官方便携版。
3. 使用本包随附的 **Cyrene 鉴权适配版**桥接扩展：将 `vendor/dsh-blender/extension/dsh_blender_bridge` 目录内的全部文件压缩为 ZIP，使 `blender_manifest.toml` 位于 ZIP 根目录。在 Blender「编辑 → 偏好设置 → 插件」选择「从磁盘安装」并启用 **DSH Blender Bridge**。已经安装原版扩展的用户需先停用、移除旧版再安装适配版；原版 3.1.0-alpha.1 不支持连接码，无法连接此网关。上游固定版本链接及原始资产 SHA256 仍保留在 `vendor-lock.json` 和 `THIRD_PARTY_NOTICES.md`，用于来源核对，不作为安装包。
4. 在 Cyrene 的功能插件列表点击 Blender 工作台的「打开」，填写 `node.exe`、`blender.exe` 和输出目录的绝对路径，保存后启动网关。默认端口 **39878**。支持嵌入面板的宿主版本也可直接从插件设置进入。
5. 点击工作台「显示本次连接码」，复制到 Blender 桥接面板的「Cyrene 连接码」，填写相同端口并连接 `127.0.0.1`。每次重启网关都会更换连接码；在 Blender 先断开，更新连接码后重新连接。连接码不保存进 Blender 偏好文件或工程，不要发送给 Agent 或其他人。回到 Cyrene 刷新诊断，看到一个就绪实例后先读取场景、截取预览，再尝试渲染当前帧。

Node 官网：<https://nodejs.org/>。Blender 官网：<https://www.blender.org/download/>。运行时不自动下载或安装依赖。

## 使用示例

- “读取 Blender 当前场景，告诉我有哪些物体。”
- “把名为 Bed 的物体移动到 [0, 1, 0]，其他物体不动，然后截图检查。”
- “保存当前工程副本，以 50% 分辨率渲染当前帧。”
- “把第 1–480 帧按 60 fps 提交为动画渲染，之后查询任务进度。”

位置和缩放采用物体的本地坐标，旋转使用欧拉角，单位为弧度。不会修改关键帧、约束、绑定或自动修复拓扑。调整已有关键帧或约束驱动的物体时，最终评估姿势仍由 Blender 决定。

渲染保存独立 `.blend` 副本，并由独立 Blender 进程读取。输出为带 `.png` 扩展名的 **PNG 序列**；后台渲染将帧步长固定为 1，连续输出请求范围内的每一帧，不改变源工程的步长或文件命名设置。未指定帧率时保留工程原始帧率（包括 29.97 等分数帧率），显式指定时使用该整数帧率。首版不自动合成 MP4。返回任务编号只表示已提交，完成后还会检查 PNG 数量。渲染使用工程原有引擎、材质和采样设置，未指定分辨率百分比时保留工程的设置，工作台的分辨率和帧率输入留空即沿用工程；任务返回实际分辨率比例。帧率只在后台进程中设置，保存副本时不写入源场景的帧率。

**每个任务从开始运行起最多 1 小时**（排队时间不计入），超过上限会终止并返回 `job_timeout`，已输出的帧保留；3600 帧是数量上限，不保证可在 1 小时内完成。复杂场景请先测试单帧，再拆分任务。后台使用 `--factory-startup --disable-autoexec`：不加载用户偏好、用户插件或工程内嵌自动脚本，Cycles 的 GPU 设备偏好也不会继承，可能使用 CPU 或因所需设备、插件不可用而失败。依赖插件、自定义驱动器的场景须先检查单帧结果。

## 工具

| 工具后缀（统一前缀 `cyrene-blender_`） | 用途 |
| --- | --- |
| `status` / `inspect` | 检查连接、读取场景，清单最多 500 项并标记截断 |
| `transform` | 按准确名称调整一个已有物体 |
| `preview` | 保存视口 PNG，返回绝对路径，工作台直接查看，宿主权限允许时可用 Read 分析 |
| `save_copy` | 保存独立工程副本 |
| `render` | 提交静帧或最多 3600 帧的动画渲染，运行最长 1 小时 |
| `job_status` / `cancel_job` | 查看或取消本次插件会话创建的任务 |

工具不提供任意 Python 执行入口。内部 Python 由固定操作模板生成，名称和路径经 JSON 编码，不作为代码拼接。所有工具关闭成功结果缓存，避免重复使用旧场景或截图。

## 当前边界

- 每个网关仅连接一个 Blender。上游 3.1 预览版的多实例路由未完成，遇到多个实例会拒绝操作。
- 在 Blender 中暂停控制后，插件不会自动恢复、强制接管或绕过暂停。
- 手动编辑可能触发上游 `human_modified`。首版请停止并重新启动网关，重新读取场景后继续；不会自动清除修改保护。
- 快照不会自动打包外部纹理、链接库或缓存。外部资源须仍可访问；移动项目之前请在 Blender 中检查或打包资源。
- 单次场景操作超时后不自动重试；操作可能已开始，请刷新并检查实际场景，避免重复修改。
- 停止网关、停用插件或退出 Cyrene 会取消插件创建的活动渲染任务。当前队列记录只保存在本次会话；输出文件保留。
- 每次启动使用独立队列，不自动恢复旧的排队任务。网关意外退出时，活动记录会标记为失败并提示检查 Blender；此时无法确认已失去连接的后台渲染是否仍在运行，请检查后再重新提交。
- 活动任务会持续保留，已结束任务仅保留最近 100 条；工作台优先展示活动任务。查询状态和取消任务都会检查已完成任务的 PNG 产物，输出不足时仍显示失败。
- `project-read-only` 权限档位只允许 Read 读取工作区内文件。默认预览在插件私有目录，可能被拒绝；可将输出目录改为工作区内，或在工作台直接看图。插件不会绕过宿主读取权限。面板状态仅含截图路径和时间，图片变化时通过独立 IPC 读取，不随状态轮询反复传输。
- 视口截图需要有正常图形界面的 Blender。后台 Blender 的测试不能代替截图验证。
- 首版不提供上游可选的 glTF 校验功能，对应入口和调用路径已从网关运行产物移除。

## 网络、文件与进程

- 适配层只访问 `127.0.0.1`。配套网关通过本机 HTTP 与扩展 WebSocket 通信，不需要 API 密钥；网关没有公网部署功能。每次启动分别生成 256 位随机 HTTP 控制凭据和扩展连接码，通过子进程环境传入网关；缺失或错误凭据会被拒绝（包括 `/health` 和 `/addon` WebSocket）。HTTP 凭据只供主进程使用；扩展连接码只能接入 WebSocket，不能调用 HTTP 控制接口。两者均不写配置、状态、日志或模型上下文，后台渲染子进程也不会继承。此机制不隔离同一用户下能读取进程内存的程序或管理员。
- 配置和网关工作文件写入宿主提供的插件私有数据目录。预览、快照、渲染写入用户选定输出目录，使用唯一文件名，不覆盖源工程。截图和日志可能包含场景名称或本机路径。
- 插件启动独立 Node 网关；渲染队列启动独立 Blender 子进程。停用时只清理自己启动的进程树，不关闭用户已有 Blender 窗口。
- 本插件不调用上游素材市场、在线生成或第三方账号功能。配套 Blender 扩展保留上游素材功能界面，用户自行使用其中第三方功能时遵循上游说明。
- 未声明 `deps`，不访问 Cyrene 对话历史、密钥或语音服务。原生插件在 Cyrene 主进程中运行；设置页面使用宿主公开的隔离面板桥。
- 通过 Agent 对话操作时，工具返回的场景信息、物体名称和文件路径会进入模型上下文；让 Agent 查看预览时，图像也可能发送至当前配置的模型服务。本机网关通信不代表整个对话过程均留在本机。

## 来源与构建

上游版本、提交和 SHA256 见 `vendor-lock.json`。许可证及本地改动见 `THIRD_PARTY_NOTICES.md`，上游源码随 `vendor/dsh-blender/extension` 保留。Cyrene 适配代码为独立 CJS 文件，不依赖宿主内部模块或外部 npm 包。

本轮验证使用独立临时目录中的协议回归、工作台交互检查、SDK 冒烟和真实 Blender 脚本。发布 ZIP 仅包含运行文件，不包含测试、构建脚本、Python 缓存、内嵌 ZIP、node_modules 或第三方可执行程序。当前尚未发布独立源码仓库。

## 实际使用的上游模块

下列网关模块路径相对于 `vendor/dsh-blender/lib/runtime/`，扩展模块路径相对于 `vendor/dsh-blender/extension/dsh_blender_bridge/`。未将保留的上游代码全部视为 Cyrene 功能；调用边界如下：

| Cyrene 功能 | 入口与主要运行模块 | 数据与副作用 |
| --- | --- | --- |
| 网关启动、连接诊断 | `gateway.js`、`gateway/app.js`、`gateway/lifecycle.js`、`http/routes/health.js`、`transport/addon-ws.js` | 仅回环监听；诊断进程、配置及工作目录，写私有网关状态 |
| 会话与暂停保护 | `http/routes/session/`、`core/sessions/`、`http/session-gate.js` | 创建、心跳、释放会话；保留人工修改和暂停保护 |
| 读取、变换、保存副本 | `http/routes/act.js`、`core/engine/`、`execution/`；扩展 `server.py`、`commands/core/__init__.py` | 通过已鉴权连接执行适配层固定模板，读取场景、按用户指令修改或保存副本 |
| 视口预览 | `http/routes/frame.js`、`core/engine/`；扩展 `commands/core/screenshot.py` | 读取视口，将 PNG 写入网关工作目录及选定输出目录 |
| 后台渲染和取消 | `http/routes/job.js`、`core/queue/manager.js`、`core/queue/spawn-executor.js` | 私有队列 JSON、独立 Blender 子进程、快照和 PNG 序列；最长 1 小时 |

保留但不由这 8 个工具调用的上游模块包括 `runtime/py/assembly`、车辆/人体构造、QC、export、plan、headless、虚拟显示，以及扩展的 PolyHaven、Sketchfab、Poly Pizza、Hyper3D、Hunyuan 集成。保留它们是为了完整来源和避免裁剪动态依赖出错；它们不是 Cyrene 的公开工具。网关所有 HTTP 路由统一鉴权，扩展连接码不能调用这些路由。扩展原有的「虚拟显示依赖安装」与「Selection → DSH」不适用于 Cyrene；相关入口已隐藏，不提供 DSH HTTP 授权。用户主动使用素材集成时，可能访问 `api.polyhaven.com`、`api.sketchfab.com`、`api.poly.pizza`、`hyperhuman.deemos.com`、`queue.fal.run`、腾讯云服务或用户配置的 Hunyuan 地址，传输搜索词、生成输入及该服务凭据，不读取 Cyrene 密钥。完整运行目录约 3.5 MiB，不含 Blender/Node 可执行文件、npm 依赖或 ZIP。
