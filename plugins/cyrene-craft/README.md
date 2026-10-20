# Cyrene Craft

把昔涟接入 Minecraft —— 一个 Cyrene 原生插件。

让昔涟有一个自己的游戏角色，能连进服务器、走动、挖矿、建造、合成、打怪，也能在游戏聊天里和玩家说话。

移植自 DSH 插件 [whale-craft](https://github.com/yzi1b/whale-craft)，按 Cyrene 插件 API 重写。

---

## 快速开始

1. 把 `cyrene-craft` 目录复制到 `%APPDATA%\Cyrene\plugins\cyrene-craft\`
   （或导入 `cyrene-craft-1.0.0.zip`）
2. 在聊天窗口的「插件」面板启用它
3. 对昔涟说：**「连到 localhost:25565 去玩」**
4. 或者点插件卡片上的「打开」，在设置窗口里填地址点连接

连上之后她就在游戏里了。你可以直接对她说「去砍十块木头」「在那里盖个房子」，也可以进游戏打 `昔涟` 叫她。

---

## 依赖

| 项 | 要求 |
|---|---|
| Cyrene | 支持插件 API v1 的版本 |
| Node | ≥ 22（Cyrene 自带 Electron，不需要单独装） |
| mineflayer | 4.39.0 或相近版本 |

**关于 mineflayer 从哪来**——插件**不自带**运行时，因为完整依赖树有 98.4 MB / 1808 个文件，超过 Cyrene 插件 zip 的 50 MiB 上限。所以按这个顺序找：

1. `plugin-data/cyrene-craft/runtime/bot-runtime/node_modules`（本插件自己装的）
2. `plugins/minecraft-bot/runtime/bot-runtime/node_modules`（复用 minecraft-bot 插件的）
3. 都没有 → 第一次连接时自动用 `npm install` 装到第 1 个位置（需要联网，可能要几分钟）

只要装了 `minecraft-bot` 插件，第 2 条就能命中，不用等下载。

---

## 33 个工具

### 连接与状态

| 工具 | 做什么 |
|---|---|
| `cyrene-craft_connect` | 进服务器（address / username / version） |
| `cyrene-craft_disconnect` | 离开服务器 |
| `cyrene-craft_status` | 坐标、血量、饥饿、背包、在线玩家、最近聊天 |
| `cyrene-craft_ping` | 只探不进：版本、MOTD、人数、延迟 |
| `cyrene-craft_lan` | 听局域网广播，找开了「对局域网开放」的服务器 |
| `cyrene-craft_sessions` | 实例信息（如实说明是全局单实例） |
| `cyrene-craft_capabilities` | 能力自检 |

### 观察世界

| 工具 | 做什么 |
|---|---|
| `cyrene-craft_context` | 身边环境：脚下方块、光照、手持、维度、时间 |
| `cyrene-craft_players` | 在线玩家列表 |
| `cyrene-craft_entities` | 附近生物 / 玩家 / 掉落物 |
| `cyrene-craft_scan` | 搜附近指定方块（找树、找矿、找工作台） |
| `cyrene-craft_map` | 俯视字符地图 |
| `cyrene-craft_height` | 高度矩阵，看山看谷 |
| `cyrene-craft_inventory` | 背包 |
| `cyrene-craft_events` | 取走最近发生的游戏事件 |
| `cyrene-craft_rules` | 读记忆树里的 RULES.md |

### 行动

| 工具 | 做什么 |
|---|---|
| `cyrene-craft_move` | 走到坐标或玩家（自动寻路） |
| `cyrene-craft_act` | eat / equip / sleep / wake / use / drop / jump / sneak |
| `cyrene-craft_dig` | 挖一个方块 |
| `cyrene-craft_build` | 盖 box / wall / floor / pillar |
| `cyrene-craft_give` | 走到玩家身边给东西 |
| `cyrene-craft_sequence` | 连续执行一串动作 |
| `cyrene-craft_stop` | 立刻停下当前动作 |
| `cyrene-craft_say` | 在游戏聊天栏说话 |
| `cyrene-craft_command` | 执行服务器指令（有白名单） |

### 记忆与文件

| 工具 | 做什么 |
|---|---|
| `cyrene-craft_fs` | 记忆树读写（list / read / write / append / remove） |
| `cyrene-craft_image` | 把地形画成 PNG 存到 share 目录 |
| `cyrene-craft_express` | 文件分享服务（start / stop / status） |
| `cyrene-craft_accounts` | 游戏账户管理（永远拿不到密码） |
| `cyrene-craft_config` | 插件设置 |
| `cyrene-craft_watch` | 唤醒规则 |
| `cyrene-craft_admin` | 数据目录、文件位置 |
| `cyrene-craft_diag` | 运行时深度诊断 |

---

## 人格接入

### 游戏聊天 → 昔涟

插件注册了一个渠道适配器 `minecraft-cyrene`。玩家在游戏里说话，会变成一条正常的对话消息交给昔涟，她用自己的人设和语气回话，回复按行拆开发进游戏。

**默认只响应点名**：消息里含「昔涟 / Cyrene / 小昔 / 希琳」或以 `@` 开头才会触发。因为每触发一次就是一轮完整的 LLM 调用，不限流会被玩家闲聊刷爆。

想让她回应所有聊天，去设置窗口打开「响应所有游戏聊天」。

### 唤醒（看门狗）

whale-craft 的看门狗靠 DSH 的 job 结算 + followup，Cyrene 没有这个 API。这里的做法是：渠道适配器自己构造一条入站消息交给宿主的调度器，宿主就会正常跑一轮 Agent——昔涟也就被叫醒了。

可以触发唤醒的事件：被点名、被攻击、血量过低、死亡、掉线。

**默认关闭**，因为它是真的有成本。打开后还有两道闸：全局冷却（默认 90 秒）+ 同类事件独立冷却。

### 实时状态注入

每轮对话自动带上一小段当前游戏状态：坐标、血量、背包、在线玩家、最近聊天。这样你不用问「你在哪」，她自己就知道。

只写事实，不写指令。没连服务器时返回空字符串，不占上下文。

---

## 记忆

在 `<会话工作区>/.cyrene-craft/` 下维护一棵文档树：

| 文件 | 作用 |
|---|---|
| `README.md` | 总索引 |
| `RULES.md` | 行事准则 |
| `share/` | 可以对外分享的文件（文件分享只托管这里） |
| 其它 | 想记什么都行 |

路径全部限制在根目录内，`..` 和符号链接逃逸都会被拒。

---

## 落盘位置

| 内容 | 位置 |
|---|---|
| 插件私有数据 | `%APPDATA%\Cyrene\plugin-data\cyrene-craft\` |
| 账户元数据 | `…\cyrene-craft\accounts.json`（**不含密码**） |
| 自动安装的运行时 | `…\cyrene-craft\runtime\bot-runtime\node_modules\` |
| 记忆树 | `<工作区>\.cyrene-craft\` |
| 设置 | 宿主 storage（键 `settings`） |

---

## 已知限制

**全局单实例。** Cyrene 插件的工具 `execute(args)` 拿不到会话上下文（没有 DSH 的 `exec.agent`），所以做不到「每个对话一个独立游戏角色」。所有对话共用同一个机器人。想换角色或换服务器：先 disconnect，再 connect 时给新的 address / username。

**不支持微软正版登录。** 目前只有离线模式（服务器需要 `online-mode=false`）。

**能连的 MC 版本取决于 mineflayer。** 4.39.0 大致支持到 1.21.x。服务器版本太新或太旧会连不上，`cyrene-craft_diag` 会给出具体原因。

**唤醒依赖宿主的渠道调度器。** 如果宿主没有接管渠道的 `onMessage`，唤醒不会生效——`cyrene-craft_capabilities` 会显示「未接线」。这时状态注入仍然工作，昔涟在下一轮对话里仍能看到游戏里发生了什么。

**文件分享只监听 127.0.0.1。** 远程访问需要自己转发端口。

**长时间任务有硬超时。** 采集 10 分钟、建造 10 分钟、移动 120 秒。超时会返回「已中断」而不是挂死。

---

## 开发与自检

```bash
node tools/smoke.cjs   # 契约冒烟：manifest / 33 个工具 / schema / unregister 幂等
node tools/e2e.cjs     # 链路联调：真起子进程，验行协议与错误路径
```

两个都跑通再打包：

```powershell
Compress-Archive -Path cyrene-craft\* -DestinationPath cyrene-craft-1.0.0.zip
```

---

## 致谢

架构与工具设计参考 [whale-craft](https://github.com/yzi1b/whale-craft)（MIT）。机器人部分基于 [mineflayer](https://github.com/PrismarineJS/mineflayer)。
