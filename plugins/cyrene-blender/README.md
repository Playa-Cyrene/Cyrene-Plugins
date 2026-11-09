# Blender 工作台 0.1.0

插件作者（市场显示）：**抽卡保底真君**  
原仓库：[sixtysevenlf/dsh-blender-plugin](https://github.com/sixtysevenlf/dsh-blender-plugin)。上游作者、版权和许可证声明保留在随附源码与 `THIRD_PARTY_NOTICES.md` 中。

把本机 Blender 接入 Cyrene。中文设置面板提供连接检查、场景清单、视口截图、静帧和动画渲染队列。对话工具可以按名称调整现有物体的位置、旋转和缩放，也可以保存独立工程副本。

这是第一版适配插件，基于固定版本的 dsh-blender-plugin 网关与扩展，不需要安装 DSH 主程序。当前只支持 Windows、一个 Blender 实例。它提供制作动态壁纸的操作基础，不会自动完成家具建模、角色动作或壁纸与聊天事件的联动。

## 安装

1. 在 Cyrene 的插件管理中选择从 ZIP 安装 `cyrene-blender-0.1.0.zip`，安装后手动启用「Blender 工作台」。也可把解压后的 `cyrene-blender` 整个目录放入当前 Cyrene 用户数据目录下的 `plugins`，重启再启用。
2. 准备 Node.js 24.9 或更高版本，以及具有实际 `blender.exe` 的 Blender 4.2+。本次验证使用 Blender 4.5.15 LTS。微软商店的 `blender-launcher.exe` 不适合作为后台渲染程序，因为它不会可靠转交输出和退出码；建议用官方便携版。
3. 下载上游固定版本 [DSH Blender Bridge 3.1.0-alpha.1](https://github.com/sixtysevenlf/dsh-blender-plugin/releases/download/v3.1.0-alpha.1/dsh_blender_bridge.zip)。在 Blender「编辑 → 偏好设置 → 插件」的菜单选择「从磁盘安装」，选择下载的 ZIP，启用 **DSH Blender Bridge**。上游扩展名称保留，以对应其作者与许可证。下载文件的 SHA256 为 `c50e04bb518f1f5aa867aaa7b7980f79ac51148acf1975042e5586201601caca`。本包不内嵌该 ZIP；也可将随附 `vendor/dsh-blender/extension/dsh_blender_bridge` 目录内的文件压缩为 ZIP，使 `blender_manifest.toml` 位于 ZIP 根目录，再从磁盘安装。
4. 在 Cyrene 的功能插件列表点击 Blender 工作台的「打开」，填写 `node.exe`、`blender.exe` 和输出目录的绝对路径，保存后启动网关。默认端口 **39878**。支持嵌入面板的宿主版本也可直接从插件设置进入。
5. 在 Blender 的桥接扩展面板填写相同网关端口并连接 `127.0.0.1`。回到 Cyrene 刷新诊断，看到一个就绪实例后先读取场景、截取预览，再尝试渲染当前帧。

Node 官网：<https://nodejs.org/>。Blender 官网：<https://www.blender.org/download/>。运行时不自动下载或安装依赖。

## 使用示例

- “读取 Blender 当前场景，告诉我有哪些物体。”
- “把名为 Bed 的物体移动到 [0, 1, 0]，其他物体不动，然后截图检查。”
- “保存当前工程副本，以 50% 分辨率渲染当前帧。”
- “把第 1–480 帧按 60 fps 提交为动画渲染，之后查询任务进度。”

位置和缩放采用物体的本地坐标，旋转使用欧拉角，单位为弧度。不会修改关键帧、约束、绑定或自动修复拓扑。调整已有关键帧或约束驱动的物体时，最终评估姿势仍由 Blender 决定。

渲染保存独立 `.blend` 副本，并由独立 Blender 进程读取。输出为 **PNG 序列**；帧率随副本保存，首版不自动合成 MP4。返回任务编号只表示已提交，完成后还会检查 PNG 数量。渲染使用工程原有引擎、材质和采样设置，分辨率百分比默认 50%；不会宣称已启用 GPU。

## 工具

| 工具后缀（统一前缀 `cyrene-blender_`） | 用途 |
| --- | --- |
| `status` / `inspect` | 检查连接、读取场景，清单最多 500 项并标记截断 |
| `transform` | 按准确名称调整一个已有物体 |
| `preview` | 保存视口 PNG，返回绝对路径，后续可用 Cyrene 的 Read 分析 |
| `save_copy` | 保存独立工程副本 |
| `render` | 提交静帧或最多 3600 帧的动画渲染 |
| `job_status` / `cancel_job` | 查看或取消本次插件会话创建的任务 |

工具不提供任意 Python 执行入口。内部 Python 由固定操作模板生成，名称和路径经 JSON 编码，不作为代码拼接。所有工具关闭成功结果缓存，避免重复使用旧场景或截图。

## 当前边界

- 每个网关仅连接一个 Blender。上游 3.1 预览版的多实例路由未完成，遇到多个实例会拒绝操作。
- 在 Blender 中暂停控制后，插件不会自动恢复、强制接管或绕过暂停。
- 手动编辑可能触发上游 `human_modified`。首版请停止并重新启动网关，重新读取场景后继续；不会自动清除修改保护。
- 快照不会自动打包外部纹理、链接库或缓存。外部资源须仍可访问；移动项目之前请在 Blender 中检查或打包资源。
- 单次场景操作超时后不自动重试；操作可能已开始，请刷新并检查实际场景，避免重复修改。
- 停止网关、停用插件或退出 Cyrene 会取消插件创建的活动渲染任务。当前队列记录只保存在本次会话；输出文件保留。
- 视口截图需要有正常图形界面的 Blender。后台 Blender 的测试不能代替截图验证。
- 首版不提供上游可选的 glTF 校验功能，也不随包安装其 `gltf-validator` 依赖。

## 网络、文件与进程

- 适配层只访问 `127.0.0.1`。配套网关通过本机 HTTP 与扩展 WebSocket 通信，不需要 API 密钥；网关没有公网部署功能。连接期间，本机可信进程可访问网关的控制接口，因此只在需要时启动。
- 配置和网关工作文件写入宿主提供的插件私有数据目录。预览、快照、渲染写入用户选定输出目录，使用唯一文件名，不覆盖源工程。截图和日志可能包含场景名称或本机路径。
- 插件启动独立 Node 网关；渲染队列启动独立 Blender 子进程。停用时只清理自己启动的进程树，不关闭用户已有 Blender 窗口。
- 本插件不调用上游素材市场、在线生成或第三方账号功能。原版 Blender 扩展保留上游界面，用户自行使用其中第三方功能时遵循上游说明。
- 未声明 `deps`，不访问 Cyrene 对话历史、密钥或语音服务。原生插件在 Cyrene 主进程中运行；设置页面使用宿主公开的隔离面板桥。
- 通过 Agent 对话操作时，工具返回的场景信息、物体名称和文件路径会进入模型上下文；让 Agent 查看预览时，图像也可能发送至当前配置的模型服务。本机网关通信不代表整个对话过程均留在本机。

## 来源与构建

上游版本、提交和 SHA256 见 `vendor-lock.json`。许可证及本地改动见 `THIRD_PARTY_NOTICES.md`，上游源码随 `vendor/dsh-blender/extension` 保留。Cyrene 适配代码为独立 CJS 文件，不依赖宿主内部模块或外部 npm 包。

源工程中包含可重复的依赖准备脚本、SDK/协议测试和独立 Blender 测试脚本。发布 ZIP 仅包含运行文件，不包含测试、构建脚本、Python 缓存、内嵌 ZIP、node_modules 或第三方可执行程序。当前尚未发布独立源码仓库。
