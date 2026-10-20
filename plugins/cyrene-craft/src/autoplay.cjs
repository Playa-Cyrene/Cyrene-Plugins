"use strict";

/**
 * 自主驱动（AutoPlayDriver）—— 让角色在没人说话的时候也继续活着。
 *
 * ── 它补的是哪一段 ────────────────────────────────────────────────
 * brain-loop 已经能「不用模型就算出下一步并执行」，但它是一次性的：
 * 谁调用它，它才跑。模型不调用，它就停在那里。
 *
 * 这一层把「调用」这件事本身也自动化：
 *   连接成功 → 起一个低频定时器 → 每 tick 只做一步 → 做完继续等下一 tick。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────
 * 1. **一次只做一步。**
 *    一步做完就让出事件循环，本能层、聊天、模型都有机会插进来。
 *    连跑八步会让人觉得角色「失控」，也很难在中途叫停。
 *
 * 2. **先问肌肉，再问图。**
 *    同一个局面重复出现时，肌肉记忆直接给答案；没有记忆才建图扩散。
 *    这是「越玩越熟」和「每次都从头想」的区别。
 *
 * 3. **所有闸门都是硬门禁。**
 *    血量、饥饿、玩家说话、正在执行任务、附近有人 —— 任一命中就不动。
 *    自主行动的价值在于「不添乱」，跑得多不是目标。
 *
 * ── 停止条件 ──────────────────────────────────────────────────────
 *   · 开关关闭 / 连接断开
 *   · 超过总运行预算（默认 30 分钟）
 *   · 连续 idleTicks 个 tick 都无事可做
 *   · 外部调用 stop()
 */

const { runLoop, judgeOutcome } = require("./brain-loop.cjs");
const { buildGraph, nextAction, nodeIdOf } = require("./skill-graph.cjs");
const {
  compileEpisode,
  suggestName,
  compileLesson,
  suggestLessonName,
} = require("./skill-compiler.cjs");
const { planGoal, isStepNeeded, stepToAction, formatPlan } = require("./goal-plan.cjs");
const terrainLib = require("./terrain.cjs");

/** 没配置时的冷启动序列：先看一眼，再试着砍几块木头 */
const DEFAULT_BOOTSTRAP = [
  { tool: "context", args: {} },
  { tool: "scan", args: { block: "oak_log", radius: 24 } },
  { tool: "collect", args: { block: "oak_log", count: 4 } },
];

const DEFAULTS = {
  tickMs: 1200,
  maxRuntimeMs: 30 * 60 * 1000,
  minHealth: 8,
  minFood: 6,
  yieldMs: 8000,
  nearPlayerPause: 6,
  idleTicks: 60,
  candidates: 4,
  maxTracePerMin: 40,
  compileAfter: 3,
  scanRadius: 16,
  /**
   * 某个动作失败后，多久之内不再选它。
   *
   * 实跑里 collect 会因为「目标在高处、寻路到不了」反复失败，
   * 而图仍然把它排在前面。没有这条冷却，角色会在同一个坑里空转到预算耗尽。
   */
  failCooldownMs: 30_000,
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * collect 的接近诊断：只抽排查需要的字段。
 * trace 只存摘要，别把工具完整返回（含方块列表）写进轨迹。
 */
function collectDetail(data) {
  if (!data || typeof data !== "object") return null;

  const out = {};
  if (data.terrainKey) out.terrainKey = String(data.terrainKey).slice(0, 80);
  if (data.strategy) out.strategy = String(data.strategy).slice(0, 24);
  // 工具与真实收益：类脑决策靠它们区分「空手白挖」和「换镐有效」。
  if (data.block) out.block = String(data.block).slice(0, 40);
  if (data.tool) out.tool = String(data.tool).slice(0, 40);
  if (data.drop) out.drop = String(data.drop).slice(0, 40);
  if (Number.isFinite(Number(data.gained))) out.gained = Number(data.gained);
  if (Number.isFinite(Number(data.mined))) out.mined = Number(data.mined);

  const reason = data.approachReason || data.reason;
  if (reason) out.reason = String(reason).slice(0, 200);

  if (data.approach && typeof data.approach === "object") {
    const { x, y, z } = data.approach;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      out.approach = { x, y, z };
    }
  }

  if (Array.isArray(data.tried) && data.tried.length) {
    out.tried = data.tried.slice(0, 8).map((item) => {
      const row = { kind: String((item && item.kind) || "?") };
      if (item && Number.isFinite(item.dist)) row.dist = item.dist;
      if (item && item.error) row.error = String(item.error).slice(0, 100);
      return row;
    });
  }

  return Object.keys(out).length ? out : null;
}

/**
 * 把 scan 的返回压成世界快照里的方块条目。
 *
 * gate 只认 name，所以 name 必须和 collect 的 args.block 一致；
 * distance / y / reachable 是给目标层判断可达性用的额外信息，
 * 多出来的字段不会干扰既有调用方。
 */
function hintOfScan(data) {
  if (!data || !data.block) return [];
  const list = Array.isArray(data.blocks) ? data.blocks : [];
  // 与 collect 的默认必达距离对齐：超过这个距离的目标不值得专门跑一趟
  const reach = 20;

  // 没有明细时只留种类。gate 需要知道「附近有这个方块」，
  // 目标层拿不到距离就按可达处理 —— 不能因为信息缺失就否定目标。
  if (!list.length) {
    return [
      {
        name: data.block,
        count: Math.max(1, Number(data.count) || 1),
        distance: null,
        y: null,
        reachable: true,
      },
    ];
  }

  return list.map((b) => {
    const distance = Number(b && b.distance);
    return {
      name: data.block,
      count: 1,
      distance: Number.isFinite(distance) ? distance : null,
      y: Number(b && b.y),
      reachable: Number.isFinite(distance) ? distance <= reach : true,
    };
  });
}

/**
 * 工具变体：类脑决策给的是「采什么」，具体拿什么工具由这里展开。
 *
 * 不写死方块→工具。背包里有什么工具就试什么，外加空手；
 * 每次执行都会进轨迹，下一轮由 skill-graph 的节点/边统计算出谁更划算。
 */
const TOOL_NAME_RE = /_(pickaxe|axe|shovel|hoe)$/;

/** 工具品质只用于「先试哪个」，不用于判断能不能挖。 */
const TOOL_TIER_RE = [
  [/^netherite_/, 6],
  [/^diamond_/, 5],
  [/^iron_/, 4],
  [/^golden_/, 3],
  [/^stone_/, 2],
  [/^wooden_/, 1],
];

function toolTier(name) {
  const text = String(name || "");
  for (const [re, tier] of TOOL_TIER_RE) {
    if (re.test(text)) return tier;
  }
  return 0;
}

function inventoryNames(inventory) {
  if (!inventory) return [];
  if (Array.isArray(inventory)) {
    return inventory
      .filter((it) => it && it.name && (Number(it.count) || 0) > 0)
      .map((it) => String(it.name));
  }
  if (typeof inventory === "object") {
    return Object.entries(inventory)
      .filter(([, count]) => Number(count) > 0)
      .map(([name]) => String(name));
  }
  return [];
}

/** 展开 collect/dig 的工具变体：空手 + 背包里最多两把工具。 */
function toolVariantsOf(candidate, world) {
  if (!candidate || (candidate.tool !== "collect" && candidate.tool !== "dig")) {
    return [candidate];
  }
  if (candidate.args && candidate.args.tool) return [candidate];

  const tools = inventoryNames(world && world.inventory)
    .filter((name) => TOOL_NAME_RE.test(name))
    .sort((a, b) => toolTier(b) - toolTier(a) || a.localeCompare(b))
    .slice(0, 2);

  const out = [
    {
      ...candidate,
      args: { ...(candidate.args || {}), tool: "barehand" },
      toolVariant: "barehand",
      score: Number(candidate.score) || 0,
    },
  ];

  for (const name of tools) {
    out.push({
      ...candidate,
      args: { ...(candidate.args || {}), tool: name },
      toolVariant: name,
      // 工具有一点点探索优先；跑过之后由图的成功率/效率接管。
      score: (Number(candidate.score) || 0) * 1.02,
    });
  }

  return out;
}

/**
 * 路线经验偏置：上次这条路线里哪些手段成功率高，这次优先它们。
 * 只把走过的 action 写进 bias，没试过的手段不受影响。
 */
function routeBias(route) {
  const entry = route && route.entry;
  const runs = Number(entry && entry.runs) || 0;
  if (!runs) return {};

  const rate = Math.max(0, Math.min(1, (Number(entry.ok) || 0) / runs));
  const bias = {};
  for (const step of (route && route.steps) || []) {
    const kind = step && step.action;
    if (kind) bias[kind] = rate;
  }
  return bias;
}

class AutoPlayDriver {
  /**
   * @param {object} opts
   * @param {object} opts.bridge            BotBridge
   * @param {object} [opts.trace]           TraceLogger
   * @param {() => object|null} [opts.getMuscle]
   * @param {() => object} opts.getSettings
   * @param {() => object|null} [opts.getSkillStore]
   * @param {object} [opts.skillRunner]
   * @param {(msg:string)=>void} [opts.log]
   * @param {(step:object)=>void} [opts.onStep] 每步回调（面板/日志用）
   */
  constructor(opts = {}) {
    this.bridge = opts.bridge;
    this.trace = opts.trace || null;
    this.getMuscle = opts.getMuscle || (() => null);
    this.getSettings = opts.getSettings || (() => ({}));
    this.getSkillStore = opts.getSkillStore || (() => null);
    this.getRouteMemory = opts.getRouteMemory || (() => null);
    /**
     * 目标层。返回 GoalTracker 实例或 null。
     *
     * 只作为候选排序的偏置接入 —— 类脑决策的图、能量、门禁都不改。
     * 拿不到就退回纯图扩散，行为和这一层存在之前完全一致。
     */
    this.getGoal = opts.getGoal || (() => null);
    this.skillRunner = opts.skillRunner || null;
    this.log = opts.log || (() => {});
    this.onStep = opts.onStep || (() => {});

    this.timer = null;
    this.running = false;
    this.busy = false;
    this.startedAt = 0;
    this.stoppedReason = "";

    /** 跨 tick 保留的「当前节点」：下一步要从这里接着走 */
    this.current = "";

    this.stepCount = 0;
    this.consecutiveSuccess = 0;
    this.idleStreak = 0;
    this.bootstrapIndex = 0;

    this.lastChatAt = 0;
    this.lastAction = null;
    this.lastActionAt = 0;
    this.lastError = null;
    this.lastSkipped = "";

    /** 最近一次 scan 得到的方块种类，给指纹用 */
    this.blockHint = null;
    /** 最近一次 scan 的完整条目（带距离与高度），给目标层判断可达性 */
    this.blockInfo = null;

    /** 规划用的附近工作台缓存（扫一次用一阵子） */
    this.nearbyBlocks = null;
    this.nearbyAt = 0;

    /** 规划用的容器内容缓存（开箱子有成本） */
    this.containers = null;
    this.containersAt = 0;

    /** 写图节流窗口 */
    this.traceTimes = [];
    /** 最近一次肌肉命中的 key，用于后续升级成技能 */
    this.lastMuscleKey = null;

    /** tool -> 解禁时间戳。失败过的动作在这之前不再参与决策 */
    this.failureCooldown = new Map();

    /** 自检对账 / 经验沉淀的可观测记录 */
    this.repairLog = [];
    this.lessonLog = [];
    this.lastSelfCheckAt = 0;
    /** lesson 签名 -> 最近一次尝试时间，避免同一段轨迹反复编译 */
    this.lessonSeen = new Map();
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  start(reason = "manual") {
    if (this.running) return this.snapshot();

    const settings = this.getSettings() || {};
    if (settings.autoplayEnabled !== true) {
      this.log("[autoplay] 开关没打开，不启动");
      return this.snapshot();
    }

    const tickMs = Math.max(250, num(settings.autoplayTickMs, DEFAULTS.tickMs));
    this.running = true;
    this.startedAt = Date.now();
    this.stoppedReason = "";
    this.idleStreak = 0;
    // 每次重新启动都从冷启动序列开头跑：
    // 断线重连、手动重启都该先看一眼世界，而不是接着上次的游标空转。
    this.bootstrapIndex = 0;

    this.timer = setInterval(() => {
      void this.tick();
    }, tickMs);
    if (this.timer.unref) this.timer.unref();

    this.log(`[autoplay] 启动（${reason}，${tickMs}ms/tick）`);
    return this.snapshot();
  }

  stop(reason = "manual") {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.running) {
      this.log(`[autoplay] 停止：${reason}`);
    }
    this.running = false;
    this.stoppedReason = reason;
    return this.snapshot();
  }

  /** 玩家说话时调用：让模型/反射层先处理，驱动暂停几个 tick */
  noteChat() {
    this.lastChatAt = Date.now();
  }

  snapshot() {
    const muscle = this.getMuscle();
    const goalTracker = this.getGoal();
    return {
      running: this.running,
      busy: this.busy,
      startedAt: this.startedAt || null,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      steps: this.stepCount,
      consecutiveSuccess: this.consecutiveSuccess,
      current: this.current || null,
      bootstrapIndex: this.bootstrapIndex,
      idleStreak: this.idleStreak,
      lastAction: this.lastAction,
      lastActionAt: this.lastActionAt || null,
      lastError: this.lastError,
      lastSkipped: this.lastSkipped,
      denied: [...this.#deniedTools()],
      stoppedReason: this.stoppedReason || null,
      muscle: muscle && typeof muscle.snapshot === "function" ? muscle.snapshot() : null,
      goal: goalTracker && typeof goalTracker.snapshot === "function" ? goalTracker.snapshot() : null,
      repairs: this.repairLog.slice(-10),
      lessons: this.lessonLog.slice(-10),
    };
  }

  /* ------------------------------ 主循环 ------------------------------ */

  /** 执行一个 tick。返回本步结果，供测试与面板使用 */
  async tick() {
    if (!this.running || this.busy) return null;

    this.busy = true;
    try {
      return await this.#tickOnce();
    } catch (e) {
      this.lastError = e && e.message ? e.message : String(e);
      this.log(`[autoplay] tick 异常：${this.lastError}`);
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** 手动跑一步（skill action=autoplay once） */
  async once() {
    if (this.busy) return { ok: false, reason: "正在执行上一步" };
    this.busy = true;
    try {
      return await this.#tickOnce({ manual: true });
    } catch (e) {
      return { ok: false, reason: e && e.message ? e.message : String(e) };
    } finally {
      this.busy = false;
    }
  }

  /**
   * 自检自修复：目标对账 + 清理失效黑名单 + 经验沉淀。
   *
   * 只编排现有层（goal / trace / skill-compiler / skill-store / muscle），
   * 不新开记忆库，也不调用模型。
   */
  async selfCheck({ apply = false } = {}) {
    const status = this.bridge.status();
    if (!status || status.state !== "connected") {
      return {
        ok: false,
        reason: "未连接服务器",
        checked: 0,
        repaired: [],
        findings: [],
        lessons: [],
        needsModel: false,
        changed: false,
      };
    }

    const world = this.#world(status);
    const goalTracker = this.getGoal();
    const repaired = [];
    const findings = [];

    // 1) 背包事实对账：已经拿到的东西，节点直接完成。
    if (goalTracker && typeof goalTracker.reconcile === "function") {
      const result = goalTracker.reconcile(world);
      for (const item of result.completed || []) {
        repaired.push({ ...item, at: Date.now() });
        this.repairLog.push({ ...item, at: Date.now() });
      }
      if (this.repairLog.length > 20) {
        this.repairLog.splice(0, this.repairLog.length - 20);
      }
    }

    // 2) 有了工具，之前「空手挖不动」的拉黑应该失效，允许重试。
    const cleared = this.#clearStaleToolBlocks(goalTracker, world);
    for (const item of cleared) findings.push({ kind: "unblocked", ...item });

    // 3) 失败 → 纠正 → 成功 的经验，编成技能。
    const lesson = this.#tryLesson({ apply });
    if (lesson) findings.push({ kind: "lesson", ...lesson });

    const current = goalTracker && typeof goalTracker.current === "function"
      ? goalTracker.current()
      : null;

    return {
      ok: true,
      checked: goalTracker && Array.isArray(goalTracker.goals) ? goalTracker.goals.length : 0,
      repaired,
      findings,
      lessons: lesson ? [lesson] : [],
      needsModel: Boolean(current && current.attempts >= 2 && current.progress === 0),
      changed: repaired.length > 0 || cleared.length > 0 || Boolean(lesson && lesson.saved),
    };
  }

  /** 背包里已经有工具时，清掉 collect/dig 的旧拉黑。 */
  #clearStaleToolBlocks(goalTracker, world) {
    const tools = inventoryNames(world && world.inventory).filter((name) =>
      TOOL_NAME_RE.test(name),
    );
    if (!tools.length) return [];

    const cleared = [];

    if (goalTracker && Array.isArray(goalTracker.goals)) {
      for (const goal of goalTracker.goals) {
        if (goal.status !== "active" && goal.status !== "pending") continue;
        if (!Array.isArray(goal.blockedActions) || !goal.blockedActions.length) continue;

        const before = goal.blockedActions.length;
        goal.blockedActions = goal.blockedActions.filter(
          (id) => !/^(collect|dig):/.test(String(id)),
        );
        if (goal.blockedActions.length !== before) {
          cleared.push({
            goal: goal.id,
            removed: before - goal.blockedActions.length,
            tools: tools.slice(0, 2),
          });
        }
      }
    }

    // 动作冷却也一起放开：之前是空手失败，现在手里有工具了。
    for (const tool of ["collect", "dig"]) this.failureCooldown.delete(tool);

    return cleared;
  }

  /** 从最近轨迹里找「失败→纠正→成功」，编成技能。 */
  #tryLesson({ apply = false } = {}) {
    if (!this.trace || typeof this.trace.snapshot !== "function") return null;

    const store = this.getSkillStore();
    if (!store || typeof store.save !== "function") return null;

    let lesson = null;
    try {
      lesson = compileLesson(this.trace.snapshot().slice(-60), {});
    } catch {
      return null;
    }
    if (!lesson) return null;

    const name = suggestLessonName(lesson);
    if (!name) return null;

    const block = lesson.source?.success?.args?.block || "";
    const tool = lesson.source?.success?.args?.tool || "";
    const signature = `${block}|${tool}`;
    const now = Date.now();
    const seen = this.lessonSeen.get(signature);
    if (seen && now - seen < 10 * 60_000) return null;
    this.lessonSeen.set(signature, now);

    if (store.get(name)) return { name, block, tool, saved: false, reason: "exists" };

    if (!apply) return { name, block, tool, saved: false, preview: true };

    try {
      store.save(name, { ...lesson, name });

      // 让它尽快进肌肉层：下一次同局面可以直接直出。
      const muscle = this.getMuscle();
      if (muscle && this.lastMuscleKey && typeof muscle.promote === "function") {
        muscle.promote(this.lastMuscleKey, name);
      }

      this.lessonLog.push({ at: now, name, block, tool, saved: true });
      if (this.lessonLog.length > 20) {
        this.lessonLog.splice(0, this.lessonLog.length - 20);
      }
      this.log(`[autoplay] 学到技能 ${name}（${block} + ${tool}）`);

      return { name, block, tool, saved: true };
    } catch (e) {
      this.log(`[autoplay] 经验沉淀失败（不影响继续跑）：${e.message}`);
      return { name, block, tool, saved: false, reason: e.message };
    }
  }

  async #tickOnce(ctx = {}) {
    const settings = this.getSettings() || {};

    if (settings.autoplayEnabled !== true && !ctx.manual) {
      this.stop("开关关闭");
      return { ok: false, reason: "开关关闭" };
    }

    const status = this.bridge.status();
    if (status.state !== "connected") {
      this.stop("连接断开");
      return { ok: false, reason: "连接断开" };
    }

    // 总预算：跑够就停，避免挂机一整晚
    const maxRuntime = num(settings.autoplayMaxRuntimeMs, DEFAULTS.maxRuntimeMs);
    // 用 >=：预算设成 0 的语义是「一步都不许跑」，不是「跑满 0 毫秒再说」
    if (this.startedAt && Date.now() - this.startedAt >= maxRuntime) {
      this.stop("达到运行预算");
      return { ok: false, reason: "达到运行预算" };
    }

    // ---- 硬门禁：任一命中就不动 ----
    if (status.currentTask) {
      return this.#skip(`正在执行：${status.currentTask}`);
    }

    if (typeof this.bridge.isRunning === "function" && !this.bridge.isRunning()) {
      // 进程都没了，没必要继续 tick
      this.stop("机器人进程已停止");
      return { ok: false, reason: "机器人进程已停止" };
    }

    const minHealth = num(settings.autoplayMinHealth, DEFAULTS.minHealth);
    if (num(status.health, 20) < minHealth) {
      return this.#skip(`血量 ${status.health} 低于 ${minHealth}`);
    }

    const minFood = num(settings.autoplayMinFood, DEFAULTS.minFood);
    if (num(status.food, 20) < minFood) {
      return this.#skip(`饥饿 ${status.food} 低于 ${minFood}`);
    }

    const yieldMs = num(settings.autoplayYieldMs, DEFAULTS.yieldMs);
    if (this.lastChatAt && Date.now() - this.lastChatAt < yieldMs) {
      return this.#skip("刚有人说话，先让人");
    }

    const nearPause = num(settings.autoplayNearPlayerPause, DEFAULTS.nearPlayerPause);
    if (nearPause > 0 && this.#playerNear(status, nearPause)) {
      return this.#skip(`附近 ${nearPause} 格内有玩家`);
    }

    const world = this.#world(status);
    const current = this.current || this.#inferCurrent();

    // 目标层：先按当前世界状态结算/补目标，再拿当前目标参与候选排序。
    // 目标层出问题只降级为「没有目标」，不该让自主驱动停摆。
    const goalTracker = this.getGoal();
    let goal = null;
    if (goalTracker && typeof goalTracker.refresh === "function") {
      try {
        goalTracker.refresh(world);
        goal = typeof goalTracker.current === "function" ? goalTracker.current() : null;
      } catch (e) {
        this.log(`[autoplay] 目标刷新失败（按无目标继续）：${e.message}`);
      }
    }

    // 自检：每 10 秒或每 5 步对一次账，顺便把新经验沉淀掉。
    // 只编排现有层，不调用模型；已知局面继续走图/肌肉。
    const nowMs = Date.now();
    if (nowMs - this.lastSelfCheckAt > 10_000 || this.stepCount % 5 === 0) {
      this.lastSelfCheckAt = nowMs;
      try {
        const report = await this.selfCheck({ apply: true });
        if (report.repaired.length) {
          this.log(`[autoplay] 自检补完成 ${report.repaired.length} 个目标节点`);
        }
      } catch (e) {
        this.log(`[autoplay] 自检失败（不影响继续跑）：${e.message}`);
      }
    }

    // 轨迹快照：目标直出与图扩散共用一条
    const rows = this.trace && typeof this.trace.snapshot === "function" ? this.trace.snapshot() : [];

    /**
     * 目标规划直出：优先于肌肉记忆。
     *
     * 肌肉记的是「这个局面下我习惯做什么」，目标记的是「现在要完成什么」。
     * 有明确目标时目标优先 —— 否则学过 craft oak_planks 之后，
     * 木镐目标会被肌肉一直挡在门外，attempts 永远停在 0。
     */
    const direct = await this.#goalNextAction(goal, world, settings);
    if (direct) {
      const outcome = await this.#execute(direct.tool, direct.args, settings);
      this.#afterStep({
        world,
        current,
        tool: direct.tool,
        args: direct.args,
        ok: outcome.ok,
        ms: outcome.ms,
        error: outcome.error,
        data: outcome.data || null,
        from: "goal",
      });
      return { ok: outcome.ok, via: "goal", tool: direct.tool, args: direct.args, error: outcome.error };
    }

    const muscle = this.getMuscle();
    const muscleOn = settings.autoplayMuscle !== false && muscle;

    // ---- 快路径：肌肉记忆 ----
    if (muscleOn) {
      const hit = muscle.recall({ world, current });
      if (hit) {
        this.lastMuscleKey = hit.key;
        const outcome = await this.#runMuscleHit(hit);
        this.#afterStep({
          world,
          current,
          tool: hit.tool,
          args: hit.args,
          ok: outcome.ok,
          ms: outcome.ms,
          error: outcome.error,
          data: outcome.data || null,
          from: `muscle:${hit.rate.toFixed(2)}`,
          skipRemember: hit.kind === "skill",
        });
        return { ok: outcome.ok, via: "muscle", ...outcome };
      }
    }

    // ---- 慢路径：图扩散 ----
    if (rows.length) {
      const graph = buildGraph(rows, { now: Date.now() });
      const result = await runLoop({
        graph,
        current,
        nextAction: (g, w, o) => this.#nextActionWithGoal(g, w, o, goal),
        getWorld: async () => world,
        execute: (tool, args) => this.#executeWithBookkeeping(tool, args, { world, current }),
        isConnected: () => this.bridge.status().state === "connected",
        opts: {
          maxSteps: 1,
          candidates: num(settings.autoplayCandidates, DEFAULTS.candidates),
          minSuccessRate: settings.autoplayMinSuccessRate,
          minSamples: settings.autoplayMinSamples,
          // 刚失败过的动作先别再选，给图和世界一点变化时间
          deny: this.#deniedTools(),
        },
      });

      if (result.steps.length) {
        const step = result.steps[0];
        this.current = result.finalCurrent || this.current;
        this.idleStreak = 0;
        return { ok: step.ok, via: "graph", tool: step.tool, args: step.args, error: step.error };
      }

      // 图给不出下一步：可能是图太稀疏，落到冷启动
      if (result.stopped && !/候选都不可执行|没有可执行的下一步/.test(result.stopped)) {
        this.lastSkipped = result.stopped;
      }
    }

    // ---- 冷启动：图里还没有边时，先做几个确定性的动作 ----
    return this.#bootstrap(settings, world, current);
  }

  /* ------------------------------ 执行 ------------------------------ */

  /**
   * 带目标偏置的下一步。
   *
   * 先让类脑决策照常算 —— 图、能量扩散、硬门禁全都不动，
   * 再对候选得分乘一个目标系数。目标只影响排序，不改变候选集合。
   *
   * 这么接的好处：出问题时能分清是谁的错。
   * 候选集合空了是图的事；候选都在、排序变了，才是目标层的事。
   */
  #nextActionWithGoal(graph, world, opts, goal) {
    const result = nextAction(graph, world, opts);
    if (!result || !Array.isArray(result.candidates) || !result.candidates.length) {
      return result;
    }

    const goalTracker = this.getGoal();
    const goalBias =
      goal && goalTracker && typeof goalTracker.bias === "function"
        ? (candidate) => goalTracker.bias(candidate)
        : () => 1;

    // 先展开工具变体，再乘目标偏置。
    // 图给的是「采什么」，工具由训练数据（图的节点/边统计）决定谁更划算。
    // 没有目标时也要展开：工具选择本身就是类脑决策的一部分。
    const expanded = [];
    for (const candidate of result.candidates) {
      const factor = goalBias(candidate);
      for (const variant of toolVariantsOf(candidate, world)) {
        expanded.push({
          ...variant,
          rawScore: candidate.score,
          score: variant.score * factor,
          goalBias: factor,
        });
      }
    }

    const reranked = expanded.sort((a, b) => b.score - a.score);

    return {
      ...result,
      pick: reranked[0] || null,
      candidates: reranked,
      goal: goal ? goal.id : null,
    };
  }

  /**
   * 目标规划：把「要做的东西」拆成「先做什么」，返回下一步。
   *
   * ── 和旧版直出的区别 ──────────────────────────────────────────────
   * 旧版只会把 craft 原样丢出去：做不出来就一直撞同一个失败。
   * 新版会先看缺什么 —— 缺工作台就做工作台，缺木板就做木板，
   * 缺原木就先去砍，箱子里有现成的就先去拿。
   *
   * 这就是玩家脑子里那段没写出来的常识。
   */
  async #goalNextAction(goal, world, settings) {
    if (!goal) return null;

    // 只接管 craft。采集目标不需要配方分解 ——
    // 让它照旧走图扩散，偏置才有地方使劲。
    if (goal.kind !== "craft") return null;

    let plan = goal.plan;

    // 没有计划，或上一条计划已经跑完 → 重新规划一次
    if (!plan || !Array.isArray(plan.steps) || plan.index >= plan.steps.length) {
      const planWorld = await this.#planWorld(world, settings);
      const fresh = planGoal(goal, planWorld);

      if (!fresh.ok) {
        // 缺原料：记下来，让目标层按失败处理，不必每 tick 重算一遍
        goal.plan = { steps: [], index: 0, missing: fresh.missing, reason: fresh.reason };
        this.lastError = fresh.reason;
        return null;
      }

      plan = goal.plan = { steps: fresh.steps, index: 0, missing: [], reason: null };

      if (fresh.steps.length) {
        this.log(`[autoplay] 规划 ${goal.id}：${formatPlan(fresh)}`);
      }
    }

    // 背包 / 附近方块变了的话，某些步骤可能已经多余
    while (plan.index < plan.steps.length) {
      if (isStepNeeded(plan.steps[plan.index], world)) break;
      plan.index += 1;
    }

    if (plan.index >= plan.steps.length) return null;

    const step = plan.steps[plan.index];
    const action = stepToAction(step);
    if (!action) {
      plan.index += 1;
      return null;
    }

    // place 需要坐标：放脚边一格
    if (action.tool === "place") {
      const spot = this.#placeSpot();
      if (!spot) return null;
      action.args = { ...action.args, ...spot };
    }

    // withdraw 带上容器坐标，省得执行时从头再找一遍
    if (action.tool === "container" && step.from) {
      action.args = { ...action.args, x: step.from.x, y: step.from.y, z: step.from.z };
    }

    return { tool: action.tool, args: action.args, step };
  }

  /**
   * 规划需要的外部信息：附近工作台 + 容器内容。
   *
   * 两者都带缓存 —— 每 tick 开一次箱子会拖慢整个循环，
   * 而方块和箱子在几十秒内很少变。
   */
  async #planWorld(world, settings) {
    const now = Date.now();
    const ttl = num(settings.autoplayPlanCacheMs, 30_000);

    if (!this.nearbyBlocks || now - this.nearbyAt > ttl) {
      this.nearbyBlocks = [];
      try {
        const table = await this.bridge.request("scan", {
          block: "crafting_table",
          radius: 8,
          limit: 1,
        });
        if (table && Number(table.count) > 0) {
          this.nearbyBlocks = [{ name: "crafting_table", count: 1, reachable: true }];
        }
      } catch {
        /* 扫不到就当没有 */
      }
      this.nearbyAt = now;
    }

    if (!this.containers || now - this.containersAt > ttl * 2) {
      this.containers = [];
      try {
        const box = await this.bridge.request("container", { action: "list", radius: 8 });
        if (box && Array.isArray(box.containers)) this.containers = box.containers;
      } catch {
        /* 没有箱子很正常 */
      }
      this.containersAt = now;
    }

    return {
      ...world,
      blocks: [...(Array.isArray(world.blocks) ? world.blocks : []), ...this.nearbyBlocks],
      containers: this.containers,
    };
  }

  /** 放方块的位置：脚边一格。放不下会由目标层记一次失败 */
  #placeSpot() {
    const pos = this.bridge.status().position;
    if (!pos) return null;
    return {
      x: Math.floor(Number(pos.x)) + 1,
      y: Math.floor(Number(pos.y)),
      z: Math.floor(Number(pos.z)),
    };
  }

  /** 肌肉命中：技能直接跑，动作走 bridge */
  async #runMuscleHit(hit) {
    const settings = this.getSettings() || {};

    if (hit.kind === "skill" && hit.name && this.skillRunner) {
      const startedAt = Date.now();
      let result;
      try {
        result = await this.skillRunner.run(hit.name, {});
      } catch (e) {
        result = { ok: false, error: e && e.message ? e.message : String(e) };
      }
      const ms = Date.now() - startedAt;
      const ok = Boolean(result && result.ok);

      if (this.trace && typeof this.trace.record === "function" && this.#allowTrace()) {
        try {
          this.trace.record({
            tool: "skill",
            args: { name: hit.name },
            ok,
            ms,
            origin: "skill",
            error: ok ? null : (result && (result.error || result.reason)) || "技能执行失败",
          });
        } catch {
          /* 轨迹写失败不影响执行 */
        }
      }

      if (!ok) this.log(`[autoplay] 肌肉技能 ${hit.name} 失败：${(result && result.error) || "未知"}`);
      // 技能执行没有工具返回体，目标进度只能按「跑成功一次」记
      return { ok, ms, error: ok ? null : (result && result.error) || null, data: null };
    }

    return this.#execute(hit.tool, hit.args, settings);
  }

  /** runLoop 调用的执行入口：执行 + 记账 */
  async #executeWithBookkeeping(tool, args, book) {
    const outcome = await this.#execute(tool, args, this.getSettings() || {});
    this.#afterStep({
      world: book.world,
      current: book.current,
      tool,
      args,
      ok: outcome.ok,
      ms: outcome.ms,
      error: outcome.error,
      data: outcome.data || null,
      from: "graph",
    });
    this.current = nodeIdOf(tool, args) || this.current;
    return outcome;
  }

  async #execute(tool, args, settings) {
    // collect 之前先问路线库：相似地形上走过一次，这次直接照着走
    const routeCtx = tool === "collect" ? await this.#prepareCollectRoute(args) : null;

    if (routeCtx && routeCtx.blocked) {
      return {
        ok: false,
        ms: 0,
        error: "这片地形 + 这个目标判定走不通",
        data: routeCtx,
      };
    }

    let reused = false;
    if (routeCtx && routeCtx.reused) {
      try {
        for (const step of routeCtx.steps) {
          await this.bridge.request(step.action, step.args, step.action);
        }
        reused = true;
      } catch (e) {
        this.log(`[autoplay] 路线复用失败，回落正常采集：${e.message}`);
      }
    }

    const startedAt = Date.now();
    let data = null;
    let ok = false;
    let error = null;

    // 路线经验偏置随本次 collect 一起下发给规划器：
    // 上次这条路线用 pillar 成功，这次 pillar 的代价就会被压低。
    const execArgs =
      routeCtx && routeCtx.bias && Object.keys(routeCtx.bias).length
        ? { ...args, bias: routeCtx.bias }
        : args;

    try {
      data = await this.bridge.request(tool, execArgs, tool);
      const verdict = judgeOutcome(data);
      ok = verdict.ok;
      error = verdict.error;
    } catch (e) {
      ok = false;
      error = e && e.message ? e.message : String(e);
    }

    const ms = Date.now() - startedAt;
    this.lastAction = tool;
    this.lastActionAt = Date.now();
    this.stepCount += 1;

    if (this.trace && typeof this.trace.record === "function" && this.#allowTrace()) {
      try {
        this.trace.record({
          tool,
          args: execArgs,
          ok,
          ms,
          origin: "autoplay",
          error: ok ? null : error,
          detail: collectDetail(data),
        });
      } catch {
        /* 轨迹是旁路，失败不打断执行 */
      }
    }

    // 路线记账：成功写路线，失败写负记忆
    if (routeCtx) this.#recordRoute(routeCtx, ok, data, ms, reused);

    return { ok, ms, error, data };
  }

  /**
   * collect 前置：找目标 → 算地形指纹 → 查负记忆 / 查路线。
   * 全程本地，不调模型。
   */
  async #prepareCollectRoute(args) {
    const routeMemory = this.getRouteMemory();
    if (!routeMemory || typeof routeMemory.recall !== "function") return null;
    if (!args || !args.block) return null;

    try {
      const scan = await this.bridge.request("scan", {
        block: args.block,
        radius: 16,
        limit: 1,
      });
      const target = scan && Array.isArray(scan.blocks) ? scan.blocks[0] : null;
      if (!target) return null;

      const terrain = await this.bridge.request("terrain", { radius: 16 });
      const terrainKey = terrainLib.fingerprint(terrain && terrain.heights, { cells: 9 });
      if (!terrainKey) return null;

      const goal = `collect:${args.block}`;

      if (routeMemory.isBlocked({ terrainKey, goal })) {
        return { blocked: true, terrainKey, goal, target };
      }

      const route = routeMemory.recall({ terrainKey, goal, targetPos: target });
      if (route) {
        return {
          reused: true,
          terrainKey,
          goal,
          target,
          entry: route.entry,
          steps: route.steps,
          similarity: route.similarity,
          // 这条路线过去用过的手段成功率，交给规划器调整代价
          bias: routeBias(route),
        };
      }

      return { terrainKey, goal, target };
    } catch (e) {
      this.log(`[autoplay] 路线查询失败，按普通采集继续：${e.message}`);
      return null;
    }
  }

  /** collect 后置：成功写路线，失败写负记忆 */
  #recordRoute(ctx, ok, data, ms, reused) {
    const routeMemory = this.getRouteMemory();
    if (!routeMemory || !ctx || !ctx.goal) return;

    const settings = this.getSettings() || {};
    const terrainKey = (data && data.terrainKey) || ctx.terrainKey;
    if (!terrainKey) return;

    try {
      if (!ok) {
        routeMemory.rememberBlocked({
          terrainKey,
          goal: ctx.goal,
          ttlMs: settings.routeBlockedTtlMs,
        });
        return;
      }

      // 本次成功用到的完整接近步骤：move / pillar / dig / jump 都算训练数据。
      // 路径复用成功时，ctx.steps 只是「上次记的那条」；本次实际成功的步骤更可信。
      const learnedSteps =
        data && Array.isArray(data.approachSteps) && data.approachSteps.length
          ? data.approachSteps
          : null;

      // 没走接近路线的成功采集不值得记：下次直接挖就行
      const approach =
        (data && data.approach) ||
        (learnedSteps && learnedSteps[0] && learnedSteps[0].args) ||
        (reused && ctx.steps && ctx.steps[0] && ctx.steps[0].args) ||
        null;
      if (!approach) return;

      const steps =
        learnedSteps ||
        (reused && ctx.steps ? ctx.steps : [{ action: "move", args: approach }]);

      routeMemory.remember({
        terrainKey,
        goal: ctx.goal,
        targetPos: ctx.target,
        approach,
        steps,
        ok: true,
        ms,
      });
    } catch (e) {
      this.log(`[autoplay] 路线记账失败（不影响执行）：${e.message}`);
    }
  }

  /** 一步结束后的共同记账：连续成功、目标进度、肌肉、技能固化 */
  #afterStep(step) {
    const settings = this.getSettings() || {};
    const { world, current, tool, args, ok, ms, error, from, skipRemember, data } = step;

    if (ok) {
      this.consecutiveSuccess += 1;
      this.idleStreak = 0;
      // 做成了就解除这个动作的冷却
      if (tool) this.failureCooldown.delete(tool);
    } else {
      this.consecutiveSuccess = 0;
      this.lastError = error || "执行失败";
      // 失败过的动作进冷却。没有这条，图会一直在同一个坑里推荐它
      const cooldown = num(settings.autoplayFailCooldownMs, DEFAULTS.failCooldownMs);
      if (cooldown > 0 && tool) {
        this.failureCooldown.set(tool, Date.now() + cooldown);
      }
    }

    this.lastSkipped = "";

    // 目标计划推进：这一步做成了才前进一步。
    // 必须在 noteStep 之前 —— 成品做完时 noteStep 会把目标标成 done，
    // 之后 current() 返回 null，就再也找不到 plan 了。
    if (ok && from === "goal") {
      const tracker = this.getGoal();
      const g = tracker && typeof tracker.current === "function" ? tracker.current() : null;
      if (g && g.plan && Number.isFinite(g.plan.index)) g.plan.index += 1;
    }

    // 目标进度回写：成功推进、失败拉黑。
    // 目标层是旁路，记账失败只 log，不影响正在跑的动作。
    const goalTracker = this.getGoal();
    if (goalTracker && typeof goalTracker.noteStep === "function") {
      try {
        goalTracker.noteStep({
          tool,
          args,
          ok,
          ms,
          error: error || null,
          data: data || null,
          at: Date.now(),
        });
      } catch (e) {
        this.log(`[autoplay] 目标记账失败（不影响执行）：${e.message}`);
      }
    }

    this.onStep({
      tool,
      args,
      ok,
      ms,
      error: error || null,
      from: from || null,
      at: Date.now(),
    });

    // 肌肉：技能命中不重复记；动作命中/图执行都要记
    if (!skipRemember && settings.autoplayMuscle !== false) {
      const muscle = this.getMuscle();
      if (muscle && typeof muscle.remember === "function") {
        muscle.remember({ world, current, tool, args, ok, ms });
      }
    }

    if (this.current && tool) {
      this.current = nodeIdOf(tool, args) || this.current;
    }

    // 连续成功够多：把这一段固化成技能
    const compileAfter = num(settings.autoplayCompileAfter, DEFAULTS.compileAfter);
    if (ok && this.consecutiveSuccess >= compileAfter) {
      this.#tryCompile();
      this.consecutiveSuccess = 0;
    }

    // 失败→纠正→成功：成功这一步落地后，看看能不能把经验编成技能。
    if (ok && (tool === "collect" || tool === "dig")) {
      const lesson = this.#tryLesson({ apply: true });
      if (lesson && lesson.saved) {
        this.log(`[autoplay] 经验已沉淀：${lesson.name}`);
      }
    }
  }

  /**
   * 把最近一段成功轨迹编译成技能。
   *
   * 失败只 log：固化是加分项，不该影响正在跑的自主行动。
   */
  #tryCompile() {
    if (!this.trace || typeof this.trace.latestCompilableEpisode !== "function") return null;

    const store = this.getSkillStore();
    if (!store || typeof store.save !== "function") return null;

    try {
      const episode = this.trace.latestCompilableEpisode(3);
      if (!episode) return null;

      const baseName = suggestName(episode);
      // 同名技能已经存在就不再重复造，避免每三成功一次就覆盖一次
      if (store.get(baseName)) return null;

      const skill = compileEpisode(episode, {
        name: baseName,
        description: "自主执行中连续成功的动作段，自动固化",
      });
      if (!skill) return null;

      // save(name, skill)：技能名单独传，skill 对象里没有 name 字段。
      store.save(baseName, skill);
      this.log(`[autoplay] 固化技能 ${baseName}（${episode.length} 步）`);

      // 肌肉条目升级：下次遇到同一局面直接整段跑
      const muscle = this.getMuscle();
      if (muscle && this.lastMuscleKey && typeof muscle.promote === "function") {
        muscle.promote(this.lastMuscleKey, skill.name);
      }
      return skill;
    } catch (e) {
      this.log(`[autoplay] 技能固化失败（不影响继续跑）：${e.message}`);
      return null;
    }
  }

  /* ------------------------------ 冷启动 ------------------------------ */

  async #bootstrap(settings, world, current) {
    const list = Array.isArray(settings.autoplayBootstrap) && settings.autoplayBootstrap.length
      ? settings.autoplayBootstrap
      : DEFAULT_BOOTSTRAP;

    // 找下一个「没做过、也不在冷却里」的步骤。
    // 被冷却挡住的直接跳过，否则刚失败的动作会被冷启动立刻再试一次。
    const denied = this.#deniedTools();
    let step = null;
    while (this.bootstrapIndex < list.length) {
      const candidate = list[this.bootstrapIndex];
      this.bootstrapIndex += 1;
      if (candidate && candidate.tool && !denied.has(candidate.tool)) {
        step = candidate;
        break;
      }
    }

    // 跑完一轮（或被冷却挡光）就进入等待，等图里有新边再继续
    if (!step) {
      this.idleStreak += 1;
      this.lastSkipped = "图里还没有下一步，等待世界变化";

      const idleTicks = num(settings.autoplayIdleTicks, DEFAULTS.idleTicks);
      if (this.idleStreak >= idleTicks) this.stop("长时间没有可做的事");
      return { ok: false, via: "idle", reason: this.lastSkipped };
    }

    const outcome = await this.#execute(step.tool, step.args || {}, settings);

    // scan 的结果留给世界快照：种类给指纹用，坐标和高度给目标层判断可达性
    if (step.tool === "scan" && outcome.ok && outcome.data) {
      const info = hintOfScan(outcome.data);
      this.blockInfo = info;
      this.blockHint = [...new Set(info.map((b) => b.name))];
    }

    this.#afterStep({
      world,
      current,
      tool: step.tool,
      args: step.args || {},
      ok: outcome.ok,
      ms: outcome.ms,
      error: outcome.error,
      data: outcome.data || null,
      from: "bootstrap",
    });

    return { ok: outcome.ok, via: "bootstrap", tool: step.tool, args: step.args || {}, error: outcome.error };
  }

  /* ------------------------------ 工具 ------------------------------ */

  /**
   * 当前还在冷却里的动作集合。
   * 顺手清掉已经过期的，避免 Map 越积越大。
   */
  #deniedTools() {
    const now = Date.now();
    const deny = new Set();
    for (const [tool, until] of this.failureCooldown) {
      if (until > now) deny.add(tool);
      else this.failureCooldown.delete(tool);
    }
    return deny;
  }

  #skip(reason) {
    this.lastSkipped = reason;
    return { ok: false, skipped: true, reason };
  }

  /**
   * 世界快照。
   *
   * blocks 带上 dy（相对脚底的高度差）：
   * 目标层用它判断「这个目标我现在够不够得到」，
   * skill-graph 的 gate 只认 name，多出来的字段不会干扰它。
   *
   * 够不着的条目直接不放进 blocks —— gate 看不到，自然挡掉。
   * 这是「高处目标」在目标层的处理方式：不生成做不到的目标，
   * 而不是让采集逻辑反复撞墙。
   */
  #world(status) {
    const meY = Number(status.position && status.position.y);

    const blocks = Array.isArray(this.blockInfo)
      ? this.blockInfo
          .filter((b) => b && b.reachable !== false)
          .map((b) => ({
            ...b,
            dy: Number.isFinite(meY) && Number.isFinite(Number(b.y))
              ? Math.round(Number(b.y) - meY)
              : null,
          }))
      : null;

    return {
      dimension: status.dimension,
      isDay: status.time ? status.time.isDay : undefined,
      health: status.health,
      food: status.food,
      oxygen: status.oxygen,
      inventory: status.inventory,
      blocks,
    };
  }

  /** 从轨迹推当前节点。失败记录不作为起点 —— 那件事没做成，位置没变 */
  #inferCurrent() {
    if (!this.trace || typeof this.trace.snapshot !== "function") return "";
    const rows = this.trace.snapshot();
    const last = [...rows]
      .reverse()
      .find(
        (r) =>
          r &&
          r.tool &&
          r.origin !== "skill" &&
          r.origin !== "reflex" &&
          !(r.origin === "autoplay" && r.ok === false),
      );
    return last ? nodeIdOf(last.tool, last.args) : "";
  }

  #playerNear(status, distance) {
    const me = status.position;
    if (!me) return false;

    for (const p of Array.isArray(status.players) ? status.players : []) {
      if (!p || p.isSelf || !p.position) continue;
      const dx = Number(p.position.x) - Number(me.x);
      const dy = Number(p.position.y) - Number(me.y);
      const dz = Number(p.position.z) - Number(me.z);
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) continue;
      if (Math.hypot(dx, dy, dz) <= distance) return true;
    }
    return false;
  }

  /** 写图节流：一分钟超过 maxTracePerMin 条就不再记 */
  #allowTrace() {
    const settings = this.getSettings() || {};
    const limit = num(settings.autoplayMaxTracePerMin, DEFAULTS.maxTracePerMin);
    if (limit <= 0) return true;

    const now = Date.now();
    this.traceTimes = this.traceTimes.filter((t) => now - t < 60_000);
    if (this.traceTimes.length >= limit) return false;

    this.traceTimes.push(now);
    return true;
  }
}

module.exports = {
  AutoPlayDriver,
  DEFAULTS,
  DEFAULT_BOOTSTRAP,
};
