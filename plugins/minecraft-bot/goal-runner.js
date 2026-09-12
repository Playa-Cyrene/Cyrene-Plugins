"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoalRunner = void 0;
const node_crypto_1 = require("node:crypto");
const goal_tools_1 = require("./goal-tools");
/** 循环安全上限：LLM 决策轮数、整体时长、单轮 LLM 调用超时。 */
const MAX_ROUNDS = 24;
const MAX_WALL_MS = 15 * 60_000;
const LLM_TIMEOUT_MS = 90_000;
/** 历史上限：超出后丢弃最早的轮次，控制上下文体积。 */
const MAX_HISTORY = 12;
const GOAL_RUN_RECORD_KEY = "goalRunRecord";
const COMMAND_DOCS = `可用指令（每轮恰好输出一条，独占一行，不要输出其他内容）：
!collect <方块id> <数量> —— 收集方块（自动寻路、选工具、挖掘、拾取）
!goto_player <玩家名> —— 走到玩家身边
!goto <x> <y> <z> —— 走到坐标
!follow <玩家名> —— 持续跟随玩家
!inventory —— 查看背包
!status —— 查看身体状态
!eat [食物id] —— 吃东西恢复饥饿（不指定就自动挑）
!craft <物品id> <数量> —— 合成物品（3x3 配方需要附近 4 格内有合成台）
!smelt <物品id> <数量> —— 熔炼物品（需要附近 4 格内有熔炉和燃料）
!give <玩家名> <物品id> <数量> —— 把物品递给玩家
!sleep —— 找最近的床睡觉
!place <x> <y> <z> <方块id> —— 在坐标放方块
!break <x> <y> <z> —— 挖掉坐标上的方块
!build_shelter —— 在脚下建 5x5 木板小屋（需约 95 木板、1 门、1 火把）
!attack <生物id> —— 攻击并击杀附近生物（zombie、cow 等，24 格内，杀完自动捡战利品）
!pickup —— 捡起周围掉落物
!use_door —— 开最近的门穿过去
!goto_block <方块id> —— 找最近的指定方块并走过去
!dig_down <格数> —— 向下挖（遇岩浆/水/大落差自动停）
!go_surface —— 回到地表
!discard <物品id> [数量] —— 丢掉物品（省略数量=全丢）
!till_sow <x> <y> <z> [种子id] —— 翻土播种（y 是地面方块，需要锄头）
!use_tool_on <工具id> <目标id> —— 对实体/方块用工具（空手用 hand）
!chest_put <物品id> [数量] —— 存进最近的箱子
!chest_take <物品id> [数量] —— 从箱子取出
!chest_view —— 查看箱子内容
!activate_block <方块id> —— 激活按钮/拉杆等
!villager_trades [村民id] —— 查看村民交易（不带 id 看最近的）
!villager_trade <村民id> <序号> [次数] —— 与村民交易
!say <中文> —— 在游戏里向玩家说话（汇报进展、打招呼）
!stop —— 停止当前移动
done <中文总结> —— 目标完成或无法继续时输出

规则：
- 方块/物品/生物用英文小写下划线 id（如 oak_log、oak_planks、cobblestone、crafting_table、zombie）
- 玩家需要知道进展时用 !say 简短汇报（口语化、一句话）
- 仔细阅读每轮回传的状态和结果再决定下一步；同类失败连续两次就换方法或 done
- 需要工作台/熔炉而附近没有时：合成一个（craft crafting_table / craft furnace）再 !place 放下
- 目标完成或确实无法完成时输出 done 开头的一行`;
class GoalRunner {
    bridge;
    llm;
    storage;
    log;
    state = {
        running: false,
        goal: null,
        startedAt: null,
        round: 0,
        lastSummary: null,
    };
    abortController = null;
    activeRunId = null;
    interruptedNotice = null;
    constructor(bridge, llm, storage, log) {
        this.bridge = bridge;
        this.llm = llm;
        this.storage = storage;
        this.log = log;
        this.bridge.onStateChange((state) => {
            if (state === "disconnected")
                this.cancel("机器人连接已断开");
        });
        const previous = this.storage.get(GOAL_RUN_RECORD_KEY);
        if (previous?.phase === "running") {
            this.interruptedNotice = `上次的任务「${previous.goal}」被中断了，请让玩家重新发起。`;
            this.state.lastSummary = this.interruptedNotice;
            this.storage.set(GOAL_RUN_RECORD_KEY, {
                ...previous,
                phase: "terminal",
                terminal: { status: "cancelled", reason: "recovered_interrupted", externalEffectsMayContinue: true, at: Date.now() },
            });
        }
    }
    /** 仅在插件重启后消费一次上次任务被中断的提示。 */
    takeInterruptedNotice() {
        const notice = this.interruptedNotice;
        this.interruptedNotice = null;
        return notice;
    }
    /** 启动自主任务；立即返回，循环在后台跑，进度经游戏聊天汇报。 */
    start(goal) {
        const trimmed = goal.trim();
        if (!trimmed)
            throw new Error("任务目标不能为空");
        if (this.state.running) {
            throw new Error(`已有任务进行中（${this.state.goal}），请先用停止工具取消`);
        }
        if (this.bridge.status().state !== "connected") {
            throw new Error("机器人未连接，请先连接服务器");
        }
        const runId = (0, node_crypto_1.randomUUID)();
        const startedAt = Date.now();
        this.activeRunId = runId;
        this.state = { running: true, goal: trimmed, startedAt, round: 0, lastSummary: null, runId };
        this.storage.set(GOAL_RUN_RECORD_KEY, { runId, goal: trimmed, startedAt, phase: "running" });
        const runGoal = this.llm.runGoal;
        this.abortController = new AbortController();
        if (runGoal) {
            void this.runHarness(trimmed, runId, runGoal, this.abortController.signal);
        }
        else {
            this.log("宿主未提供 runGoal，使用兼容的 legacy 文本指令循环");
            void this.loop(trimmed, runId, this.abortController.signal);
        }
    }
    /** 取消当前任务（用户喊停 / 断开连接 / 插件停用）。 */
    cancel(reason) {
        const runId = this.activeRunId;
        if (!runId || !this.state.running)
            return;
        this.abortController?.abort();
        // 同步打断子进程侧的移动和收集
        try {
            this.bridge.stopTask();
        }
        catch { /* 未连接时忽略 */ }
        this.finish(runId, `任务已中止（${reason}）`, { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true });
    }
    /** 只有当前运行可以更新共享状态、持久化记录和游戏内报告。 */
    isActive(runId) {
        return this.state.running && this.activeRunId === runId;
    }
    async runHarness(goal, runId, runGoal, signal) {
        try {
            const result = await runGoal({
                runId,
                goal,
                tools: (0, goal_tools_1.createGoalTools)(this.bridge, signal),
                purpose: "minecraft-goal",
                signal,
                maxRounds: 50,
                maxWallMs: MAX_WALL_MS,
                onEvent: (event) => {
                    if (this.isActive(runId) && event.kind === "round_started")
                        this.state.round = event.round;
                },
            });
            if (!this.isActive(runId))
                return;
            const summary = this.formatHarnessSummary(result.text, result.terminal, result.rounds);
            this.finish(runId, summary, result.terminal);
        }
        catch (err) {
            if (signal.aborted || !this.isActive(runId))
                return;
            const message = err instanceof Error ? err.message : String(err);
            this.finish(runId, `任务异常终止：${message}`, { status: "runtime_error", reason: "runtime_error", externalEffectsMayContinue: true });
        }
    }
    formatHarnessSummary(text, terminal, rounds) {
        if (terminal.reason === "max_rounds") {
            const status = this.bridge.status();
            const position = status.position ? `(${status.position.map((value) => value.toFixed(1)).join(", ")})` : "未知";
            return `已达轮次上限（${rounds} 轮），任务未声明完成。当前状态：坐标 ${position}，生命 ${status.health ?? "?"}/20，饥饿 ${status.food ?? "?"}/20。可重新发起或让玩家协助。`;
        }
        if (terminal.status === "success")
            return text.trim() || "目标已完成";
        if (terminal.status === "timeout")
            return `任务超时（${terminal.reason ?? "timeout"}）：${text.trim() || "未能在时限内完成"}`;
        if (terminal.status === "cancelled")
            return `任务已取消：${text.trim() || "已停止"}`;
        return `任务异常终止：${text.trim() || terminal.reason || "未知运行时错误"}`;
    }
    /** 循环主体：构建观察 → 问 LLM → 解析指令 → 执行 → 回填，直至 done 或上限。 */
    async loop(goal, runId, signal) {
        const username = this.bridge.status().username ?? "机器人";
        const system = `你就是 Minecraft 服务器里的角色「${username}」，此刻亲身站在游戏世界里。玩家给你的目标：${goal}。你在自主执行它，像自己动手干活一样逐步完成。\n\n${COMMAND_DOCS}`;
        const history = [];
        let lastResult = "任务开始，请决定第一步。";
        try {
            while (this.isActive(runId)) {
                if (this.bridge.status().state !== "connected") {
                    this.finish(runId, "机器人已断开连接", { status: "cancelled", reason: "disconnected", externalEffectsMayContinue: true });
                    return;
                }
                if (this.state.round >= MAX_ROUNDS) {
                    this.finish(runId, `已达决策轮次上限（${MAX_ROUNDS} 轮）`, { status: "timeout", reason: "max_rounds", externalEffectsMayContinue: true });
                    return;
                }
                if (this.state.startedAt && Date.now() - this.state.startedAt > MAX_WALL_MS) {
                    this.finish(runId, "已达任务时间上限（15 分钟）", { status: "timeout", reason: "timeout", externalEffectsMayContinue: true });
                    return;
                }
                this.state.round++;
                const observation = await this.buildObservation(lastResult);
                history.push({ role: "user", content: observation });
                const reply = await this.llm.generateText([{ role: "system", content: system }, ...history], { maxTokens: 300, timeoutMs: LLM_TIMEOUT_MS, purpose: "goal-step", signal });
                if (!this.isActive(runId))
                    return;
                const command = this.extractCommand(reply);
                history.push({ role: "assistant", content: command ?? reply.slice(0, 200) });
                if (history.length > MAX_HISTORY)
                    history.splice(0, history.length - MAX_HISTORY);
                // 无指令即视为 LLM 认为任务结束
                if (!command) {
                    this.finish(runId, reply.trim() || "任务结束", { status: "success", externalEffectsMayContinue: false });
                    return;
                }
                if (command.toLowerCase().startsWith("done")) {
                    this.finish(runId, command.slice(4).trim() || "目标已完成", { status: "success", externalEffectsMayContinue: false });
                    return;
                }
                if (!this.isActive(runId))
                    return;
                lastResult = await this.execute(command);
            }
        }
        catch (err) {
            if (this.isActive(runId)) {
                this.finish(runId, `任务异常终止: ${err instanceof Error ? err.message : String(err)}`, { status: "runtime_error", reason: "runtime_error", externalEffectsMayContinue: true });
            }
        }
    }
    /** 从 LLM 回复中抽取指令行：取第一个非空行，必须是 ! 指令或 done。 */
    extractCommand(reply) {
        const line = reply
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l.length > 0);
        if (!line)
            return null;
        if (line.startsWith("!") || line.toLowerCase().startsWith("done"))
            return line;
        return null;
    }
    /** 汇总当前世界状态给 LLM 当观察输入。 */
    async buildObservation(lastResult) {
        const s = this.bridge.status();
        const lines = [];
        if (s.position) {
            lines.push(`[状态] 坐标 (${s.position.map((n) => n.toFixed(1)).join(", ")})，生命 ${s.health ?? "?"}/20，饥饿 ${s.food ?? "?"}/20${s.currentTask ? `，正在执行：${s.currentTask}` : ""}`);
        }
        else {
            lines.push("[状态] 坐标未知");
        }
        try {
            const inv = await this.bridge.getInventory();
            lines.push(inv.length > 0
                ? `[背包] ${inv.map((it) => `${it.name} x${it.count}`).join(", ")}`
                : "[背包] 空");
        }
        catch {
            lines.push("[背包] 查询失败");
        }
        try {
            const players = await this.bridge.getPlayers();
            lines.push(players.length > 0
                ? `[在线玩家] ${players.map((p) => (p.position ? `${p.name}(${p.position.map((n) => n.toFixed(0)).join(",")})` : p.name)).join(", ")}`
                : "[在线玩家] 无");
        }
        catch {
            lines.push("[在线玩家] 查询失败");
        }
        lines.push(`[上一步结果] ${lastResult}`);
        return lines.join("\n");
    }
    /** 执行单条指令并返回给 LLM 的结果文本。 */
    async execute(command) {
        const [name, ...args] = command.slice(1).split(/\s+/);
        try {
            switch (name) {
                case "collect": {
                    const block = args[0];
                    const count = Math.min(Math.max(Number(args[1]) || 1, 1), 64);
                    if (!block)
                        return "缺少方块 id 参数";
                    const r = await this.bridge.collect(block, count);
                    return r.ok
                        ? `收集完成：${r.block}（目标 ${r.requested} 个，实际找到 ${r.found ?? r.requested} 个目标方块）。注意：挖掘产物名字可能不同（如 stone 掉 cobblestone），可用 !inventory 核对`
                        : `收集失败：${r.error}`;
                }
                case "goto_player": {
                    if (!args[0])
                        return "缺少玩家名参数";
                    return await this.bridge.moveToAndWait(`走向 ${args[0]}`, () => this.bridge.moveTo({ player: args[0] }));
                }
                case "goto": {
                    const [x, y, z] = [Number(args[0]), Number(args[1]), Number(args[2])];
                    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
                        return "坐标参数不完整";
                    return await this.bridge.moveToAndWait(`走向 (${x}, ${y}, ${z})`, () => this.bridge.moveTo({ x, y, z }));
                }
                case "follow": {
                    if (!args[0])
                        return "缺少玩家名参数";
                    this.bridge.follow(args[0]);
                    return `已开始跟随 ${args[0]}（持续跟随不会自动结束）`;
                }
                case "inventory": {
                    const inv = await this.bridge.getInventory();
                    return inv.length > 0 ? `背包：${inv.map((it) => `${it.name} x${it.count}`).join(", ")}` : "背包是空的";
                }
                case "status": {
                    const s = this.bridge.status();
                    return s.position
                        ? `坐标 (${s.position.map((n) => n.toFixed(1)).join(", ")})，生命 ${s.health}/20，饥饿 ${s.food}/20`
                        : "状态未知";
                }
                case "say": {
                    const text = command.slice(name.length + 2).trim();
                    if (!text)
                        return "缺少要说的内容";
                    this.bridge.say(text);
                    return `已在游戏里说：「${text}」`;
                }
                case "stop":
                    this.bridge.stopTask();
                    return "已停止移动";
                case "eat": {
                    const r = await this.bridge.eat(args[0] || undefined);
                    return r;
                }
                case "craft": {
                    if (!args[0])
                        return "缺少物品 id 参数";
                    const count = Math.min(Math.max(Number(args[1]) || 1, 1), 64);
                    const r = await this.bridge.craft(args[0], count);
                    return `${r}（用 !inventory 可核对）`;
                }
                case "smelt": {
                    if (!args[0])
                        return "缺少物品 id 参数";
                    const count = Math.min(Math.max(Number(args[1]) || 1, 1), 64);
                    const r = await this.bridge.smelt(args[0], count);
                    return r;
                }
                case "give": {
                    if (args.length < 2)
                        return "参数不完整（!give 玩家名 物品id 数量）";
                    const count = Math.min(Math.max(Number(args[2]) || 1, 1), 64);
                    const r = await this.bridge.give(args[0], args[1], count);
                    return r;
                }
                case "sleep": {
                    const r = await this.bridge.sleep();
                    return r;
                }
                case "place": {
                    const [x, y, z] = [Number(args[0]), Number(args[1]), Number(args[2])];
                    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !args[3])
                        return "参数不完整（!place x y z 方块id）";
                    return await this.bridge.place(x, y, z, args[3]);
                }
                case "break": {
                    const [x, y, z] = [Number(args[0]), Number(args[1]), Number(args[2])];
                    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
                        return "参数不完整（!break x y z）";
                    return await this.bridge.breakBlock(x, y, z);
                }
                case "build_shelter": {
                    return await this.bridge.buildShelter();
                }
                case "attack": {
                    if (!args[0])
                        return "缺少生物 id 参数";
                    return await this.bridge.attack(args[0], args[1] !== "false");
                }
                case "pickup":
                    return await this.bridge.pickup();
                case "use_door":
                    return await this.bridge.useDoor();
                case "goto_block": {
                    if (!args[0])
                        return "缺少方块 id 参数";
                    return await this.bridge.gotoBlock(args[0]);
                }
                case "dig_down": {
                    return await this.bridge.digDown(Math.min(Math.max(Number(args[0]) || 1, 1), 32));
                }
                case "go_surface":
                    return await this.bridge.goSurface();
                case "discard": {
                    if (!args[0])
                        return "缺少物品 id 参数";
                    const dn = Number(args[1]);
                    return await this.bridge.discard(args[0], Number.isFinite(dn) ? dn : undefined);
                }
                case "till_sow": {
                    const [x, y, z] = [Number(args[0]), Number(args[1]), Number(args[2])];
                    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
                        return "参数不完整（!till_sow x y z [种子id]）";
                    return await this.bridge.tillSow(x, y, z, args[3]);
                }
                case "use_tool_on": {
                    if (args.length < 2)
                        return "参数不完整（!use_tool_on 工具 目标）";
                    return await this.bridge.useToolOn(args[0], args[1]);
                }
                case "chest_put": {
                    if (!args[0])
                        return "缺少物品 id 参数";
                    const pn = Number(args[1]);
                    return await this.bridge.chestPut(args[0], Number.isFinite(pn) ? pn : undefined);
                }
                case "chest_take": {
                    if (!args[0])
                        return "缺少物品 id 参数";
                    const tn = Number(args[1]);
                    return await this.bridge.chestTake(args[0], Number.isFinite(tn) ? tn : undefined);
                }
                case "chest_view":
                    return await this.bridge.chestView();
                case "activate_block": {
                    if (!args[0])
                        return "缺少方块 id 参数";
                    return await this.bridge.activateBlock(args[0]);
                }
                case "villager_trades":
                    return await this.bridge.villagerTrades(args[0]);
                case "villager_trade": {
                    if (args.length < 2)
                        return "参数不完整（!villager_trade 村民id 序号 [次数]）";
                    const vt = Number(args[2]);
                    return await this.bridge.villagerTrade(args[0], Number(args[1]), Number.isFinite(vt) ? vt : 1);
                }
                default:
                    return `未知指令：${name}`;
            }
        }
        catch (err) {
            return `执行出错：${err instanceof Error ? err.message : String(err)}`;
        }
    }
    /** 收尾：更新状态、在游戏里播报总结。 */
    finish(runId, summary, terminal) {
        if (!this.isActive(runId))
            return;
        this.state.running = false;
        this.state.lastSummary = `${this.state.goal} —— ${summary}`;
        if (this.activeRunId && this.state.goal && this.state.startedAt) {
            this.storage.set(GOAL_RUN_RECORD_KEY, {
                runId: this.activeRunId,
                goal: this.state.goal,
                startedAt: this.state.startedAt,
                phase: "terminal",
                terminal: { ...terminal, at: Date.now() },
            });
        }
        this.abortController = null;
        this.activeRunId = null;
        this.log(`自主任务结束: ${this.state.lastSummary}`);
        // 断开连接时 say 会抛错，静默忽略即可
        try {
            this.bridge.say(`任务报告：${summary}`);
        }
        catch { /* 未连接时不播报 */ }
    }
}
exports.GoalRunner = GoalRunner;
