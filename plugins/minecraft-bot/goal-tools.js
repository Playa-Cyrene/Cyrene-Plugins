"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGoalTools = createGoalTools;
const object = (properties, required) => ({
    type: "object",
    properties,
    ...(required ? { required } : {}),
});
function statusLine(status) {
    const position = status.position ? status.position.map((value) => value.toFixed(1)).join(",") : "未知";
    return `[状态] 坐标(${position}) 生命 ${status.health ?? "?"}/20 饥饿 ${status.food ?? "?"}/20`;
}
function numberInRange(value, fallback, min, max) {
    return Math.min(Math.max(Number(value) || fallback, min), max);
}
/** 让插件取消信号也能中断正在进行的游戏动作。 */
async function interruptible(bridge, signal, action) {
    if (signal.aborted)
        throw new Error("自主任务已取消");
    return await new Promise((resolve, reject) => {
        const abort = () => {
            try {
                bridge.stopTask();
            }
            catch { /* 断线时没有物理动作可停 */ }
            reject(new Error("自主任务已取消"));
        };
        signal.addEventListener("abort", abort, { once: true });
        void action().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}
/**
 * 为无头目标 run 构造专用工具集。它不会注册进聊天工具目录：同名聊天工具的
 * 即发即返语义不适合长任务，这里统一等待动作结果并补充一次缓存状态快照。
 */
function createGoalTools(bridge, signal) {
    const action = (id, name, description, inputSchema, effectKind, run, risk = "safe") => ({
        id: `minecraft-bot_${id}`,
        name,
        description,
        enabled: true,
        risk,
        effectKind,
        inputSchema,
        async execute(args, context) {
            const result = await interruptible(bridge, context?.signal ?? signal, () => run(args));
            return `${result}\n${statusLine(bridge.status())}`;
        },
    });
    const query = (id, name, description, inputSchema, run) => ({
        id: `minecraft-bot_${id}`,
        name,
        description,
        enabled: true,
        risk: "safe",
        effectKind: "read",
        inputSchema,
        async execute(args, context) {
            return await interruptible(bridge, context?.signal ?? signal, () => run(args));
        },
    });
    return Object.freeze([
        query("goal_status", "查看当前游戏状态", "查看坐标、生命、饥饿和正在进行的身体动作。", object({}), async () => statusLine(bridge.status())),
        query("goal_inventory", "查看背包", "查看当前背包物品，用于判断是否已有所需材料。", object({}), async () => {
            const inventory = await bridge.getInventory();
            return inventory.length ? `背包：${inventory.map((item) => `${item.name} x${item.count}`).join(", ")}` : "背包为空";
        }),
        action("goal_goto", "移动到玩家或坐标", "走到指定玩家身边或指定坐标；会等待到达、失败或停止的终态。", object({
            player: { type: "string", description: "目标玩家名（与坐标二选一）" }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" },
        }), "mutation", async (args) => {
            if (args.player) {
                const player = String(args.player);
                return await bridge.moveToAndWait(`走向 ${player}`, () => bridge.moveTo({ player }));
            }
            const [x, y, z] = [Number(args.x), Number(args.y), Number(args.z)];
            if (![x, y, z].every(Number.isFinite))
                throw new Error("需要提供 player 或完整坐标 x/y/z");
            return await bridge.moveToAndWait(`走向 (${x}, ${y}, ${z})`, () => bridge.moveTo({ x, y, z }));
        }),
        action("goal_follow", "持续跟随玩家", "开始持续跟随玩家；这是已发起语义，不会自然结束，需用任务内停止工具结束。", object({ player: { type: "string", description: "玩家名" } }, ["player"]), "mutation", async (args) => {
            const player = String(args.player ?? "").trim();
            if (!player)
                throw new Error("玩家名不能为空");
            bridge.follow(player);
            return `已开始跟随 ${player}，需要结束时调用停止物理动作`;
        }),
        action("goal_stop", "停止物理动作", "只停止移动、跟随或当前游戏动作；不会取消整个自主任务。", object({}), "mutation", async () => {
            bridge.stopTask();
            return "已停止当前物理动作";
        }),
        action("goal_say", "在游戏里汇报", "通过游戏聊天向玩家简短汇报进度。", object({ message: { type: "string", description: "汇报内容" } }, ["message"]), "external_side_effect", async (args) => {
            const message = String(args.message ?? "").trim();
            if (!message)
                throw new Error("消息不能为空");
            bridge.say(message);
            return `已说：${message}`;
        }),
        action("goal_collect", "收集方块", "自动寻路、选工具、挖掘并拾取指定方块。", object({ block: { type: "string" }, count: { type: "number" } }, ["block"]), "external_side_effect", async (args) => {
            const block = String(args.block ?? "").trim();
            if (!block)
                throw new Error("方块 id 不能为空");
            const count = numberInRange(args.count, 1, 1, 64);
            const result = await bridge.collect(block, count);
            return result.ok ? `收集完成：${result.block}，目标 ${result.requested}，找到 ${result.found ?? result.requested}` : `收集失败：${result.error ?? "未知原因"}`;
        }),
        action("goal_eat", "吃东西", "吃背包中的食物恢复饥饿，不指定物品时自动选择。", object({ item: { type: "string" } }), "external_side_effect", async (args) => await bridge.eat(args.item ? String(args.item) : undefined)),
        action("goal_craft", "合成物品", "合成指定物品；需要工作台的配方会使用附近工作台。", object({ item: { type: "string" }, count: { type: "number" } }, ["item"]), "external_side_effect", async (args) => await bridge.craft(String(args.item ?? ""), numberInRange(args.count, 1, 1, 64))),
        action("goal_smelt", "熔炼物品", "在附近熔炉中熔炼指定物品。", object({ item: { type: "string" }, count: { type: "number" } }, ["item"]), "external_side_effect", async (args) => await bridge.smelt(String(args.item ?? ""), numberInRange(args.count, 1, 1, 64))),
        action("goal_give", "把物品交给玩家", "走近玩家后交出指定物品。", object({ player: { type: "string" }, item: { type: "string" }, count: { type: "number" } }, ["player", "item"]), "external_side_effect", async (args) => await bridge.give(String(args.player ?? ""), String(args.item ?? ""), numberInRange(args.count, 1, 1, 64))),
        action("goal_sleep", "睡觉", "寻找最近的床并睡觉。", object({}), "external_side_effect", async () => await bridge.sleep()),
        action("goal_place", "放置方块", "在精确坐标放置方块。", object({ x: { type: "number" }, y: { type: "number" }, z: { type: "number" }, block: { type: "string" } }, ["x", "y", "z", "block"]), "mutation", async (args) => await bridge.place(Number(args.x), Number(args.y), Number(args.z), String(args.block ?? ""))),
        action("goal_break", "挖掉方块", "挖掉精确坐标的方块。", object({ x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, ["x", "y", "z"]), "mutation", async (args) => await bridge.breakBlock(Number(args.x), Number(args.y), Number(args.z))),
        action("goal_build_shelter", "建造小屋", "在脚下建造一间木板小屋。", object({}), "external_side_effect", async () => await bridge.buildShelter()),
        action("goal_attack", "攻击生物", "攻击并击杀附近指定生物。", object({ mob: { type: "string" }, kill: { type: "boolean" } }, ["mob"]), "external_side_effect", async (args) => await bridge.attack(String(args.mob ?? ""), args.kill !== false), "input-control"),
        action("goal_pickup", "捡起掉落物", "捡起周围掉落物。", object({ range: { type: "number" } }), "external_side_effect", async (args) => await bridge.pickup(args.range === undefined ? undefined : Number(args.range))),
        action("goal_use_door", "使用门", "使用最近的门穿过。", object({}), "external_side_effect", async () => await bridge.useDoor()),
        action("goal_goto_block", "寻找并走到方块", "找到最近指定方块并走过去。", object({ block: { type: "string" }, range: { type: "number" } }, ["block"]), "mutation", async (args) => await bridge.gotoBlock(String(args.block ?? ""), args.range === undefined ? undefined : Number(args.range))),
        action("goal_dig_down", "向下挖矿", "向下挖指定格数，遇险会停止。", object({ distance: { type: "number" } }, ["distance"]), "mutation", async (args) => await bridge.digDown(numberInRange(args.distance, 1, 1, 32))),
        action("goal_go_surface", "回到地表", "回到当前位置上方地表。", object({}), "mutation", async () => await bridge.goSurface()),
        action("goal_stay", "原地等待", "原地等待一段时间。", object({ seconds: { type: "number" } }), "mutation", async (args) => await bridge.stay(numberInRange(args.seconds, 30, 5, 300))),
        action("goal_discard", "丢掉物品", "丢掉背包物品，数量缺省时全部丢掉。", object({ item: { type: "string" }, count: { type: "number" } }, ["item"]), "external_side_effect", async (args) => {
            const count = Number(args.count);
            return await bridge.discard(String(args.item ?? ""), Number.isFinite(count) ? count : undefined);
        }),
        action("goal_till_sow", "耕地播种", "用锄头翻土并可选播种。", object({ x: { type: "number" }, y: { type: "number" }, z: { type: "number" }, seed: { type: "string" } }, ["x", "y", "z"]), "external_side_effect", async (args) => await bridge.tillSow(Number(args.x), Number(args.y), Number(args.z), args.seed ? String(args.seed) : undefined)),
        action("goal_use_tool_on", "对目标使用工具", "对附近实体或方块使用工具，hand 表示空手。", object({ tool: { type: "string" }, target: { type: "string" } }, ["tool", "target"]), "external_side_effect", async (args) => await bridge.useToolOn(String(args.tool ?? ""), String(args.target ?? ""))),
        action("goal_chest_put", "存入箱子", "将物品存入最近的箱子。", object({ item: { type: "string" }, count: { type: "number" } }, ["item"]), "external_side_effect", async (args) => {
            const count = Number(args.count);
            return await bridge.chestPut(String(args.item ?? ""), Number.isFinite(count) ? count : undefined);
        }),
        action("goal_chest_take", "从箱子取出", "从最近箱子取出物品。", object({ item: { type: "string" }, count: { type: "number" } }, ["item"]), "external_side_effect", async (args) => {
            const count = Number(args.count);
            return await bridge.chestTake(String(args.item ?? ""), Number.isFinite(count) ? count : undefined);
        }),
        query("goal_chest_view", "查看箱子", "查看最近箱子的内容。", object({}), async () => await bridge.chestView()),
        action("goal_activate_block", "激活方块", "激活附近按钮、拉杆等方块。", object({ block: { type: "string" } }, ["block"]), "external_side_effect", async (args) => await bridge.activateBlock(String(args.block ?? ""))),
        query("goal_villager_trades", "查看村民交易", "查看指定或最近村民的交易列表。", object({ id: { type: "string" } }), async (args) => await bridge.villagerTrades(args.id ? String(args.id) : undefined)),
        action("goal_villager_trade", "与村民交易", "按序号和村民执行交易。", object({ id: { type: "string" }, index: { type: "number" }, count: { type: "number" } }, ["index"]), "external_side_effect", async (args) => await bridge.villagerTrade(args.id ? String(args.id) : undefined, Number(args.index), numberInRange(args.count, 1, 1, 64))),
    ]);
}
