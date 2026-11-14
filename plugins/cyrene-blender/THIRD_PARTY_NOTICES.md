# 第三方来源与修改

本发行包含 dsh-blender-plugin 3.1.0-alpha.1 的运行资源，来自：

- 项目：<https://github.com/sixtysevenlf/dsh-blender-plugin>
- 提交：`68513f23e068eaa36cd958af9ba9aa068c64752b`
- 固定发布：<https://github.com/sixtysevenlf/dsh-blender-plugin/releases/tag/v3.1.0-alpha.1>
- Node 网关：BSD-3-Clause，许可证原文位于 `vendor/dsh-blender/LICENSE`。
- Blender 扩展：GPL-3.0-or-later，许可证原文位于 `vendor/dsh-blender/extension/LICENSE`，版权与衍生声明位于 `vendor/dsh-blender/extension/NOTICE`。
- 完整 Python 扩展源码随包提供；原版扩展 ZIP 的固定来源为 <https://github.com/sixtysevenlf/dsh-blender-plugin/releases/download/v3.1.0-alpha.1/dsh_blender_bridge.zip>，SHA256 记录在 `vendor-lock.json`；本版安装须使用随附的鉴权适配源码自行打包，原版不兼容连接码。上游 MIT 衍生内容的声明保留在对应 NOTICE 文件中。

本地网关修改（2026-11-09）：

`lib/runtime/core/queue/spawn-executor.js` 中，将 `-b --factory-startup` 移至工程路径之前；增加 `--disable-autoexec`，不自动运行工程内嵌脚本；增加 `--python-exit-code 20`，使渲染前配置错误返回失败。Blender 4.5.15 对照实验未复现原参数顺序清空场景，这一顺序调整不是已确认的缺陷修复。

同一文件的后台渲染初始化固定设置 `scene.frame_step = 1` 和 `scene.render.use_file_extension = True`，以连续输出请求范围内带 `.png` 扩展名的每一帧；只修改独立渲染进程中的场景，不改写源工程。

`lib/runtime/http/router.js` 与 `lib/runtime/transport/addon-ws.js` 增加请求检查：拒绝带浏览器 Origin / Sec-Fetch-Site 的请求及非回环 Host。Cyrene 通过主进程 IPC 调用，Blender 扩展使用本机原生连接，因此不需要浏览器直连网关。

从分发产物删除未提供依赖的 `lib/runtime/ext/gltf_validate_runner.js`。同步移除 `lib/runtime/core/plan-dispatch.js`、`lib/runtime/core/plan/ext-check.js`、`lib/runtime/core/plan/ext-check-candidates.js`、`lib/runtime/core/plan/ext-check-result.js` 和 `lib/runtime/catalog/data.js` 中对应的 glTF 校验调用、结果处理及能力条目；其余外部网格检查分支保持上游实现。

本轮修改（2026-11-14）：

- 新增 `lib/runtime/auth.js`；`gateway/app.js`、`http/router.js`、`transport/addon-ws.js` 对 HTTP 和 WebSocket 分别验证每次启动的独立 256 位随机凭据。未配置凭据时不启动，错误或缺失凭据返回 401；原有浏览器与 Host 限制保留。
- `extension/dsh_blender_bridge/config.py`、`server.py`、`transport.py`、`ui/preferences.py`、`ui/panels/index.py` 增加不持久化的连接码字段、握手头及错误提示；隐藏不适用于 Cyrene 的虚拟显示依赖安装和 Selection → DSH 入口。保留上游版权、许可证和其余功能源码。
- `core/queue/spawn-executor.js` 接受显式帧率、分数基数及原生分辨率百分比，只在后台渲染进程应用；不将网关凭据继承给后台 Blender。
- 实际使用模块与保留模块、网络/文件/进程边界见 README「实际使用的上游模块」。

其余上游实现保持原样。上游 source map、类型声明、Python 缓存和内嵌 ZIP 未纳入运行包。

`vendor-lock.json` 记录原始发布资产哈希。适配层仅启动独立网关，不加载上游面向 DSH 的宿主入口，未分发 DSH 主程序或其 npm peer dependencies。
