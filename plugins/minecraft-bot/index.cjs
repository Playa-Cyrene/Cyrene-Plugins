"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const bot_bridge_1 = require("./bot-bridge");
const channel_1 = require("./channel");
const path = __importStar(require("node:path"));
const goal_runner_1 = require("./goal-runner");
/** 把状态快照整理成给用户/模型看的多行文本。 */
function formatStatus(s) {
    const lines = [];
    const stateText = {
        disconnected: "未连接",
        connecting: "连接中",
        connected: "已连接",
    };
    lines.push(`连接状态: ${stateText[s.state] ?? s.state}`);
    if (s.host)
        lines.push(`服务器: ${s.host}:${s.port}`);
    if (s.username)
        lines.push(`游戏角色: ${s.username}`);
    if (s.state === "connected") {
        const pos = s.position ? s.position.map((n) => n.toFixed(1)).join(", ") : "未知";
        lines.push(`坐标: (${pos})`);
        if (s.health !== undefined)
            lines.push(`生命值: ${s.health}/20，饥饿值: ${s.food}/20`);
        if (s.inventory.length > 0) {
            lines.push(`背包: ${s.inventory.map((it) => `${it.name} x${it.count}`).join("、")}`);
        }
        else {
            lines.push("背包: 空");
        }
        if (s.currentTask)
            lines.push(`正在做: ${s.currentTask}`);
        if (s.recentChat.length > 0) {
            lines.push("最近游戏聊天:");
            for (const c of s.recentChat.slice(-5))
                lines.push(`  ${c.player}: ${c.message}`);
        }
    }
    if (s.lastError)
        lines.push(`最近错误: ${s.lastError}`);
    if (s.restartCount > 0)
        lines.push(`意外重连次数: ${s.restartCount}`);
    return lines.join("\n");
}
/** 配置窗口实例；open() 创建，unregister() 关闭。 */
let configWin = null;
const plugin = {
    async register(ctx) {
        const bridge = new bot_bridge_1.BotBridge((msg) => ctx.log(msg));
        // LLM 服务在 manifest 的 deps 里声明后由宿主注入；缺服务时自主任务不可用
        const llm = ctx.deps.llm;
        const goalRunner = llm ? new goal_runner_1.GoalRunner(bridge, llm, ctx.storage, (msg) => ctx.log(msg)) : null;
        const interruptedGoalNotice = goalRunner?.takeInterruptedNotice();
        if (interruptedGoalNotice)
            ctx.log(interruptedGoalNotice);
        if (!llm)
            ctx.log("宿主未提供 LLM 服务，自主任务功能不可用（遥控指令不受影响）");
        const requireConnected = () => {
            if (bridge.status().state !== "connected") {
                throw new Error("尚未连接 Minecraft 服务器，请先调用进入服务器的工具");
            }
        };
        // ---- 胆小模式偏好：storage 持久化，连接后自动下发到机器人反射层 ----
        /** 胆小偏好的存储键。 */
        const COWARDICE_KEY = "cowardiceEnabled";
        /** 当前胆小偏好（启动时从 storage 恢复，供提示词 Provider 同步读取）。 */
        let cowardiceEnabled = ctx.storage.get(COWARDICE_KEY) ?? false;
        /** 统一入口：保存偏好 + 已连接时立即下发；返回给模型看的确认文案。 */
        const setCowardicePreference = async (enabled) => {
            cowardiceEnabled = enabled;
            ctx.storage.set(COWARDICE_KEY, enabled);
            const result = enabled
                ? "胆小模式已开启：见怪就逃，不再反击"
                : "胆小模式已关闭：被攻击会反击";
            if (bridge.status().state === "connected") {
                try {
                    return await bridge.setCowardice(enabled);
                }
                catch (err) {
                    return `${result}（偏好已保存，但下发机器人失败：${err instanceof Error ? err.message : String(err)}）`;
                }
            }
            return `${result}（当前未连接服务器，下次进入后生效）`;
        };
        // 连接成功后把已保存的胆心偏好下发（默认关闭不用发）
        const applyCowardiceAfterConnect = async () => {
            if (!cowardiceEnabled)
                return;
            try {
                await bridge.setCowardice(true);
            }
            catch { /* 下发失败不影响连接结果，可用工具重新设置 */ }
        };
        const tools = [
            {
                id: "minecraft-bot_connect",
                enabled: true,
                name: "进入 Minecraft 服务器",
                description: "把你的游戏身体连进 Minecraft 服务器（Java 版，离线模式），连上后你就是游戏里的一个角色。host 支持带端口的写法，port 缺省 25565。",
                risk: "network",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        host: { type: "string", description: "服务器地址，如 localhost 或 192.168.1.100" },
                        port: { type: "number", description: "服务器端口，默认 25565" },
                        username: { type: "string", description: "你在游戏里的角色名，默认 Cyrene" },
                    },
                    required: ["host"],
                },
                async execute(args) {
                    const host = String(args.host ?? "localhost").trim();
                    const port = Number(args.port) || 25565;
                    const username = String(args.username ?? "Cyrene").trim() || "Cyrene";
                    if (username.length > 16)
                        throw new Error("游戏角色名不能超过 16 个字符");
                    const s = await bridge.connect({ host, port, username });
                    // 已保存的胆小偏好在每次连接后自动下发
                    await applyCowardiceAfterConnect();
                    return `你已进入服务器 ${host}:${port}，游戏角色名 ${username}。\n${formatStatus(s)}`;
                },
            },
            {
                id: "minecraft-bot_disconnect",
                enabled: true,
                name: "离开 Minecraft 服务器",
                description: "让你的游戏身体退出服务器。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: { type: "object", properties: {} },
                async execute() {
                    goalRunner?.cancel("离开服务器");
                    const s = await bridge.disconnect();
                    return `你已离开服务器。\n${formatStatus(s)}`;
                },
            },
            {
                id: "minecraft-bot_status",
                enabled: true,
                name: "查看我的游戏状态",
                description: "查看你游戏身体的连接状态、坐标、生命值、背包物品、正在做的事和最近游戏聊天。",
                risk: "safe",
                effectKind: "read",
                inputSchema: { type: "object", properties: {} },
                async execute() {
                    const s = formatStatus(bridge.status());
                    const goal = goalRunner
                        ? goalRunner.state.running
                            ? `\n自主任务: 正在执行「${goalRunner.state.goal}」（第 ${goalRunner.state.round} 轮）`
                            : goalRunner.state.lastSummary
                                ? `\n自主任务: 上次结果 —— ${goalRunner.state.lastSummary}`
                                : ""
                        : "";
                    return `${s}${goal}`;
                },
            },
            {
                id: "minecraft-bot_say",
                enabled: true,
                name: "在游戏里说话",
                description: "用你的游戏身体在聊天栏说一句话。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: { message: { type: "string", description: "要在游戏里说的内容" } },
                    required: ["message"],
                },
                async execute(args) {
                    requireConnected();
                    const message = String(args.message ?? "").trim();
                    if (!message)
                        throw new Error("消息内容不能为空");
                    if (message.length > 256)
                        throw new Error("游戏聊天单条最长 256 字符");
                    bridge.say(message);
                    return `你已在游戏里说: ${message}`;
                },
            },
            {
                id: "minecraft-bot_goto",
                enabled: true,
                name: "在游戏里移动",
                description: "你的身体走到指定玩家身边或指定坐标（自动寻路，绕障碍、爬楼梯、过水）。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        player: { type: "string", description: "目标玩家名（与坐标二选一）" },
                        x: { type: "number", description: "目标 x 坐标" },
                        y: { type: "number", description: "目标 y 坐标" },
                        z: { type: "number", description: "目标 z 坐标" },
                    },
                },
                async execute(args) {
                    requireConnected();
                    if (args.player) {
                        bridge.moveTo({ player: String(args.player) });
                        return `你正在走向玩家 ${args.player}`;
                    }
                    const [x, y, z] = [Number(args.x), Number(args.y), Number(args.z)];
                    if (![x, y, z].every(Number.isFinite))
                        throw new Error("需要提供 player 或完整坐标 x/y/z");
                    bridge.moveTo({ x, y, z });
                    return `你正在走向坐标 (${x}, ${y}, ${z})`;
                },
            },
            {
                id: "minecraft-bot_follow",
                enabled: true,
                name: "在游戏里跟随玩家",
                description: "你的身体持续跟随指定玩家（保持约 3 格距离），直到被叫停。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: { player: { type: "string", description: "要跟随的玩家名" } },
                    required: ["player"],
                },
                async execute(args) {
                    requireConnected();
                    const player = String(args.player ?? "").trim();
                    if (!player)
                        throw new Error("玩家名不能为空");
                    bridge.follow(player);
                    return `你正在跟随玩家 ${player}`;
                },
            },
            {
                id: "minecraft-bot_stop",
                enabled: true,
                name: "停下游戏动作",
                description: "停下你身体当前的动作（移动、跟随）并取消自主任务。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: { type: "object", properties: {} },
                async execute() {
                    requireConnected();
                    if (goalRunner?.state.running) {
                        goalRunner.cancel("玩家叫停");
                        return "你已停下并取消了自主任务";
                    }
                    bridge.stopTask();
                    return "你已停下";
                },
            },
            // ---- 生活技能 ----
            {
                id: "minecraft-bot_eat",
                enabled: true,
                name: "吃点东西",
                description: "吃掉背包里的食物恢复饥饿值。不指定物品时自动挑第一个能吃的。玩家说「吃点东西」「你饿了吧」时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        item: { type: "string", description: "要吃的食物 id（可选，不填自动挑）" },
                    },
                },
                async execute(args) {
                    requireConnected();
                    return await bridge.eat(args.item ? String(args.item) : undefined);
                },
            },
            {
                id: "minecraft-bot_equip",
                enabled: true,
                name: "拿起物品",
                description: "把背包里的物品拿在手上（工具、武器、食物等）。玩家说「把剑拿出来」时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        item: { type: "string", description: "物品 id，如 iron_sword、iron_pickaxe" },
                    },
                    required: ["item"],
                },
                async execute(args) {
                    requireConnected();
                    return await bridge.equip(String(args.item ?? ""));
                },
            },
            {
                id: "minecraft-bot_give",
                enabled: true,
                name: "把物品递给玩家",
                description: "走到玩家身边把背包里的物品丢给对方。玩家说「给我 5 个木头」「把石头给我」时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        player: { type: "string", description: "玩家名" },
                        item: { type: "string", description: "物品 id" },
                        count: { type: "number", description: "数量（默认 1）" },
                    },
                    required: ["player", "item"],
                },
                async execute(args) {
                    requireConnected();
                    const count = Math.min(Math.max(Number(args.count) || 1, 1), 64);
                    return await bridge.give(String(args.player ?? ""), String(args.item ?? ""), count);
                },
            },
            {
                id: "minecraft-bot_sleep",
                enabled: true,
                name: "去睡觉",
                description: "找最近的床走过去躺下睡觉（夜晚才能入睡）。玩家说「天黑了去睡觉吧」时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: { type: "object", properties: {} },
                async execute() {
                    requireConnected();
                    return await bridge.sleep();
                },
            },
            {
                id: "minecraft-bot_craft",
                enabled: true,
                name: "合成物品",
                description: "用背包材料合成物品（2x2 配方直接合，3x3 配方需要附近 4 格内有合成台）。玩家说「把木头做成木板」「做一把木镐」时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        item: { type: "string", description: "产物 id，如 oak_planks、wooden_pickaxe" },
                        count: { type: "number", description: "数量（默认 1）" },
                    },
                    required: ["item"],
                },
                async execute(args) {
                    requireConnected();
                    const count = Math.min(Math.max(Number(args.count) || 1, 1), 64);
                    return await bridge.craft(String(args.item ?? ""), count);
                },
            },
            {
                id: "minecraft-bot_smelt",
                enabled: true,
                name: "熔炼物品",
                description: "把物品放进附近 4 格内的熔炉烧（需要燃料：煤/木炭/木板/原木）。玩家说「把生肉烤了」「把这些铁矿烧成铁锭」时用。逐件烧比较慢，会等完成再返回。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        item: { type: "string", description: "原料 id，如 raw_iron、raw_beef" },
                        count: { type: "number", description: "数量（默认 1）" },
                    },
                    required: ["item"],
                },
                async execute(args) {
                    requireConnected();
                    const count = Math.min(Math.max(Number(args.count) || 1, 1), 64);
                    return await bridge.smelt(String(args.item ?? ""), count);
                },
            },
            // ---- 建造 ----
            {
                id: "minecraft-bot_place",
                enabled: true,
                name: "放置方块",
                description: "在指定坐标放一个方块（需要背包里有该方块）。玩家说「在这里放个木板」时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        x: { type: "number", description: "x 坐标" },
                        y: { type: "number", description: "y 坐标" },
                        z: { type: "number", description: "z 坐标" },
                        block: { type: "string", description: "方块 id，如 oak_planks" },
                    },
                    required: ["x", "y", "z", "block"],
                },
                async execute(args) {
                    requireConnected();
                    return await bridge.place(Number(args.x), Number(args.y), Number(args.z), String(args.block ?? ""));
                },
            },
            {
                id: "minecraft-bot_break",
                enabled: true,
                name: "挖掉方块",
                description: "挖掉指定坐标的方块。玩家说「把这块挖了」时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        x: { type: "number", description: "x 坐标" },
                        y: { type: "number", description: "y 坐标" },
                        z: { type: "number", description: "z 坐标" },
                    },
                    required: ["x", "y", "z"],
                },
                async execute(args) {
                    requireConnected();
                    return await bridge.breakBlock(Number(args.x), Number(args.y), Number(args.z));
                },
            },
            {
                id: "minecraft-bot_build_shelter",
                enabled: true,
                name: "建一个小屋",
                description: "自动建一座 5x5 木板小屋（地板、墙、屋顶、门、火把）。需要背包里有约 95 个木板、1 个门、1 个火把；不够她会告知缺口。玩家说「盖个小房子」「建个家」时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        x: { type: "number", description: "小屋中心 x 坐标（可选，默认脚下）" },
                        z: { type: "number", description: "小屋中心 z 坐标（可选，默认脚下）" },
                    },
                },
                async execute(args) {
                    requireConnected();
                    return await bridge.buildShelter(args.x !== undefined ? Number(args.x) : undefined, args.z !== undefined ? Number(args.z) : undefined);
                },
            },
            // ---- 战斗 / 导航 ----
            {
                id: "minecraft-bot_attack",
                enabled: true,
                name: "攻击生物",
                description: "攻击并击杀附近的指定生物（24 格内），击杀后自动捡战利品。玩家说「把那只僵尸杀了」「去打猎弄点肉」时用。生物 id 用英文，如 zombie、skeleton、cow、pig、sheep。",
                risk: "input-control",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        mob: { type: "string", description: "生物 id，如 zombie" },
                        kill: { type: "boolean", description: "是否追杀到底（默认 true）" },
                    },
                    required: ["mob"],
                },
                async execute(args) {
                    requireConnected();
                    return await bridge.attack(String(args.mob ?? ""), args.kill !== false);
                },
            },
            {
                id: "minecraft-bot_pickup",
                enabled: true,
                name: "捡起掉落物",
                description: "主动走过去捡起周围的掉落物（默认 8 格范围）。玩家说「把地上的东西捡了」时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        range: { type: "number", description: "捡拾范围（格，默认 8）" },
                    },
                },
                async execute(args) {
                    requireConnected();
                    return await bridge.pickup(args.range !== undefined ? Number(args.range) : undefined);
                },
            },
            {
                id: "minecraft-bot_use_door",
                enabled: true,
                name: "开门",
                description: "使用最近的门：开门、穿过去、随手关上。进出房屋时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        x: { type: "number", description: "门的 x 坐标（可选，默认找最近的门）" },
                        y: { type: "number", description: "门的 y 坐标（可选）" },
                        z: { type: "number", description: "门的 z 坐标（可选）" },
                    },
                },
                async execute(args) {
                    requireConnected();
                    return await bridge.useDoor(args.x !== undefined ? Number(args.x) : undefined, args.y !== undefined ? Number(args.y) : undefined, args.z !== undefined ? Number(args.z) : undefined);
                },
            },
            {
                id: "minecraft-bot_goto_block",
                enabled: true,
                name: "寻找方块",
                description: "找到最近的指定方块并走过去（默认 64 格范围）。探索找东西时用，如「去最近的那个村庄井边」「找到铁矿石」。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        block: { type: "string", description: "方块 id，如 crafting_table" },
                        range: { type: "number", description: "搜索范围（格，默认 64）" },
                    },
                    required: ["block"],
                },
                async execute(args) {
                    requireConnected();
                    return await bridge.gotoBlock(String(args.block ?? ""), args.range !== undefined ? Number(args.range) : undefined);
                },
            },
            {
                id: "minecraft-bot_dig_down",
                enabled: true,
                name: "向下挖矿",
                description: "从脚下垂直向下挖指定格数（遇岩浆、水或大落差会自动停下防危险）。玩家说「往下挖 10 格」「下矿」时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        distance: { type: "number", description: "挖多少格（1-32）" },
                    },
                    required: ["distance"],
                },
                async execute(args) {
                    requireConnected();
                    return await bridge.digDown(Math.min(Math.max(Number(args.distance) || 1, 1), 32));
                },
            },
            {
                id: "minecraft-bot_go_surface",
                enabled: true,
                name: "回到地表",
                description: "回到当前位置正上方的地表。在矿洞里迷路时用，玩家说「上来」「回到地面」时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: { type: "object", properties: {} },
                async execute() {
                    requireConnected();
                    return await bridge.goSurface();
                },
            },
            {
                id: "minecraft-bot_stay",
                enabled: true,
                name: "原地等待",
                description: "原地等待一段时间（5-300 秒），期间不会乱跑，玩家叫你或到时自动解除。玩家说「在这等我一会儿」时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        seconds: { type: "number", description: "等多少秒（默认 30）" },
                    },
                },
                async execute(args) {
                    requireConnected();
                    return await bridge.stay(Math.min(Math.max(Number(args.seconds) || 30, 5), 300));
                },
            },
            {
                id: "minecraft-bot_discard",
                enabled: true,
                name: "丢掉物品",
                description: "把背包里的指定物品丢掉（数量省略 = 全丢）。玩家说「把圆石都扔了」清背包时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        item: { type: "string", description: "物品 id" },
                        count: { type: "number", description: "数量（默认全部）" },
                    },
                    required: ["item"],
                },
                async execute(args) {
                    requireConnected();
                    const n = Number(args.count);
                    return await bridge.discard(String(args.item ?? ""), Number.isFinite(n) ? n : undefined);
                },
            },
            // ---- 农活 / 工具交互 / 箱子 / 村民 ----
            {
                id: "minecraft-bot_till_sow",
                enabled: true,
                name: "耕地播种",
                description: "用锄头翻土并种下种子（需要背包有锄头；种子可省略只翻土）。玩家说「在这里种小麦」时用。y 是地面方块的坐标。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        x: { type: "number", description: "地面方块 x 坐标" },
                        y: { type: "number", description: "地面方块 y 坐标" },
                        z: { type: "number", description: "地面方块 z 坐标" },
                        seed: { type: "string", description: "种子 id（如 wheat_seeds，可省略）" },
                    },
                    required: ["x", "y", "z"],
                },
                async execute(args) {
                    requireConnected();
                    return await bridge.tillSow(Number(args.x), Number(args.y), Number(args.z), args.seed ? String(args.seed) : undefined);
                },
            },
            {
                id: "minecraft-bot_use_tool_on",
                enabled: true,
                name: "对目标使用工具",
                description: "拿起工具对最近的实体或方块使用（工具传 hand 表示空手）。精细操作时用，如「给那只羊剪毛」「用打火石点着它」。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        tool: { type: "string", description: "工具 id（shears、flint_and_steel 等，hand=空手）" },
                        target: { type: "string", description: "目标 id（实体或方块，nothing=对空气使用）" },
                    },
                    required: ["tool", "target"],
                },
                async execute(args) {
                    requireConnected();
                    return await bridge.useToolOn(String(args.tool ?? ""), String(args.target ?? ""));
                },
            },
            {
                id: "minecraft-bot_chest_put",
                enabled: true,
                name: "存入箱子",
                description: "把背包里的物品存进 32 格内最近的箱子/木桶（数量省略 = 全存）。玩家说「把这些存箱子里」时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        item: { type: "string", description: "物品 id" },
                        count: { type: "number", description: "数量（默认全部）" },
                    },
                    required: ["item"],
                },
                async execute(args) {
                    requireConnected();
                    const n = Number(args.count);
                    return await bridge.chestPut(String(args.item ?? ""), Number.isFinite(n) ? n : undefined);
                },
            },
            {
                id: "minecraft-bot_chest_take",
                enabled: true,
                name: "从箱子取出",
                description: "从 32 格内最近的箱子取物品（数量省略 = 全取）。玩家说「从箱子拿点木头」时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        item: { type: "string", description: "物品 id" },
                        count: { type: "number", description: "数量（默认全部）" },
                    },
                    required: ["item"],
                },
                async execute(args) {
                    requireConnected();
                    const n = Number(args.count);
                    return await bridge.chestTake(String(args.item ?? ""), Number.isFinite(n) ? n : undefined);
                },
            },
            {
                id: "minecraft-bot_chest_view",
                enabled: true,
                name: "查看箱子",
                description: "查看 32 格内最近箱子的内容（同名合并显示）。玩家说「看看箱子里有什么」时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: { type: "object", properties: {} },
                async execute() {
                    requireConnected();
                    return await bridge.chestView();
                },
            },
            {
                id: "minecraft-bot_activate_block",
                enabled: true,
                name: "激活方块",
                description: "激活 16 格内最近的指定方块（按钮、拉杆等可交互方块）。玩家说「按下那个按钮」「拉下拉杆」时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        block: { type: "string", description: "方块 id，如 lever、stone_button" },
                    },
                    required: ["block"],
                },
                async execute(args) {
                    requireConnected();
                    return await bridge.activateBlock(String(args.block ?? ""));
                },
            },
            {
                id: "minecraft-bot_villager_trades",
                enabled: true,
                name: "查看村民交易",
                description: "查看村民的交易列表（省略 id 看 16 格内最近的村民）。玩家说「看看村民卖什么」时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "string", description: "村民实体 id（可省略）" },
                    },
                },
                async execute(args) {
                    requireConnected();
                    return await bridge.villagerTrades(args.id ? String(args.id) : undefined);
                },
            },
            {
                id: "minecraft-bot_villager_trade",
                enabled: true,
                name: "与村民交易",
                description: "按序号与村民执行交易（序号从 1 开始，先查看交易列表拿到序号）。玩家说「跟他买 3 个面包」时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "string", description: "村民实体 id（可省略，用最近查看过的）" },
                        index: { type: "number", description: "交易序号（从 1 开始）" },
                        count: { type: "number", description: "交易次数（默认 1）" },
                    },
                    required: ["index"],
                },
                async execute(args) {
                    requireConnected();
                    const times = Number(args.count);
                    return await bridge.villagerTrade(args.id ? String(args.id) : undefined, Number(args.index), Number.isFinite(times) ? times : 1);
                },
            },
            {
                id: "minecraft-bot_set_cowardice",
                enabled: true,
                name: "切换胆小模式",
                description: "切换你的胆小人格：开启后见到敌对生物就本能逃跑、永不反击；关闭后被攻击会反击。玩家说「以后看到怪就跑别打」「你别怕，反击它」时用。",
                risk: "safe",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        enabled: { type: "boolean", description: "true 开启（见怪就逃），false 关闭（会反击）" },
                    },
                    required: ["enabled"],
                },
                async execute(args) {
                    return await setCowardicePreference(args.enabled === true);
                },
            },
            {
                id: "minecraft-bot_goal",
                enabled: true,
                name: "执行游戏自主任务",
                description: "开始自主执行一个游戏目标（如「挖 10 个橡木原木」「收集 20 个石头」），你会自己规划步骤并逐步完成，进度会在游戏聊天里汇报。任务在后台执行，本工具立即返回；玩家想取消时用停止工具。",
                risk: "input-control",
                effectKind: "mutation",
                inputSchema: {
                    type: "object",
                    properties: {
                        goal: { type: "string", description: "任务目标（自然语言，一句话）" },
                    },
                    required: ["goal"],
                },
                async execute(args) {
                    if (!goalRunner)
                        throw new Error("宿主未提供 LLM 服务，自主任务不可用");
                    requireConnected();
                    const goal = String(args.goal ?? "").trim();
                    goalRunner.start(goal);
                    return `目标已开始执行：${goal}。进度会在游戏聊天里向玩家汇报；玩家想取消时调用停止工具。`;
                },
            },
        ];
        for (const tool of tools)
            ctx.registerTool(tool);
        // 游戏聊天接入渠道系统：注册即完成接线，连接后频道自动可用
        await ctx.registerChannelAdapter(new channel_1.MinecraftChannelAdapter(bridge));
        // ---- 配置窗口 IPC：通道自动带 plugin:minecraft-bot: 前缀，ui.html 直接 invoke ----
        /** 上次连接配置的存储键；成功连接后记住，下次打开窗口自动回填。 */
        const LAST_CONFIG_KEY = "lastServerConfig";
        ctx.registerIpc("status", () => {
            const s = bridge.status();
            const g = goalRunner?.state ?? null;
            return { status: s, goal: g };
        });
        ctx.registerIpc("getConfig", () => ctx.storage.get(LAST_CONFIG_KEY));
        ctx.registerIpc("connect", async (arg) => {
            const input = (arg ?? {});
            const host = String(input.host ?? "").trim();
            if (!host)
                throw new Error("请填写服务器地址");
            const port = Number(input.port) || 25565;
            const username = String(input.username ?? "Cyrene").trim() || "Cyrene";
            if (username.length > 16)
                throw new Error("游戏角色名不能超过 16 个字符");
            const snapshot = await bridge.connect({ host, port, username });
            ctx.storage.set(LAST_CONFIG_KEY, { host, port, username });
            // 已保存的胆小偏好在每次连接后自动下发
            await applyCowardiceAfterConnect();
            return snapshot;
        });
        ctx.registerIpc("disconnect", async () => {
            goalRunner?.cancel("配置窗口断开");
            return bridge.disconnect();
        });
        ctx.registerIpc("stopActions", () => {
            if (goalRunner?.state.running) {
                goalRunner.cancel("配置窗口叫停");
                return "已取消自主任务";
            }
            bridge.stopTask();
            return "已停止当前动作";
        });
        // 胆小模式读写：配置窗口开关用
        ctx.registerIpc("getCowardice", () => cowardiceEnabled);
        ctx.registerIpc("setCowardice", (arg) => setCowardicePreference(arg === true));
        // 游戏情境注入（第一人称具身 + 动作铁律 + 场景化工具清单）：
        // 只在 minecraft 频道注入，桌面对话不受影响。
        // 四个目标：a) 世界观——她知道自己在陪玩家玩 Minecraft，不是日常桌面陪伴场景；
        // b) 具身认知——游戏角色就是她本人的身体，不是她操控的机器人；
        // c) 动作铁律——一切行为必须调工具执行，只说不做等于撒谎；
        // d) 场景索引——逐个工具说明什么时候用，让弱模型也能做对选择题。
        const provider = {
            id: "game-context",
            // 新宿主的 plugin-agent 来源只会调用显式声明的 Provider；旧 SDK 尚未发布该
            // 联合类型，施工期以结构断言保持向后兼容。
            sources: ["conversation", "plugin-agent"],
            provide(input) {
                if (input.channel !== "minecraft")
                    return "";
                const s = bridge.status();
                if (s.state !== "connected")
                    return "";
                if (input.source === "plugin-agent") {
                    const position = s.position ? `坐标 (${s.position.map((n) => n.toFixed(1)).join(", ")})，生命 ${s.health ?? "?"}/20，饥饿 ${s.food ?? "?"}/20` : "坐标未知";
                    const inventory = s.inventory.length ? s.inventory.map((it) => `${it.name} x${it.count}`).join("、") : "空";
                    return [
                        "【Minecraft 自主任务】",
                        `你正在 Minecraft 世界中以「${s.username}」这具身体亲自完成玩家目标。服务器 ${s.host}:${s.port}。`,
                        `开局身体状态：${position}。背包：${inventory}。`,
                        "严格使用当前提供的目标工具行动；工具结果会带回新的身体状态。需要向玩家汇报时调用游戏内汇报工具。目标完成、确实无法继续或需要玩家帮助时，直接用自然语言给出简洁报告。",
                    ].join("\n");
                }
                const lines = [
                    "【你正在 Minecraft 游戏世界里】",
                    "你现在正陪着玩家一起玩 Minecraft。这场对话就发生在游戏内：跟你说话的玩家就站在你附近，你们共享同一个方块世界。",
                    `游戏里那个名叫「${s.username}」的角色，就是你本人的身体——不是别人的机器人，也不是你操控的机器，就是你。玩家在游戏里看到的那个人，就是你。`,
                    `当前服务器 ${s.host}:${s.port}。`,
                ];
                if (s.position) {
                    lines.push(`你的身体：坐标 (${s.position.map((n) => n.toFixed(1)).join(", ")})，生命值 ${s.health}/20，饥饿值 ${s.food}/20。`);
                }
                if (s.currentTask)
                    lines.push(`你的身体正在：${s.currentTask}。`);
                const inv = s.inventory ?? [];
                lines.push(`你的背包：${inv.length > 0 ? inv.map((it) => `${it.name} x${it.count}`).join("、") : "空"}。`);
                // 最近 1 分钟内的本能行为，让她知道身体自己干过什么
                const instincts = (s.recentInstinct ?? []).filter((i) => Date.now() - i.at < 60_000);
                if (instincts.length > 0) {
                    lines.push(`你的身体刚自动做了（本能反应，不经你决策）：${instincts.map((i) => i.action).join("；")}。`);
                }
                if (cowardiceEnabled) {
                    lines.push("你现在是胆小模式：见到敌对生物会本能地逃跑，不会反击。");
                }
                if (goalRunner?.state.running) {
                    lines.push(`你正在自主执行任务：「${goalRunner.state.goal}」（第 ${goalRunner.state.round} 轮）。`);
                }
                lines.push("");
                lines.push("【行动铁律】");
                lines.push("你在游戏世界里没有手柄，你的双手就是工具调用。身体的一切行为——走过去、跟随、停下、挖方块、收集材料、执行多步任务——都必须调用 Minecraft 工具真正完成。只嘴上说「我过来了」「我砍完了」却没调工具，等于对玩家撒谎，严格禁止。");
                lines.push("正确顺序永远是：先调用工具让身体动起来，再开口回应玩家。判断一次回应是否合格的标准只有一个——该做的动作是否真的通过工具发起了。");
                lines.push("反过来也成立：如果你希望身体做点什么，就必然存在一步工具调用；没有任何动作能靠说话完成。");
                lines.push("背包里有什么、身体状态如何，以上面给你的实时信息为准——汇报数量和状态前先看一眼，不要凭感觉编造。玩家让你收集东西时，先看背包里已经有了多少，够了就直接告知，不够再去补。");
                lines.push("你的身体有本能反应（饿了自动吃、没吃的会去打猎、着火了会自救、被怪打会反击或逃跑、顺手捡掉落物），不经你决策就会发生。玩家问起时如实说明这是身体本能即可。");
                lines.push("");
                lines.push("【本场景工具速查】（什么时候用哪个）");
                lines.push("· 查看我的游戏状态 —— 想知道自己的坐标、生命值、背包、正在做的事、游戏里聊了什么时用。玩家问「你在哪」「背包里有什么」「你还活着吗」也是用它。");
                lines.push("· 在游戏里移动 —— 玩家说「过来」「来我这」「去 xxx」时用，你的身体会自动寻路走过去。");
                lines.push("· 跟随玩家 —— 玩家说「跟着我」「跟我走」时用，身体会持续跟着对方。");
                lines.push("· 停下游戏动作 —— 玩家说「停」「别动了」「站着别动」时用，停下移动、跟随和自主任务。");
                lines.push("· 执行游戏自主任务 —— 玩家给你目标时用，如「去挖 10 个木头」「收集 20 个石头」「先砍树再来找我」。多步任务交给它，你会自己规划步骤逐步完成并在游戏里汇报进度。");
                lines.push("· 吃点东西 —— 玩家让你吃东西、你饥饿值低时用，恢复饥饿。");
                lines.push("· 合成物品 —— 玩家说「做成木板」「做把镐子」时用；工作台可以合成后自己放下。");
                lines.push("· 熔炼物品 —— 玩家说「把铁矿烧成锭」「烤个肉」时用，需要附近有熔炉和燃料。");
                lines.push("· 把物品递给玩家 —— 玩家说「给我几个木头」时用，你会走过去递给他。");
                lines.push("· 建一个小屋 —— 玩家说「盖个房子」「建个家」时用，需要约 95 个木板、1 门、1 火把。");
                lines.push("· 放置/挖掉方块 —— 玩家指定坐标让你精确摆或拆时用。");
                lines.push("· 攻击生物 —— 玩家说「把那只僵尸杀了」「去打猎」时用；生物 id 用英文（zombie、skeleton、cow、pig）。");
                lines.push("· 捡起掉落物 —— 玩家说「把地上的东西捡了」时用。");
                lines.push("· 开门 / 激活方块 —— 进出房屋、按按钮/拉拉杆时用。");
                lines.push("· 寻找方块 / 向下挖矿 / 回到地表 —— 探索导航；「去挖矿」一般是组合动作：向下挖 + 收集矿石。");
                lines.push("· 原地等待 —— 玩家说「在这等我」时用，你会站住一段时间直到有人叫你。");
                lines.push("· 丢掉物品 / 耕地播种 / 对目标用工具 —— 清背包、种田（需要锄头和种子）、精细操作（如剪羊毛）。");
                lines.push("· 存入/取出/查看箱子 —— 「存到箱子里」「从箱子拿点木头」时用，找 32 格内的箱子。");
                lines.push("· 查看村民交易 / 与村民交易 —— 「看看村民卖什么」「跟他买 3 个面包」时用。");
                lines.push("· 切换胆小模式 —— 玩家表达性格偏好时用，如「以后看到怪就跑别打」（开启）、「别怕，反击它」（关闭）。");
                lines.push("· 在游戏里说话 —— 只想说话不做动作时用（本频道的回复本身也会发到游戏聊天栏，多数时候不必单独调用）。");
                lines.push("· 进入/离开 Minecraft 服务器 —— 连接或断开你的游戏身体，配置窗口或玩家明确要求时才用。");
                lines.push("");
                lines.push("玩家的话如果包含多个步骤（如「先砍树再过来」），把它作为一个目标交给自主任务工具，不要自己拆成只言片语、更不要只回应最后一步。");
                lines.push("你在本频道说的话会从你游戏身体的嘴里发出，出现在游戏聊天栏。");
                return lines.join("\n");
            },
        };
        ctx.registerPromptProvider(provider);
        ctx.onDispose(async () => {
            goalRunner?.cancel("插件停用");
            await bridge.dispose();
        });
        const toolSummary = llm ? "8 个工具 + minecraft 聊天频道 + 第一人称游戏情境注入 + 自主任务循环 + 配置窗口" : "8 个工具 + minecraft 聊天频道 + 第一人称游戏情境注入 + 配置窗口（自主任务不可用：缺 LLM 服务）";
        ctx.log(`minecraft-bot 已加载：${toolSummary}`);
    },
    // 设置页/插件面板的"打开"按钮：弹出配置窗口（服务器地址端口直连，不用经过对话框）
    async open() {
        if (configWin && !configWin.isDestroyed()) {
            configWin.focus();
            return;
        }
        const { BrowserWindow } = require("electron");
        configWin = new BrowserWindow({
            width: 460,
            height: 560,
            minWidth: 420,
            minHeight: 520,
            autoHideMenuBar: true,
            backgroundColor: "#fff9fc",
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
            },
        });
        configWin.on("closed", () => {
            configWin = null;
        });
        await configWin.loadFile(path.join(__dirname, "ui.html"));
    },
    unregister() {
        if (configWin && !configWin.isDestroyed())
            configWin.close();
    },
};
exports.default = plugin;
