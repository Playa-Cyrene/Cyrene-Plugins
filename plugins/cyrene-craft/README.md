# Cyrene Craft

把昔涟接入 Minecraft —— 一个 Cyrene 原生插件。

让昔涟有一个自己的游戏角色，能连进服务器、走动、挖矿、建造、合成、打怪，也能在游戏聊天里和玩家说话。

她能自己看地形、算下一步、把做过的动作沉淀成技能；没人说话的时候，也会继续在游戏里活动。

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

## 35 个工具

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

### 自主与学习

| 工具 | 做什么 |
|---|---|
| `cyrene-craft_instincts` | 本能反射：低血逃跑、饥饿进食、捡掉落、插火把、头顶悬沙闪避、溺水上游、窒息挖开；传参可调开关与阈值 |
| `cyrene-craft_skill` | 技能层：名单 / 编译 / 执行 / 统计 / 归因 / 自检 / 经验（`selfcheck`、`lessons`） |

---

## 人格接入

### 游戏聊天 → 昔涟

插件注册了一个渠道适配器 `minecraft-cyrene`。玩家在游戏里说话，会变成一条正常的对话消息交给昔涟，她用自己的人设和语气回话，回复按行拆开发进游戏。

**默认只响应点名**：消息里含「昔涟 / Cyrene / 小昔 / 希琳」或以 `@` 开头才会触发。因为每触发一次就是一轮完整的 LLM 调用，不限流会被玩家闲聊刷爆。

想让她回应所有聊天，去设置窗口打开「响应所有游戏聊天」。

### 唤醒（看门狗）

看门狗不依赖宿主的定时任务接口：渠道适配器自己构造一条入站消息交给宿主的调度器，宿主就会正常跑一轮 Agent——昔涟也就被叫醒了。

可以触发唤醒的事件：被点名、被攻击、血量过低、死亡、掉线。

**默认关闭**，因为它是真的有成本。打开后还有两道闸：全局冷却（默认 90 秒）+ 同类事件独立冷却。

### 实时状态注入

每轮对话自动带上一小段当前游戏状态：坐标、血量、背包、在线玩家、最近聊天。这样你不用问「你在哪」，她自己就知道。

只写事实，不写指令。没连服务器时返回空字符串，不占上下文。

---

## 类脑决策

### 三层分工

| 层 | 触发时机 | 回答的问题 | 耗时 |
|---|---|---|---|
| 本能反射 | 每 tick 都跑 | 现在有危险吗 | 毫秒级 |
| 肌肉记忆 | 局面重复出现 | 这个局面上次怎么做的 | 一次查表 |
| 类脑决策 | 没有现成记忆 | 下一步做什么最划算 | 建图 + 能量扩散 |

三层都算不出结果时，才回落给大模型。

### 动作图

节点是可解释的动作单元。一个工具调用压成一个节点 id，只有身份参数参与判定：

```text
collect { block: "oak_log", count: 8 }  →  collect:oak_log
dig     { x: 10, y: 64, z: 3 }          →  dig
move    { player: "Mori" }              →  move:player=Mori
```

`count` / `radius` / `maxDistance` / 坐标 / 超时这些易变参数不参与节点身份。否则 `chop_oak(count=8)` 和 `chop_oak(count=16)` 会变成两个互不相连的节点，边永远连不起来。

边记录两个动作的相邻共现，累积 `count`、`success`、`totalMs`、`totalGain`、`lastAt`、`autoplay` 六项统计。

### 边权

```text
weight = log1p(count) × successRate × 0.5^(age / 7天) × (1 - 0.5 × autoplayShare)
```

- `log1p` 压住高频边，避免图退化成「永远推荐最常做的那件事」
- 时间半衰期 7 天，旧轨迹自然退场
- 自主驱动跑出来的边最多打五折，防止自我强化

共现不足 2 次的边权重为 0，只留痕，不参与排序。

### 能量扩散

```text
E(next) += E(cur) × weight(cur→next) × 0.55^hop
```

从当前节点出发，最多扩散 3 跳。已访问过的节点再次进入时打折，挡住 `A→B→A→B` 这类环。单节点能量封顶 `1e6`。

### 门禁

前置条件不满足的候选，能量直接归零：

- 挖矿类要先有对应工具
- 吃饭要先有食物
- 目标方块附近找不到
- 动作在拒绝清单里

门禁是硬判断，能量只负责排序。事实优先于概率。

### 排序

```text
score = energy × rateFactor × efficiencyFactor × exploreFactor
```

| 因子 | 含义 |
|---|---|
| `rateFactor` | 节点成功率，做不成的不推荐 |
| `efficiencyFactor` | `1 + min(0.5, gainPerSec / 4)`，同样成功，单位时间收益高的加分 |
| `exploreFactor` | 样本少于 3 次时乘 1.05，给新动作一点出头机会 |

输出前 4 个候选，附带成功率、平均耗时、平均收益、来源节点。这一层只给建议，执行由调用方决定。

### 执行环

`brain-loop` 把建议变成动作：

1. 取世界状态（背包、血量、附近方块、当前节点）
2. 调 `nextAction` 拿候选
3. 清洗参数：剥掉绝对坐标，限制半径与批量
4. 执行，记录耗时与结果
5. 判成败：`ok:false` 算失败，`ok:true` 但 `complete:false` 也算失败

停止条件：步数上限、连续失败、分数不再上涨、连接断开、外部停止信号。每步只做一个动作，做完让出事件循环，本能层、聊天、模型都有机会插进来。

---

## 自训练系统

### 闭环

```text
真实动作
  → 轨迹（L0）
  → episode 切分
  → 技能编译（L1）
  → 技能库
  → 执行统计
  → 归因（L2）
  → 沉淀（L3）
```

另一条支线从轨迹直接抽教训：失败 → 纠正 → 成功。

### L0 轨迹

每次工具调用写一行 `traces/current.jsonl`：

```json
{"ts":1792480662645,"tool":"collect","args":{"block":"stone","count":1,"tool":"wooden_pickaxe"},"ok":true,"ms":3200,"origin":"llm"}
```

`origin` 分五档：

| origin | 来源 | 是否进图 |
|---|---|---|
| `llm` | 模型发起的动作 | 是 |
| `autopilot` | 执行环自己跑的 | 只记失败 |
| `autoplay` | 自主驱动跑出来的 | 是，边权打折 |
| `skill` | 技能自己跑的 | 否，避免自我强化 |
| `reflex` | 本能反射触发的 | 是 |

相邻两条记录间隔超过 15 秒就切成新的 episode。

### L1 技能编译

从一段成功轨迹里提炼可复用流程：

- 只保留能改变世界的动作，查询类命令全部过滤
- 连续重复的同参数动作合并成循环，次数抽成 `count`
- 只出现一次的坐标、距离参数剥离或相对化
- 编不出至少一步就返回 `null`，不硬造

起名按主对象：`chop_oak`、`chop_stone`、`build_oak_planks`。

### 教训编译

失败样本单独走一条路：

1. 找到 `ok:false` 的动作
2. 往后找同一主体的成功动作（同工具、同目标）
3. 中间必须存在修复证据：`equip` / `craft` / `place`，或成功调用自带 `tool` 参数
4. 编成「先修复、再执行」的两步技能

例：空手 `collect stone` 失败 → `equip wooden_pickaxe` → `collect stone tool=wooden_pickaxe` 成功，得到 `mine_stone_with_wooden_pickaxe`。

没有修复证据就不编。宁可少一条经验，也不把巧合当规律。

### 肌肉记忆

同一局面反复出现时，不再重新建图：

- 指纹取粗粒度特征：维度、昼夜、血量档、饥饿档、背包物资结构、附近可采集种类、当前节点
- 坐标不进指纹，否则缓存活不过三秒
- 跑满 3 次、成功率 85% 以上才开始直出
- 有效期 10 分钟，连续失败 2 次立刻删除
- 同一动作最短间隔 3 秒，挡住每 tick 连发

写盘到 `muscle.json`，500ms 防抖，上限 500 条，超出按 LRU 淘汰。

### L2 归因

对每个技能算健康度：

| 指标 | 门槛 |
|---|---|
| 成功率 | 至少 3 次样本 |
| 耗时趋势 | 至少 4 次样本，最近比早期慢 50% 算退化 |
| 长尾 | 至少 5 次样本，单次超过中位数 3 倍算异常慢 |

对失败做归因：环境没满足、参数不合适、步骤本身有问题。输出可执行提案（收紧半径、缩小批量、加前置检查、降级为手写流程），每条带 `kind` / `target` / `change`。只出建议，不自动改。

### L3 沉淀

满足 20 次运行、成功率 95% 以上，技能标记为可沉淀。沉淀后由本能层在合适条件下自动触发，不再需要每次显式调用。

### 自检

`cyrene-craft_skill` 的 `selfcheck` 把上面几层串一次：

- 背包对账：已经拿到的东西，目标节点直接完成
- 清失效拉黑：手里有工具了，之前「空手挖不动」的封禁解除
- 经验沉淀：从最近轨迹里抽一条教训，落进技能库

`apply=true` 才写盘，默认 dry-run。`lessons` 用来查看最近沉淀的经验与对账补完成的目标。

### 目标层

目标图是一份有向依赖图，每个节点带 `kind`（collect / craft / manual）、`recipe` 和前置节点。执行时按依赖顺序取下一个可做节点，采集与合成自动展开成动作。背包对账会把已经满足的节点直接结算，不让进度卡在旧状态上。

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

**全局单实例。** Cyrene 插件的工具 `execute(args)` 拿不到会话上下文，所以做不到「每个对话一个独立游戏角色」。所有对话共用同一个机器人。想换角色或换服务器：先 disconnect，再 connect 时给新的 address / username。

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

机器人部分基于 [mineflayer](https://github.com/PrismarineJS/mineflayer)（MIT）。
