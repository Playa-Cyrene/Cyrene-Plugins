# AGENT.md

本文件写给在本仓库工作的 AI 审核代理（你）。你有两个任务：**审核插件 PR**，以及**在维护者确认合并后执行发布**。

审核原则只有一句话：**保证插件能被 Cyrene 用上、能被市场拉到、不弄坏宿主**。不满足这个底线的 P0 问题必须修完再合；其余小问题（文档补全这类）一律按 P1 处理——**先合并，把清单留言给作者，等他后续补修**。完整检查项可参考 [review-checklist.md](./review-checklist.md)（提交者自查用），但实际审核按本文的分档执行，不必逐项卡死。

## 仓库是什么

Cyrene 插件官方收录仓库。开发者通过 PR 提交**可直接安装的插件产物**（不是源码工程），审核合并后由维护者从 `plugins/<插件id>/` 打包成 ZIP 入库 `zips/`，经 Gitee raw 直链分发给客户端。

- GitHub `origin`（`Playa-Cyrene/Cyrene-Plugins`）是主仓，PR 与审核都在这里
- Gitee（`playa0/cyrene-plugins`）是镜像，每天北京时间 04:00 由 `aggregate-downloads.yml` 自动同步，也是客户端实际的下载源——所以直链全部指向 Gitee

| 路径 | 作用 |
| --- | --- |
| `plugins/<插件id>/` | 审核通过的插件产物（manifest + 入口 + README，自包含） |
| `registry.json` | 收录索引；`zip` / `sha256` / `downloads` 由维护者发布时补齐 |
| `marketplace/<插件id>.json` | 客户端详情弹窗内容，新收录必填，格式见 [marketplace/README.md](./marketplace/README.md) |
| `README.md` | 「已收录插件」表格，含直接下载直链（官方示例插件标注「不分发」、无直链，属正常） |
| `zips/` | 分发 ZIP。被 `.gitignore` 的 `zips/*` 默认忽略，**白名单逐个放行当前分发版本** |
| `CONTRIBUTING.md` | 提交者规范；PR 描述应包含它要求的信息 |
| `review-checklist.md` | 完整审核清单（供参考与提交者自查）+ 发布流程（权威来源） |
| `scripts/publish-plugins.ps1` | **已废弃的早期方案，禁止执行**（会把 `zip` 写成 GitHub Release 附件地址） |

插件运行环境背景：插件与 Cyrene 宿主同进程，拥有完整 Node.js 权限（读写文件、联网、起子进程）。审核是收录前的闸门，但**审核不构成担保**。

## 一、审核 PR

PR 标题应为 `[插件] <id> <版本>`（新收录）或 `[更新] <id> <旧版本> → <新版本>`。命令默认在仓库根目录的 Git Bash 下执行。

### P0 阻塞项（修完才能合）

判断标准：这条不过，插件就**装不上、加载不了、弄坏宿主、或市场拉不到**。

**1. 装得上（结构与范围）**

- 单插件单 PR；diff 只触及 `plugins/<插件id>/**`、`registry.json` 中**该插件自己的**条目、README 表格中该插件的行、`marketplace/<插件id>.json`。动了别的插件、或上传了 ZIP → 阻塞（发布流程会被搞乱）
- 目录里没有 `node_modules/`、`src/`、`tsconfig.json`、构建脚本等源码工程文件（打进包里体积爆炸）
- manifest 过基本校验：`apiVersion` 为 `1`；`id` 与目录名一致（全小写连字符）；`version` 严格 SemVer 三段式（允许 `-beta.1` 这类预发布后缀）；`entry` 是裸文件名且文件存在（`.cjs` / `.js` / `.mjs`）
- 更新版：新版本号必须大于 `registry.json` 里当前版本，同名同版本不得重复收录

**2. 加载得了（产物自包含）**

- 目录内所有 `require` / `import` 只允许两类：相对路径（目标文件在目录内）、Node 内置模块。出现任何 npm 包名 → 在宿主里直接 `MODULE_NOT_FOUND`，阻塞
- 冒烟通过：临时目录里 require 入口、`register()` 不抛异常

**3. 弄不坏宿主（底线安全）**

- 产物不是混淆到不可读（正常 minify 可接受）
- 没有明显的恶意行为：凭据/用户数据偷偷外传、伪造其他插件事件等。看一眼外联域名清单即可判断，**不做完整安全审计**
- `unregister` 存在且调用不抛（插件能被停用）

**4. 拉得到（索引一致）**

- `registry.json` 条目与 manifest 对齐：`id` / `name` / `version` / `description` / `author`；新收录条目不带 `zip` / `sha256` / `downloads`（维护者发布时补）

### 快速检查命令

```bash
# 模块引用清单（自包含检查：只允许相对路径和 Node 内置模块）
grep -rnoE "require\(['\"][^'\"]+['\"]\)|from ['\"][^'\"]+['\"]" plugins/<插件id> | sort -u

# 动态执行速览（命中后人工看一眼，正常用途可放行）
grep -rnE "eval\(|new Function|node:vm" plugins/<插件id>

# 外联域名清单（判断有没有把数据发去奇怪的地方）
grep -rnoE "https?://[a-zA-Z0-9.-]+" plugins/<插件id> | sort -u

# manifest 权威校验（在临时目录装 SDK）
T=$(mktemp -d) && cd "$T" && npm init -y >/dev/null && npm install @playa0v0/cyrene-plugin-sdk >/dev/null && \
node -e "const {validateManifest}=require('@playa0v0/cyrene-plugin-sdk');console.log(validateManifest(require(process.argv[1])))" \
  /e/Cyrene-Plugins/plugins/<插件id>/manifest.json

# 冒烟（待审代码不可信，只在临时目录跑，别碰真实 Cyrene 数据目录）
T=$(mktemp -d) && cp -r plugins/<插件id> "$T/plugin" && \
node -e "const p=require(process.argv[1]+'/index.cjs');console.log(typeof p.register, typeof p.unregister)" "$T/plugin"
```

### P1 待补项（不阻塞，先合后补）

P0 全过就建议合并，下面这些整理成清单留言给作者，等他后续提交补修 PR：

- README 不完整：功能、启用方式、配置项、网络/存储行为没说清，已知限制未披露
- `marketplace/<插件id>.json` 缺失或格式小问题（数组超 20 项/每项超 500 字符、`documentationUrl` 非 HTTPS、重复了 registry 基础信息）
- 声明了用不到的 `deps`（最小权限）
- 工具 `risk` 声明与实际行为有出入；错误处理吞异常；`unregister` 重复调用、定时器/子进程清理这类健壮性问题
- README 表格行或简介与 manifest 不一致；icon 超 2MiB；资源文件没说明用途
- PR 描述没写清网络访问、文件读写、子进程用途的，留言要求补充说明

### 结论与回帖

- **建议合并（P1 待补）**：P0 全过。P1 项整理成待补清单贴在 PR 里，作者后续补修
- **需修改后再合**：P0 有不过。逐条留言（带 `文件:行号`），作者改完后只复审失败项
- **退回**：混淆不可读或明显恶意，没有商量余地

回帖模板（`gh pr comment <PR号> --body-file 审核记录.txt`；本仓库交流用中文）：

```text
审核人：
日期：
插件：<id>@<version>
P0 阻塞项：全部通过 / 未通过（逐条列出）
P1 待补清单：（逐条，带 文件:行号，供作者合并后补修）
结论：建议合并（P1 待补）/ 需修改后再合 / 退回
```

你的审核结论是给维护者的把关建议；**合并由维护者执行**，你不要自行 merge，也不要往提交者分支推提交。

## 二、发布流程（维护者确认合并后执行）

前提：PR 已合并进 `main`。ZIP 一律从审核过的 `plugins/<插件id>/` 打包，**绝不采用提交者上传的包**。

### 1. 打包

在仓库根目录把插件目录整体压成 ZIP，**必须保留一层插件目录**（宿主导入逻辑依赖这个层级）：

```bash
powershell -NoProfile -Command "Compress-Archive -Path plugins/<插件id> -DestinationPath 'zips/<插件id>-<版本>.zip' -Force"
```

文件名严格为 `<插件id>-<版本>.zip`（Gitee 直链与白名单都由它推导）。解包核对内容与 `plugins/<插件id>/` 完全一致。

### 2. 放行 ZIP 入库

`.gitignore` 末尾的 `zips/*` 白名单里加一行 `!zips/<插件id>-<版本>.zip`；**同时删掉该插件上一版的白名单行**，避免历史包继续占用仓库体积。

### 3. 回写索引与直链

- `registry.json` 该条目：`version` 改为新版，补 `zip` 与 `sha256`，`downloads` 置 `0`；顶层 `updatedAt` 改为当天。**`downloads` 字段绝不能缺失**——缺失的条目会被市场客户端整条丢弃（它目前只是占位字段，别当真实下载量）
- README 表格该行：更新版本与简介，「直接下载」列填 ZIP 链接

`zip` 与 README 直链统一用 **Gitee raw 直链**：

```text
https://gitee.com/playa0/cyrene-plugins/raw/main/zips/<插件id>-<版本>.zip
```

`sha256` 全小写：

```bash
sha256sum "zips/<插件id>-<版本>.zip"
```

### 4. 提交并推送

```bash
git add "zips/<插件id>-<版本>.zip" registry.json README.md .gitignore
git commit -m "发布 <插件id> <版本>：补 registry 下载地址与 README 直链"
git push origin HEAD:main
```

### 5. 同步 Gitee 并校验

Gitee 镜像每天北京时间 04:00 才自动同步，刚推完直链会 404。要立刻生效就手动触发：

```bash
gh workflow run aggregate-downloads.yml --repo Playa-Cyrene/Cyrene-Plugins
```

同步完成后从 Gitee 拉回 ZIP 校验，哈希一致才算发布完成：

```bash
curl -fsSL -o "$TMP/verify.zip" "https://gitee.com/playa0/cyrene-plugins/raw/main/zips/<插件id>-<版本>.zip" && sha256sum "$TMP/verify.zip"
```

## 三、红线（任何情况下都不要做）

- 不执行 `scripts/publish-plugins.ps1`（已废弃的 GitHub Release 方案，会写错 `zip` 地址）
- 不采用、不分发提交者上传的 ZIP；ZIP 只从合并后的 `plugins/` 源码打包
- 直链只用 Gitee raw，不用 GitHub raw、不用 Release 附件
- 不删 `registry.json` 条目的 `downloads` 字段；不拿它当真实数据引用
- 不 force push、不改写历史；Gitee 与 GitHub 历史分叉时（同步 workflow 会失败）报告维护者人工处理，不要自行强推
- 不在真实 Cyrene 数据目录里运行待审插件代码；冒烟只在临时目录
- 不自行 merge PR、不自行向 `main` 推送发布提交（除非维护者明示让你执行发布）
