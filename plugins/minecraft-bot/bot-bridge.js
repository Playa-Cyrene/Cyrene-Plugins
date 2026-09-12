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
exports.BotBridge = void 0;
// 机器人子进程管理：spawn / 杀进程树 / JSON 行协议解析 / 崩溃自动重启。
// 子进程用 ELECTRON_RUN_AS_NODE 模式跑宿主自带的 Electron 二进制，
// 用户机器不需要安装 Node 也能用。
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const path = __importStar(require("node:path"));
const readline = __importStar(require("node:readline"));
/** 连接成功后存活超过该毫秒数，重启计数清零。 */
const STABLE_CONNECTION_MS = 60_000;
/** 意外退出后等多久自动重连。 */
const RESTART_DELAY_MS = 5_000;
/** 连续自动重启上限，超过后放弃并停在断开状态。 */
const MAX_RESTARTS = 3;
/** 等待服务器完成登录握手的超时。 */
const CONNECT_TIMEOUT_MS = 30_000;
/** inventory/players 这类快速查询的超时。 */
const QUERY_TIMEOUT_MS = 10_000;
/** collect 长任务的等待上限。 */
const COLLECT_TIMEOUT_MS = 10 * 60_000;
/** 生活技能（送物/睡觉/合成）的等待上限。 */
const SKILL_TIMEOUT_MS = 5 * 60_000;
/** 熔炼要逐件烧，上限放最宽。 */
const SMELT_TIMEOUT_MS = 10 * 60_000;
/** Windows 下递归杀掉进程树（mineflayer 自身不派生子进程，这里主要是保险）。 */
function killTree(pid) {
    return new Promise((resolve) => {
        (0, node_child_process_1.execFile)("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
    });
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
class BotBridge {
    log;
    state = "disconnected";
    child = null;
    opts = null;
    connectedAt = 0;
    restartCount = 0;
    userStopped = true;
    lastError;
    position;
    health;
    food;
    /** 子进程定期推送的背包快照（inventory_push 事件）。 */
    inventory = [];
    /** 最近反射行为环形记录（保留 5 条）。 */
    recentInstinct = [];
    recentChat = [];
    currentTask = null;
    /** 游戏聊天订阅者；频道适配器用它把游戏消息交给宿主调度器。 */
    chatListeners = [];
    /** 连接状态变化订阅者；频道适配器用它刷新自己的运行状态。 */
    stateListeners = [];
    /** 移动任务结果订阅者；自主循环用它等待寻路完成。 */
    taskResultListeners = [];
    /** 快速查询的等待表（reqId → waiter）。 */
    pendingResps = new Map();
    reqSeq = 0;
    /** collect 长任务等待器。 */
    collectWaiter = null;
    /** connect 调用方等待登录结果的 resolver。 */
    connectWaiter = null;
    connectRejecter = null;
    connectTimer = null;
    constructor(log) {
        this.log = log;
    }
    /** 订阅游戏聊天（玩家发言，不含机器人自己）。返回退订函数。 */
    onChat(fn) {
        this.chatListeners.push(fn);
        return () => {
            this.chatListeners = this.chatListeners.filter((f) => f !== fn);
        };
    }
    /** 订阅连接状态变化。返回退订函数。 */
    onStateChange(fn) {
        this.stateListeners.push(fn);
        return () => {
            this.stateListeners = this.stateListeners.filter((f) => f !== fn);
        };
    }
    /** 订阅移动任务结果（到达/失败/停止）。返回退订函数。 */
    onTaskResult(fn) {
        this.taskResultListeners.push(fn);
        return () => {
            this.taskResultListeners = this.taskResultListeners.filter((f) => f !== fn);
        };
    }
    notifyState() {
        for (const fn of [...this.stateListeners]) {
            try {
                fn(this.state);
            }
            catch { /* 订阅者异常不阻断其他通知 */ }
        }
    }
    notifyTaskResult(result) {
        for (const fn of [...this.taskResultListeners]) {
            try {
                fn(result);
            }
            catch { /* 订阅者异常不阻断其他通知 */ }
        }
    }
    /** 插件目录下随插件分发的 runtime 位置。 */
    defaultRuntimeEntry() {
        return path.join(__dirname, "runtime", "bot-runtime", "src", "index.mjs");
    }
    resolveRuntimeEntry(runtimePath) {
        const entry = runtimePath
            ? path.join(runtimePath, "src", "index.mjs")
            : this.defaultRuntimeEntry();
        if (!(0, node_fs_1.existsSync)(entry)) {
            throw new Error(`bot-runtime 未找到（${entry}）。请先在插件仓库执行 npm run install-dev 安装运行时`);
        }
        return entry;
    }
    status() {
        return {
            state: this.state,
            host: this.opts?.host,
            port: this.opts?.port,
            username: this.opts?.username,
            connectedAt: this.state === "connected" ? this.connectedAt : undefined,
            position: this.position,
            health: this.health,
            food: this.food,
            inventory: [...this.inventory],
            recentInstinct: [...this.recentInstinct],
            lastError: this.lastError,
            restartCount: this.restartCount,
            recentChat: [...this.recentChat],
            currentTask: this.currentTask,
        };
    }
    send(msg) {
        if (!this.child?.stdin?.writable)
            return false;
        try {
            this.child.stdin.write(JSON.stringify(msg) + "\n");
            return true;
        }
        catch {
            return false;
        }
    }
    /** 通用请求-响应：发指令并等待对应 reqId 的 resp。 */
    request(msg, timeoutMs = QUERY_TIMEOUT_MS) {
        if (this.state !== "connected") {
            return Promise.reject(new Error(`当前状态为 ${this.state}，请先连接服务器`));
        }
        const reqId = ++this.reqSeq;
        const waiter = {
            resolve: () => { },
            reject: () => { },
            timer: setTimeout(() => {
                this.pendingResps.delete(reqId);
                waiter.reject(new Error("查询超时"));
            }, timeoutMs),
        };
        const promise = new Promise((resolve, reject) => {
            waiter.resolve = resolve;
            waiter.reject = reject;
        });
        this.pendingResps.set(reqId, waiter);
        if (!this.send({ ...msg, reqId })) {
            clearTimeout(waiter.timer);
            this.pendingResps.delete(reqId);
            return Promise.reject(new Error("机器人子进程已不可写"));
        }
        return promise;
    }
    /** 查询背包物品。 */
    async getInventory() {
        const data = await this.request({ type: "inventory", reqId: 0 });
        return Array.isArray(data) ? data : [];
    }
    /** 查询在线玩家。 */
    async getPlayers() {
        const data = await this.request({ type: "players", reqId: 0 });
        return Array.isArray(data) ? data : [];
    }
    // ---------- 生活技能 ----------
    /** 吃东西；不指定物品则挑背包里第一个能吃的。 */
    async eat(item) {
        return String(await this.request({ type: "consume", reqId: 0, item }, SKILL_TIMEOUT_MS));
    }
    /** 把物品拿在手上。 */
    async equip(item) {
        return String(await this.request({ type: "equip", reqId: 0, item }));
    }
    /** 把物品递给玩家（会先走到对方跟前再丢）。 */
    async give(player, item, count) {
        return String(await this.request({ type: "give", reqId: 0, player, item, count }, COLLECT_TIMEOUT_MS));
    }
    /** 找最近的床睡觉。 */
    async sleep() {
        return String(await this.request({ type: "sleep", reqId: 0 }, SKILL_TIMEOUT_MS));
    }
    /** 合成物品。 */
    async craft(item, count) {
        return String(await this.request({ type: "craft", reqId: 0, item, count }, SKILL_TIMEOUT_MS));
    }
    /** 熔炼物品（需要附近有熔炉和燃料）。 */
    async smelt(item, count) {
        return String(await this.request({ type: "smelt", reqId: 0, item, count }, SMELT_TIMEOUT_MS));
    }
    /** 在指定坐标放方块。 */
    async place(x, y, z, block) {
        return String(await this.request({ type: "place", reqId: 0, x, y, z, block }, SKILL_TIMEOUT_MS));
    }
    /** 挖掉指定坐标的方块。 */
    async breakBlock(x, y, z) {
        return String(await this.request({ type: "break", reqId: 0, x, y, z }, SKILL_TIMEOUT_MS));
    }
    /** 自动建小屋（中心可选，默认脚下）。 */
    async buildShelter(x, z) {
        return String(await this.request({ type: "build_shelter", reqId: 0, x, z }, 15 * 60_000));
    }
    // ---------- 战斗 / 导航 / 农活 / 箱子 / 村民 ----------
    /** 攻击并击杀附近指定生物。 */
    async attack(mob, kill = true) {
        return String(await this.request({ type: "attack", reqId: 0, mob, kill }, SKILL_TIMEOUT_MS));
    }
    /** 主动捡拾范围内掉落物。 */
    async pickup(range) {
        return String(await this.request({ type: "pickup", reqId: 0, range }, SKILL_TIMEOUT_MS));
    }
    /** 使用最近的门（开门-穿过-关门）。 */
    async useDoor(x, y, z) {
        return String(await this.request({ type: "use_door", reqId: 0, x, y, z }, SKILL_TIMEOUT_MS));
    }
    /** 找最近的指定方块并走过去。 */
    async gotoBlock(block, range) {
        return String(await this.request({ type: "goto_block", reqId: 0, block, range }, SKILL_TIMEOUT_MS));
    }
    /** 向下挖指定格数（遇险自动停）。 */
    async digDown(distance) {
        return String(await this.request({ type: "dig_down", reqId: 0, distance }, SKILL_TIMEOUT_MS));
    }
    /** 回到地表。 */
    async goSurface() {
        return String(await this.request({ type: "go_surface", reqId: 0 }, SKILL_TIMEOUT_MS));
    }
    /** 原地等待若干秒（立即返回，到时自动解除）。 */
    async stay(seconds) {
        return String(await this.request({ type: "stay", reqId: 0, seconds }));
    }
    /** 丢掉物品（count 省略 = 全部）。 */
    async discard(item, count) {
        return String(await this.request({ type: "discard", reqId: 0, item, count }, SKILL_TIMEOUT_MS));
    }
    /** 翻土并播种。 */
    async tillSow(x, y, z, seed) {
        return String(await this.request({ type: "till_sow", reqId: 0, x, y, z, seed }, SKILL_TIMEOUT_MS));
    }
    /** 拿工具对最近的实体或方块使用。 */
    async useToolOn(tool, target) {
        return String(await this.request({ type: "use_tool_on", reqId: 0, tool, target }, SKILL_TIMEOUT_MS));
    }
    /** 把物品存进最近的箱子。 */
    async chestPut(item, count) {
        return String(await this.request({ type: "chest_put", reqId: 0, item, count }, SKILL_TIMEOUT_MS));
    }
    /** 从最近的箱子取物品。 */
    async chestTake(item, count) {
        return String(await this.request({ type: "chest_take", reqId: 0, item, count }, SKILL_TIMEOUT_MS));
    }
    /** 查看最近箱子的内容。 */
    async chestView() {
        return String(await this.request({ type: "chest_view", reqId: 0 }, SKILL_TIMEOUT_MS));
    }
    /** 激活最近的指定方块（按钮/拉杆等）。 */
    async activateBlock(block) {
        return String(await this.request({ type: "activate_block", reqId: 0, block }, SKILL_TIMEOUT_MS));
    }
    /** 查看村民交易列表（省略 id 看最近的）。 */
    async villagerTrades(id) {
        return String(await this.request({ type: "villager_trades", reqId: 0, id }, SKILL_TIMEOUT_MS));
    }
    /** 与村民交易（序号从 1 开始）。 */
    async villagerTrade(id, index, count) {
        return String(await this.request({ type: "villager_trade", reqId: 0, id, index, count }, SKILL_TIMEOUT_MS));
    }
    /** 切换胆小模式（见怪就逃、永不反击的人格开关）。 */
    async setCowardice(enabled) {
        return String(await this.request({ type: "set_cowardice", reqId: 0, enabled }, SKILL_TIMEOUT_MS));
    }
    /** 收集方块（长任务，最长等 10 分钟）；断开连接或 stop 会提前结束。 */
    collect(block, count) {
        if (this.state !== "connected") {
            return Promise.reject(new Error(`当前状态为 ${this.state}，请先连接服务器`));
        }
        if (this.collectWaiter) {
            return Promise.reject(new Error("已有收集任务进行中"));
        }
        const result = new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.collectWaiter = null;
                // 超时先发 stop 取消子进程侧任务，再返回失败
                this.send({ type: "stop" });
                resolve({ block, requested: count, ok: false, error: "收集超时（10 分钟）" });
            }, COLLECT_TIMEOUT_MS);
            this.collectWaiter = { resolve, timer };
        });
        if (!this.send({ type: "collect", block, count })) {
            // executor 里的赋值不参与外层类型窄化，此处必然非空，用断言取回
            const waiter = this.collectWaiter;
            this.collectWaiter = null;
            clearTimeout(waiter.timer);
            return Promise.reject(new Error("机器人子进程已不可写"));
        }
        return result;
    }
    settleCollect(result) {
        const waiter = this.collectWaiter;
        if (!waiter)
            return;
        this.collectWaiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve(result);
    }
    handleBotMessage(msg) {
        switch (msg.type) {
            case "connecting":
                this.state = "connecting";
                this.notifyState();
                break;
            case "connected":
                this.state = "connected";
                this.connectedAt = Date.now();
                this.inventory = [];
                this.log(`机器人已登录: ${msg.username}`);
                this.notifyState();
                this.settleConnect();
                break;
            case "connect_error": {
                // 连接阶段失败（DNS 解析失败、拒绝连接等）：
                // 属于配置类错误，重试无意义——记错误、杀子进程、立刻让 connect() 调用方收到失败
                this.lastError = `连接失败: ${msg.error}`;
                this.log(this.lastError);
                this.userStopped = true;
                const child = this.child;
                this.child = null;
                this.state = "disconnected";
                this.notifyState();
                if (child && child.exitCode === null && child.pid) {
                    void killTree(child.pid);
                }
                this.failConnect(new Error(this.lastError));
                break;
            }
            case "spawn":
                this.position = msg.position;
                this.health = msg.health;
                this.food = msg.food;
                break;
            case "chat":
                this.pushChat(msg.player, msg.message);
                break;
            case "health":
                this.health = msg.health;
                this.food = msg.food;
                break;
            case "position":
                this.position = msg.position;
                break;
            case "inventory_push":
                this.inventory = Array.isArray(msg.items) ? msg.items : [];
                break;
            case "instinct":
                this.recentInstinct.push({ action: msg.action, at: Date.now() });
                if (this.recentInstinct.length > 5)
                    this.recentInstinct.shift();
                this.log(`[本能] ${msg.action}`);
                break;
            case "death":
                this.log("机器人在游戏中死亡，等待重生");
                break;
            case "kicked":
                this.lastError = `被服务器踢出: ${msg.reason}`;
                this.log(this.lastError);
                break;
            case "end":
                if (msg.reason && !this.lastError)
                    this.lastError = msg.reason;
                this.inventory = [];
                this.recentInstinct = [];
                break;
            case "path_result":
                this.currentTask = msg.status === "arrived" ? null : this.currentTask;
                if (msg.status === "arrived") {
                    this.log(`任务完成: ${msg.task}${msg.position ? `，当前坐标 (${msg.position.map((n) => n.toFixed(1)).join(", ")})` : ""}`);
                }
                else if (msg.status === "failed") {
                    this.log(`任务失败: ${msg.task}（${msg.reason ?? "未知原因"}）`);
                }
                else {
                    this.log(`任务已停止: ${msg.task}`);
                }
                this.notifyTaskResult(msg);
                break;
            case "resp": {
                const waiter = this.pendingResps.get(msg.reqId);
                if (!waiter)
                    break;
                this.pendingResps.delete(msg.reqId);
                clearTimeout(waiter.timer);
                if (msg.ok)
                    waiter.resolve(msg.data);
                else
                    waiter.reject(new Error(msg.error));
                break;
            }
            case "collect_result":
                this.log(msg.ok
                    ? `收集完成: ${msg.block}（找到 ${msg.found ?? msg.requested} 个目标）`
                    : `收集失败: ${msg.block}（${msg.error ?? "未知错误"}）`);
                this.settleCollect(msg);
                break;
            case "log":
                this.log(`[bot] ${msg.message}`);
                break;
            case "say_result":
                // 结果只写日志；聊天发言不需要向工具调用方回执
                if (!msg.ok)
                    this.log(`发言失败: ${msg.error ?? "未知错误"}`);
                break;
        }
    }
    pushChat(player, message) {
        this.recentChat.push({ player, message, at: Date.now() });
        if (this.recentChat.length > 50)
            this.recentChat.shift();
        this.log(`[游戏聊天] ${player}: ${message}`);
        for (const fn of [...this.chatListeners]) {
            try {
                fn(player, message);
            }
            catch (err) {
                this.log(`聊天订阅者处理出错: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    /** 拉起子进程并发送 connect；返回登录完成后的状态快照。 */
    async connect(opts) {
        if (this.state !== "disconnected" || this.child) {
            throw new Error(`当前状态为 ${this.state}，请先断开现有连接`);
        }
        const entry = this.resolveRuntimeEntry(opts.runtimePath);
        this.opts = opts;
        this.userStopped = false;
        this.lastError = undefined;
        this.recentChat = [];
        this.child = (0, node_child_process_1.spawn)(process.execPath, [entry], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        const child = this.child;
        const rl = readline.createInterface({ input: child.stdout });
        rl.on("line", (line) => {
            const trimmed = line.trim();
            if (!trimmed)
                return;
            try {
                this.handleBotMessage(JSON.parse(trimmed));
            }
            catch {
                this.log(`[bot] ${trimmed.slice(0, 200)}`);
            }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            // mineflayer 的警告走 stderr，逐行透传，单行截断防刷屏
            for (const line of chunk.split("\n")) {
                const t = line.trim();
                if (t)
                    this.log(`[bot-stderr] ${t.slice(0, 200)}`);
            }
        });
        child.once("exit", (code) => this.onChildExit(code));
        // 等待 connected / 意外退出 / 超时 三者之一
        const settled = new Promise((resolve, reject) => {
            this.connectWaiter = resolve;
            this.connectRejecter = reject;
        });
        this.connectTimer = setTimeout(() => {
            this.failConnect(new Error(`连接超时（${CONNECT_TIMEOUT_MS / 1000} 秒内未完成登录）`));
        }, CONNECT_TIMEOUT_MS);
        if (!this.send({ type: "connect", host: opts.host, port: opts.port, username: opts.username })) {
            this.failConnect(new Error("无法向机器人子进程写入指令"));
        }
        try {
            await settled;
            return this.status();
        }
        finally {
            this.clearConnectTimer();
        }
    }
    settleConnect() {
        this.clearConnectTimer();
        const resolve = this.connectWaiter;
        this.connectWaiter = null;
        this.connectRejecter = null;
        resolve?.();
    }
    failConnect(err) {
        this.clearConnectTimer();
        const reject = this.connectRejecter;
        this.connectWaiter = null;
        this.connectRejecter = null;
        reject?.(err);
    }
    clearConnectTimer() {
        if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
        }
    }
    /** 子进程退出统一入口：区分用户主动断开与意外崩溃。 */
    onChildExit(code) {
        const wasConnecting = this.state === "connecting";
        const lived = this.state === "connected" && Date.now() - this.connectedAt >= STABLE_CONNECTION_MS;
        this.child = null;
        this.state = "disconnected";
        this.notifyState();
        this.failPendingWaiters("机器人子进程已退出");
        if (this.userStopped) {
            this.log("机器人子进程已退出（主动断开）");
            return;
        }
        // 连接存活足够久说明不是连不上的死循环，重启计数清零
        if (lived)
            this.restartCount = 0;
        if (wasConnecting) {
            this.failConnect(new Error(this.lastError ?? `机器人进程在连接阶段退出（code=${code}）`));
        }
        if (this.restartCount >= MAX_RESTARTS) {
            this.lastError = this.lastError ?? "连续自动重启达上限，已停止重试";
            this.log(`意外退出且已达自动重启上限（${MAX_RESTARTS} 次），停止重试`);
            return;
        }
        this.restartCount++;
        this.log(`机器人进程意外退出（code=${code}），${RESTART_DELAY_MS / 1000} 秒后自动重连（第 ${this.restartCount}/${MAX_RESTARTS} 次）`);
        void this.scheduleRestart();
    }
    /** 子进程死亡后让所有挂着的查询和收集立刻失败，不悬挂。 */
    failPendingWaiters(reason) {
        for (const [reqId, waiter] of this.pendingResps) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error(reason));
            this.pendingResps.delete(reqId);
        }
        const collectWaiter = this.collectWaiter;
        if (collectWaiter) {
            this.collectWaiter = null;
            clearTimeout(collectWaiter.timer);
            collectWaiter.resolve({ block: "?", requested: 0, ok: false, error: reason });
        }
    }
    async scheduleRestart() {
        await sleep(RESTART_DELAY_MS);
        if (this.userStopped || !this.opts || this.child)
            return;
        try {
            await this.connect(this.opts);
        }
        catch (err) {
            // 重连失败继续走 onChildExit 的退出路径；若子进程直接没起来，这里收尾状态
            this.log(`自动重连失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** 用户主动断开：通知子进程退出，超时强杀进程树。 */
    async disconnect() {
        this.userStopped = true;
        const child = this.child;
        if (!child)
            return this.status();
        this.send({ type: "shutdown" });
        const exited = new Promise((resolve) => child.once("exit", () => resolve()));
        const winner = await Promise.race([exited, sleep(5000)]);
        if (winner !== undefined || child.exitCode !== null) {
            // 已正常退出
        }
        else if (this.child === child) {
            await killTree(child.pid);
        }
        this.child = null;
        this.state = "disconnected";
        this.notifyState();
        return this.status();
    }
    /** 让机器人在游戏内发言；不等待服务器确认，结果经 say_result 事件回流日志。 */
    say(message) {
        if (this.state !== "connected") {
            throw new Error(`当前状态为 ${this.state}，无法发言`);
        }
        if (!this.send({ type: "say", message })) {
            throw new Error("机器人子进程已不可写");
        }
    }
    /** 走到指定玩家身边或坐标。 */
    moveTo(target) {
        this.assertConnected();
        const ok = this.send(target.player
            ? { type: "move_to", target: target.player }
            : { type: "move_to", x: target.x, y: target.y, z: target.z });
        if (!ok)
            throw new Error("机器人子进程已不可写");
        this.currentTask = target.player ? `走向 ${target.player}` : `走向 (${target.x}, ${target.y}, ${target.z})`;
    }
    /** 发起移动并等待 arrived/failed/stopped 终态，供无头目标工具使用。 */
    moveToAndWait(desc, start, timeoutMs = 180_000) {
        start();
        return new Promise((resolve) => {
            const off = this.onTaskResult((result) => {
                if (result.task !== desc)
                    return;
                clearTimeout(timer);
                off();
                if (result.status === "arrived") {
                    resolve(result.position ? `已到达，当前坐标 (${result.position.map((n) => n.toFixed(1)).join(", ")})` : "已到达");
                }
                else if (result.status === "failed") {
                    resolve(`移动失败：${result.reason ?? "未知原因"}`);
                }
                else {
                    resolve(`移动被中止：${result.reason ?? "未知原因"}`);
                }
            });
            const timer = setTimeout(() => {
                off();
                resolve("移动超时（3 分钟未见结果，可能仍在途中或卡住）");
            }, timeoutMs);
        });
    }
    /** 持续跟随指定玩家。 */
    follow(player) {
        this.assertConnected();
        if (!this.send({ type: "follow", target: player })) {
            throw new Error("机器人子进程已不可写");
        }
        this.currentTask = `跟随 ${player}`;
    }
    /** 停止当前移动/跟随/收集任务。 */
    stopTask() {
        this.assertConnected();
        if (!this.send({ type: "stop" })) {
            throw new Error("机器人子进程已不可写");
        }
        this.currentTask = null;
    }
    /** 连接状态守卫：未连接时移动类操作直接报错。 */
    assertConnected() {
        if (this.state !== "connected") {
            throw new Error(`当前状态为 ${this.state}，请先连接服务器`);
        }
    }
    /** 插件停用时的兜底清理：不等子进程自己退出，直接杀树。 */
    async dispose() {
        this.userStopped = true;
        const child = this.child;
        this.child = null;
        if (child && child.exitCode === null && child.pid) {
            await killTree(child.pid);
        }
        this.state = "disconnected";
        this.notifyState();
    }
}
exports.BotBridge = BotBridge;
