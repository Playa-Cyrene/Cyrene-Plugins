# 神悟课堂（better-lessons）

把 learn 模式的对话式讲解，变成一间可以「演」出来的教室。

在 learn 模式下，昔涟可以把要说的话写成一份 **BLS 剧本**，然后在这个插件自带的独立窗口里演出：教室背景 + 黑板 + 立绘 + 底部对话框，由**鼠标点击逐帧推进**。剧本以纯文本文件的形式落在工作区的 `learn/lessons/` 下，可以重放、可以手工修改、可以继续续写。

![神悟课堂截图](https://raw.githubusercontent.com/yuzu-tanuki/Cyrene-Better-Lessons/main/assets/0.1.0.png)

## 功能

- **BLS 剧本文本格式**：全篇只有 `meta` / `say` / `board` 四个关键字，板书正文就是 markdown，个别行写错只跳过该行，不会卡死整堂课。
- **点击推进**：一次点击推进一个 step，节奏由用户掌握。
- **课堂插话**：在下方的聊天框里提问，昔涟可以写出新的一层剧本、打断当前播放，演完后回到刚才那一步继续讲，板书按断点瞬时重绘。
- **回放**：剧本留在 `learn/lessons/`，可以「重放本节」或「从头」重演整节课，全程不触发大模型。
- **公式与代码**：板书支持标准 markdown 与 LaTeX（`$...$` / `$$...$$`），新内容自动滚入视野。
- **立绘演出**：讲述 / 板书 / 擦板，每次点击都是「走过去 → 停一下 → 走回来」的一次性造访（擦板有挥舞差分时两帧交替，缺差分时保持静态）。
- **自带全部素材**：教室、黑板、立绘都在插件自带的 `assets/` 里，不读取宿主仓库的任何资源；素材缺失时退回纯 CSS 占位。

## 启用方式

1. 在 Cyrene 中打开 **设置 → 插件 → 导入 ZIP**，导入后**手动启用**（用户插件首次安装默认停用）。
2. 进入 learn 模式并绑定一个工作区。
3. 直接请昔涟讲点什么，例如「给我讲讲判别式」。模型会调用 `better-lessons_write_lesson` 写剧本、再用 `better-lessons_push_script` 推送，教室窗口自动打开。

也可以从插件列表的「打开」按钮直接进入窗口，再用标题栏右侧的控件播放：

| 控件 | 作用 |
| --- | --- |
| `📂 打开剧本` | 用系统文件选择器挑 `.bls` 剧本；单选 = 重放本节，多选 = 按文件名顺序当作一整节课 |
| `⟲ 本节` | 重放当前这一层 |
| `⟲ 从头` | 按播放列表顺序重演整节课 |

窗口默认占左半屏，右半边可以放别的东西（例如 learn 模式写在 `notes/` 里的笔记）。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `better-lessons_write_lesson` | 把 BLS 正文写入 `learn/lessons/<file>`（同名覆盖；解析出 0 个有效 step 时会删掉坏文件并回传行号） |
| `better-lessons_push_script` | 按文件名读取剧本并推送演出（默认打断当前播放，可改为排队） |
| `better-lessons_lesson_list` | 列出 `learn/lessons/` 下的剧本文件 |
| `better-lessons_status` | 查询课堂状态：是否开着、当前文件、第几步、板书全文 |
| `better-lessons_close` | 关闭课堂窗口 |

另注册一个 Prompt Provider：在 learn 模式的每一轮把 BLS 格式说明与课堂现场（进度、板书全文、已用过的剧本清单）送到模型眼前。**是否动用课堂由模型自己决定**；插件唯一强制的一条是模型写了剧本却忘了推送时替它推出去。

## 配置项

插件没有配置文件。可用状态只有两项，保存在插件自己的 storage 里：

- 窗口尺寸 / 位置与上次绑定的会话（关闭后重开可以接着演）
- 最近 3 个会话的播放队列与板书（每会话最多 3 层）

`panel.html` 是一块可选的设置面板（开关、是否随推送自动开窗、清空课堂），当前 manifest **刻意没有声明** `settingsPanel`：这个键在较早构建的宿主 schema 里不存在，声明会导致整个插件导入失败。等宿主升到支持面板的版本后，在 manifest 里加一行 `"settingsPanel": "panel.html"` 即可启用。

## 网络、文件与权限

- **网络**：插件本身不发起任何请求、不上传任何数据。唯一的网络访问点是 `ui.css` 里 `@import` 的 **Google Fonts**（Noto Sans SC / JetBrains Mono，与宿主主窗口同一套字体）；断网或加载失败时回落到本地字体栈，不影响功能。
- **文件读取**：只读 `<当前会话工作区>/learn/lessons/` 下的 `.bls` 剧本；另外可用系统文件选择器打开用户自己挑选的 `.bls` 文件（路径由用户在对话框里指定）。
- **文件写入**：只写 `<当前会话工作区>/learn/lessons/*.bls`。**不写笔记、不写 `learn/progress.md`、不写任何其他位置**。
- **数据存储**：播放状态通过宿主提供的 `ctx.storage` 保存在插件自己的数据目录，不上传。
- **子进程**：不启动任何子进程。
- **密钥**：不需要任何密钥或账号（`deps` 只申请 `workspace`，用于取会话绑定的工作区根目录）。
- **宿主事件**：只监听 `host:turn:started` / `host:tool:finished` / `host:turn:finished` 三个公开事件，用于「写了剧本却没推送」的轮次稽核。

## 已知限制

- 窗口是插件自绘的 galgame 界面：半屏宽度下板书立绘会压住板面右侧约 42% 的区域（板书可横向滚动，长行 / 宽表格的右端仍会被挡住）。这是当前版本的取舍。
- 窗口拿不到宿主的主题 token，配色与字体是照抄宿主主窗口的固定数值；宿主里改过窗口圆角时，两边圆角会不一致。
- 不支持语音、口型同步、课件（PDF / PPT）导入与多人课堂。
- 不生产笔记：想把板书记下来，请在 learn 模式里让模型记（插件不读写 `notes/`）。

## 包内资源

| 路径 | 用途 |
| --- | --- |
| `index.cjs` | 入口：工具、Prompt Provider、事件稽核、IPC 与持久化接线 |
| `bls.cjs` / `board.cjs` / `lessons.cjs` / `rooms.cjs` / `prompts.cjs` | 同一插件的内部分模块（BLS 解析、黑板纯函数、剧本文件 IO、房间与队列、提示词），由入口以相对路径 require |
| `ui.html` / `ui.css` | 课堂窗口：教室背景、黑板、立绘、对话框与播放状态机 |
| `panel.html` | 可选设置面板，当前未在 manifest 中声明（见上文「配置项」） |
| `vendor/` | 三个单文件第三方库与 KaTeX 字体，见下文「第三方组件」 |
| `assets/` | 教室背景、黑板（板面 + 边框）、三张立绘，共 6 张 PNG，窗口运行时按相对路径加载 |

## 第三方组件

`vendor/` 下是手工 vendored 的单文件构建（无 npm 运行时依赖），来源、版本与许可证标识见 [vendor/LICENSES.md](./vendor/LICENSES.md)：

| 库 | 用途 | 许可证 |
| --- | --- | --- |
| [markdown-it](https://github.com/markdown-it/markdown-it) | 板书与对白的 markdown 渲染 | MIT |
| [KaTeX](https://github.com/KaTeX/KaTeX) | LaTeX 公式渲染（含 20 个 woff2 字体） | MIT |
| [DOMPurify](https://github.com/cure53/DOMPurify) | HTML 净化（窗口开启了 `nodeIntegration`，这一步是必须的） | Apache-2.0 / MPL-2.0 |

## 其他

- 源码仓库：[yuzu-tanuki/Cyrene-Better-Lessons](https://github.com/yuzu-tanuki/Cyrene-Better-Lessons)
- 许可证：MIT
- 开发者：yuzu-tanuki
