# 来源

插件作者：Noimpty。原仓库：[Cyrene-Agent-Plugin / codex/cyrene-hud-upstream](https://github.com/LZhWi/Cyrene-Agent-Plugin/tree/codex/cyrene-hud-upstream)。

采集器派生自 Playa 的 Cyrene-Plugins `plugins/system-status/index.cjs`（MIT）。

- 上游：https://github.com/Playa-Cyrene/Cyrene-Plugins/tree/main/plugins/system-status
- 读取日期：2026-10-08
- 读取的上游 index.cjs SHA-256：acd319d1cc6db925dce70761fef354a9b7a9bd9e36fbceaccae23b4ec5e15719
- 原版权和 MIT 许可完整保留在 LICENSE。

本地改动：采集器内置于 cyrene-hud，由主进程定期采集，通过插件自身 IPC 向 HUD 提供最新快照，不再依赖独立 system-status 插件。移除上游全部 AI 工具和原窗口；修正网络累计值的取法；合并进行中的采集，计划采集绕过默认 2.5 秒完成缓存；停用时中止子进程并拒绝迟到结果；NVIDIA 固定读取 GPU 0，失败后 30 秒重试；区分接通电源和充电，缺失值保留为空。

HUD 的 HTML/CSS 为本地新实现，没有复制 zmd-charge-plus 的代码或素材。

配色与字体栈参考 Cyrene-Agent 的 `src/renderer/react/styles/react-root.css`、`src/renderer/ui/theme.css` 和 `src/renderer/ui/tokens.css`。`avatar.svg` 派生自该项目 `src/renderer/public/icons/cyrene-avatar-line.svg`，HUD 的线稿显示经过颜色、宽度与位置调整；资源随插件分发，不要求读取宿主内部资源路径。

原生辅助程序的源码见原仓库 [native/GlassHost.cs](https://github.com/LZhWi/Cyrene-Agent-Plugin/blob/codex/cyrene-hud-upstream/native/GlassHost.cs) 与 [native/AsusSensors.cs](https://github.com/LZhWi/Cyrene-Agent-Plugin/blob/codex/cyrene-hud-upstream/native/AsusSensors.cs)。ASUS 接口常量参考 G-Helper 的公开实现，未引入其代码依赖或设备控制功能。
