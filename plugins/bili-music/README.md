# B 站听歌 (bili-music)

用 B 站视频分 P 当音乐音源：搜歌 → 选分 P → 拉 DASH 音频流 → ffmpeg 转 M4A → 内置隐藏播放器直接出声。
支持 **B 站扫码登录**（可选，解锁高码率音源），匿名也可用。移植自 [astrbot_plugin_bili_player](https://github.com/57Darling02/astrbot_plugin_bili_player)，保留 LLM 可调用的工具集 + 语音听歌全链路。

> **插件独立性**：本插件只用 Cyrene 插件 SDK 公开接口（`registerTool` / `registerIpc` / `storage` / `events`）和 Electron 平台 API，**不 require 宿主内部模块**，不改宿主文件。任何 Cyrene ≥ v1.2.1（插件系统 v1）均可安装，上游升级不影响。

---

## 宿主兼容性

| 场景 | 支持情况 |
|---|---|
| 工具注册、面板 UI、扫码登录、下载转码 | ✅ 任何 Cyrene ≥ v1.2.1 |
| 聊天/工作模式点歌 | ✅（Harness 原生带工具调用） |
| **语音通话中点歌** | ⚠️ 需要宿主在通话期间向 LLM 传递工具列表；上游 v1.2.x 通话为"直接调 LLM 不带工具"，故暂不可用，上游未来支持后即开箱可用 |

> 本插件不改宿主文件、不依赖宿主内部模块。语音通话点歌的差异完全取决于宿主能力，插件侧无需任何变更。

---

## 安装

1. **装 ffmpeg**（必须）。任选一种：
   - 插件面板「设置」卡片 → **一键下载并安装**（国内镜像，约 78MB，免配置）
   - 包管理器：`winget install ffmpeg` / `choco install ffmpeg`
   - 官方：[gyan.dev/ffmpeg/builds](https://www.gyan.dev/ffmpeg/builds/) → 解压 → 把 `bin\` 加到 PATH
   - 手动放到 `C:\ffmpeg\bin\ffmpeg.exe`（插件会自动找）
2. Cyrene → 设置 → 插件 → 导入 ZIP → 启用（或从插件市场安装）

---

## 扫码登录（v0.3.0）

打开插件面板 → **「1. 账号」卡片 → 扫码登录** → 手机 B 站 App 扫一扫 → 在手机上确认 → 面板显示昵称即成功。

- **零门槛**：B 站扫码登录是产品 Cookie 协议（非开放平台），无需注册开发者、无需任何密钥
- **登录收益**：DASH 高码率音频档、单文件体积门禁 50MiB → 200MiB、降低接口限流
- **自动续期**：SESSDATA 约 30 天有效，到期自动走官方刷新链（cookie/info → correspondPath → cookie/refresh → confirm/refresh）换新凭据，无需重扫
- **隐私**：凭据（SESSDATA/bili_jct/DedeUserID/refresh_token/buvid）只存在本机 `plugin-data/bili-music/bili-cookies.json`，不发送到任何第三方
- **退出**：面板「退出登录」按钮，一键删除本地凭据

---

## 工具一览

| 工具 ID | 用途 | 风险 |
|---|---|---|
| `bili-music_search` | 关键词搜 B 站视频，返回候选列表 | safe |
| `bili-music_video_info` | 输入 BV 号，列出全部可交付分 P | safe |
| `bili-music_play` | 下载指定分 P → 转 M4A → 内置播放器直接出声（`enqueueOnly=true` 只入队） | mutation |
| `bili-music_playback` | 播放控制：pause / resume / stop / next / volume(0-100) / status | safe |
| `bili-music_probe_ffmpeg` | 体检 ffmpeg 是否可用 | safe |
| `bili-music_login_status` | 查询 B 站扫码登录状态（昵称/大会员标记） | safe |

> v0.2.0 播放器：隐藏 BrowserWindow + `<audio>`，**不依赖宿主音乐服务**（网易云 OpenAPI 未配置照样能播）。播放中再点播自动入队，播完自动切下一首；stop 清空队列。

---

## 使用示例（自然语言，语音/文字皆可）

- `搜一下周杰伦的晴天` → `bili-music_search`
- `播放第一首` → `bili-music_play(bvid=BVxxx, page=1)` → 直接出声
- `再来一首稻香` → 播放中自动入队
- `暂停` / `继续` / `下一首` / `声音小一点` / `现在放的什么` → `bili-music_playback`
- `看看 BV1xxxxxxx 有几集` → `bili-music_video_info`
- `B站登录了吗` → `bili-music_login_status`

---

## 交付边界

| 类型 | 限制 |
|---|---|
| 单分 P 音频 | 匿名 ≤ 50 MiB；登录后 ≤ 200 MiB；超过直接拒绝 |
| 时长 | 不限 |
| 音质 | DASH 最高（30280=192k / 30232=128k / 30216=64k 自动选最大；登录可解锁更高档） |
| 候选数 | search 默认 10 条，最多 20 |
| 候选显示 | 标题 + UP主 + 时长 + 播放量；超 15 分钟标"仅可下载" |

---

## 已知限制

- **付费/试听/地区受限** → B 站返回 DASH audio 为空，自动 `E_DASH_AUDIO_MISSING`
- **扫码协议为非官方逆向接口**，存在变动可能；社区生态（bilibili-API-collect）多年稳定维护
- **搜索已走 WBI 签名**（v0.3.1 起）：`/x/web-interface/wbi/search/type`，mixin_key 缓存 12 小时
- **极验证码**：极少数风控场景 B 站会要求人机验证（gaia-vgate），桌面场景罕见；如遇登录异常请重新扫码
- **没有本地缓存**：每次都重新下载转码，节省磁盘换时间
- **与宿主网易云音乐工具并存**：宿主 `music_*` 工具未配置 OpenAPI 时必然失败，会让 LLM 误选。建议在 Cyrene 工具开关里手动关闭 `music_*` 系列

---

## 文件落点

- 默认数据目录：`%APPDATA%\live2d-cyrene\plugin-data\bili-music\audio\`（面板「设置」可改为任意目录，支持弹窗选择）
- 文件名格式：`<视频标题> - p<分P索引> - <分P名>.m4a`
- 登录凭据：`%APPDATA%\live2d-cyrene\plugin-data\bili-music\bili-cookies.json`（仅本机）
- 用户设置：`%APPDATA%\live2d-cyrene\plugin-data\bili-music\settings.json`（ffmpeg 路径 / 下载目录）
- 一键安装的 ffmpeg：`%APPDATA%\live2d-cyrene\plugin-data\bili-music\bin\ffmpeg.exe`

---

## 故障排查

| 现象 | 处理 |
|---|---|
| `E_FFMPEG_NOT_FOUND` | 装 ffmpeg 并加 PATH，或放 `C:\ffmpeg\bin\` |
| `E_DASH_AUDIO_MISSING` | 该视频是付费/试听/地区受限，换别的候选 |
| `E_AUDIO_TOO_LARGE` | 分 P 超体积门禁；登录后放宽到 200 MiB，或换短版本 |
| `E_PLAYER_NOT_ACTIVE` | 播放器未启动（还没播过歌），先 `bili-music_play` |
| 二维码已失效 | 180 秒有效期到了，点「重新生成二维码」再扫 |
| 登录显示已过期 | Cookie 刷新失败（refresh_token 失效/账号异地等），重新扫码即可 |
| 搜索没结果 | 换关键词；公开搜索对长尾词召回差 |

---

## 隐私

- 登录凭据仅保存在本机数据目录，所有 B 站请求直连 bilibili 官方域名（passport/api/www.bilibili.com），不经过任何中间服务器
- Cookie 刷新使用 B 站官方 Web 端机制（RSA-OAEP correspondPath），公钥与流程来自社区公开文档 [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect)
- 「退出登录」立即删除本地凭据文件

---

## 协议

- 移植自 [astrbot_plugin_bili_player](https://github.com/57Darling02/astrbot_plugin_bili_player) (MIT)
- 二维码渲染使用 [qrcode-generator](https://www.npmjs.com/package/qrcode-generator) (MIT, Kazuhiko Arase)
- B 站 API 调用遵循其公开接口规范；遵守 B 站用户协议
