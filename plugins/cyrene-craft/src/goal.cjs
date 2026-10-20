"use strict";

/**
 * 目标层（Goal）—— 可追踪的「要做的事」
 *
 * ── 它补的是哪一段 ────────────────────────────────────────────────
 * skill-graph 回答「下一步做什么」，但它的答案全部来自已经发生过的轨迹：
 * 没有轨迹就走冷启动，冷启动跑完就 idle，然后停。
 * 中间缺一样东西：一件「做完没有」的事。
 *
 * 这一层给自主驱动一个可完成的方向：
 *   1. 从世界状态差生成目标（缺木头、缺圆石）
 *   2. 维护目标的生命周期（pending → active → done / failed）
 *   3. 给类脑决策的候选排序加一个偏置，不改能量算法
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────
 * 1. **目标是偏置，不是覆盖。**
 *    图的扩散结果照旧，目标只在候选得分上乘一个系数。
 *    硬覆盖会让故障定位退回到「不知道是图算错了还是目标想错了」。
 *
 * 2. **完成判定只认工具已经返回的字段。**
 *    collect 的 mined / complete 就是现成的证据，
 *    不给任何工具新增协议字段。
 *
 * 3. **生成靠状态差，不靠猜。**
 *    每条规则都要能指出是哪个字段触发的；触发不了的规则不写。
 *
 * ── 为什么第一版不生成 craft 目标 ─────────────────────────────────
 * craft 在子进程里能执行，但没有注册成对外工具，轨迹里不会出现 craft 节点。
 * 生成一个图里没有候选的目标，等于给自己制造空转。
 * 等 craft 作为工具暴露、轨迹里能建出节点之后再加。
 */

const { nodeIdOf } = require("./skill-graph.cjs");
const { nextNode } = require("./goal-graph.cjs");

/** 目标状态 */
const GOAL_STATUS = {
  PENDING: "pending",
  ACTIVE: "active",
  DONE: "done",
  FAILED: "failed",
  ABANDONED: "abandoned",
};

/** 目标来源 */
const GOAL_SOURCE = {
  STATE: "state",
  GUIDE: "guide",
  MANUAL: "manual",
};

/** 优先级：数字越大越先做 */
const PRIORITY = {
  SURVIVAL: 100,
  TOOL: 70,
  MATERIAL: 40,
  EXPLORE: 10,
};

/** 偏置系数 */
const BIAS = {
  /** 直接推进当前目标 */
  RELATED: 2.0,
  /** 与目标无关，但不冲突 */
  NEUTRAL: 0.85,
  /** 这个动作已经为这个目标做成功过，没必要重复 */
  DONE_ACTION: 0.4,
  /** 这个动作在这个目标下失败过 */
  WRONG: 0.2,
};

/** 默认同时保留几个未完成目标 */
const DEFAULT_MAX_GOALS = 6;

/** 单个目标累计失败几次判失败 */
const DEFAULT_MAX_FAILURES = 3;

/** 失败目标多久之内不再重新生成 */
const DEFAULT_BLOCK_MS = 60_000;

/** 完成目标多久之内不重复生成（等背包/掉落物稳定） */
const DEFAULT_DONE_COOLDOWN_MS = 20_000;

/** 历史保留条数 */
const MAX_HISTORY = 20;

/** 步骤归因保留条数：面板看最近一段就够，不把内存当日志盘 */
const MAX_STEP_LOG = 100;

/* ---------------------------- 背包统计 ---------------------------- */

/**
 * 把各种形态的背包压成 name -> count。
 * 和 skill-graph 的 toCountMap 保持同一套输入约定：
 * Map / [{name,count}] / {name: count} 都认。
 */
function inventoryCounts(inventory) {
  const map = new Map();
  if (!inventory) return map;

  if (inventory instanceof Map) {
    for (const [k, v] of inventory) map.set(String(k), Number(v) || 0);
    return map;
  }

  if (Array.isArray(inventory)) {
    for (const it of inventory) {
      if (!it) continue;
      const name = it.name || it.item || it.id;
      if (!name) continue;
      map.set(String(name), (map.get(String(name)) || 0) + (Number(it.count) || 1));
    }
    return map;
  }

  if (typeof inventory === "object") {
    for (const [k, v] of Object.entries(inventory)) map.set(String(k), Number(v) || 1);
  }
  return map;
}

/** 匹配一组物品名的总数 */
function countMatching(inventory, pattern) {
  let total = 0;
  for (const [name, count] of inventoryCounts(inventory)) {
    if (pattern.test(name)) total += count;
  }
  return total;
}

/** 单个物品数量 */
function countOf(inventory, name) {
  return inventoryCounts(inventory).get(String(name)) || 0;
}

const PICKAXES = [
  "wooden_pickaxe",
  "stone_pickaxe",
  "iron_pickaxe",
  "golden_pickaxe",
  "diamond_pickaxe",
  "netherite_pickaxe",
];

function hasPickaxe(inventory) {
  const counts = inventoryCounts(inventory);
  return PICKAXES.some((name) => (counts.get(name) || 0) > 0);
}

/* ---------------------------- 生成规则 ---------------------------- */

/**
 * 状态差 → 候选目标。
 *
 * 只写「触发条件能明确指向一个采集目标」的规则。
 * 食物目标暂时不做：act eat 需要背包里已经有吃的，
 * 没有吃的就得先去打猎，执行链还没拼完整，生成了也是空转。
 */
const RULES = [
  {
    /**
     * 手停在半路：有木板有棍子，却没有镐。
     *
     * 这是真实跑出来的缺口 —— 背包 oak_planks×88、stick×4、零把镐，
     * 采集撞在高处又采不动石头，整个循环空转。
     *
     * 木镐需要工作台，目标层看不到工作台在哪。附近没有就会失败，
     * 失败记进 failures 并冷却 60 秒，由执行层下一次再试。
     */
    id: "tool_pickaxe",
    priority: PRIORITY.TOOL,
    when: (world) =>
      !hasPickaxe(world.inventory) &&
      countOf(world.inventory, "oak_planks") >= 3 &&
      countOf(world.inventory, "stick") >= 2,
    build: () => ({ kind: "craft", target: "wooden_pickaxe", count: 1 }),
  },
  {
    id: "material_wood",
    priority: PRIORITY.MATERIAL,
    when: (world) => countMatching(world.inventory, /_log$/) < 4,
    build: () => ({ kind: "collect", target: "oak_log", count: 4 }),
  },
  {
    id: "material_stone",
    priority: PRIORITY.MATERIAL,
    when: (world) => hasPickaxe(world.inventory) && countOf(world.inventory, "cobblestone") < 8,
    build: () => ({ kind: "collect", target: "cobblestone", count: 8 }),
  },
];

/* ---------------------------- 目标构造 ---------------------------- */

/** 目标 id：同一种事只应该有一个目标 */
function goalIdOf(spec) {
  return `${spec.kind}:${spec.target}`;
}

/**
 * 造一个目标。
 * 默认是 pending，由 tracker 选中后才变 active。
 */
function createGoal(spec = {}, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const count = Math.max(1, Number(spec.count) || 1);

  return {
    id: goalIdOf(spec),
    kind: String(spec.kind || "collect"),
    target: String(spec.target || ""),
    count,
    progress: 0,
    status: GOAL_STATUS.PENDING,
    priority: Number(spec.priority) || PRIORITY.MATERIAL,
    source: spec.source || GOAL_SOURCE.STATE,
    attempts: 0,
    failures: 0,
    createdAt: now,
    updatedAt: now,
    /** 结束（done / failed）的时刻，冷静期从这一刻算起 */
    finishedAt: null,
    /** 这个目标下成功过的动作 */
    completedActions: [],
    /** 这个目标下失败过的动作 */
    blockedActions: [],
  };
}

/* ---------------------------- 归属判断 ---------------------------- */

/**
 * 一个动作是不是在推进这个目标。
 *
 * 只认「动作本身就能直接产生目标物」的情况。
 * pickup 不算推进 collect —— 捡掉落物是采集的副产品，不是采集本身。
 */
function isRelated(goal, tool, args) {
  if (!goal) return false;
  const a = args && typeof args === "object" ? args : {};

  if (goal.kind === "collect") {
    return tool === "collect" && a.block === goal.target;
  }

  if (goal.kind === "obtain") {
    if (goal.target === "food") {
      return tool === "attack" || (tool === "act" && a.action === "eat");
    }
    return a.item === goal.target;
  }

  if (goal.kind === "craft") {
    return tool === "craft" && a.item === goal.target;
  }

  return false;
}

/**
 * 这一步为这个目标贡献了多少进度。
 *
 * collect 有 mined 就用 mined；没有就按「成功一次记一次」。
 * 不编数字：拿不到证据的时候按最小可信值推进。
 */
function gainOf(goal, data) {
  if (!goal) return 0;
  if (!data || typeof data !== "object") return 1;

  if (goal.kind === "collect") {
    const mined = Number(data.mined);
    if (Number.isFinite(mined) && mined >= 0) return mined;
    if (data.complete === true) return goal.count;
  }

  return 1;
}

/* ---------------------------- 状态推进 ---------------------------- */

/**
 * 用一步执行结果推进目标。
 *
 * 失败记在 failures 上，并把这个动作标进 blockedActions ——
 * 下一次选候选时它会被压到 0.2，而不是永远消失。
 * 环境会变（天亮了、有垫脚方块了），永久拉黑会错过这种变化。
 *
 * @returns {object} 同一个 goal 对象（原地更新，调用方自己决定要不要复制）
 */
function advanceGoal(goal, step = {}, opts = {}) {
  if (!goal) return goal;
  if (goal.status === GOAL_STATUS.DONE || goal.status === GOAL_STATUS.ABANDONED) return goal;

  const now = Number.isFinite(step.at) ? step.at : Date.now();
  const maxFailures = Number.isFinite(opts.maxFailures) ? opts.maxFailures : DEFAULT_MAX_FAILURES;

  const tool = step.tool;
  const args = step.args || {};
  if (!tool) return goal;

  goal.updatedAt = now;

  const related = isRelated(goal, tool, args);
  const actionId = nodeIdOf(tool, args);

  // 与目标无关的动作不进这个目标的账，避免失败次数被别的事污染
  if (!related) return goal;

  goal.attempts += 1;

  if (!step.ok) {
    goal.failures += 1;
    if (actionId && !goal.blockedActions.includes(actionId)) {
      goal.blockedActions.push(actionId);
      // 只留最近 8 条，避免长期运行把数组撑大
      if (goal.blockedActions.length > 8) goal.blockedActions.shift();
    }
    if (goal.failures >= maxFailures) {
      goal.status = GOAL_STATUS.FAILED;
      goal.finishedAt = now;
    }
    return goal;
  }

  const gain = gainOf(goal, step.data);
  goal.progress = Math.min(goal.count, goal.progress + gain);

  if (actionId && !goal.completedActions.includes(actionId)) {
    goal.completedActions.push(actionId);
    if (goal.completedActions.length > 8) goal.completedActions.shift();
  }

  // 成功一次就把这个动作从黑名单里放出来：它能做成，只是上次环境不对
  if (actionId) goal.blockedActions = goal.blockedActions.filter((x) => x !== actionId);

  if (goal.progress >= goal.count) {
    goal.status = GOAL_STATUS.DONE;
    goal.finishedAt = now;
  }

  return goal;
}

/* ---------------------------- 偏置 ---------------------------- */

/**
 * 给类脑决策的候选算一个偏置系数。
 *
 * 只乘系数，不重排内部字段，也不改能量。
 * 上层拿到 1.0 就说明目标层没有意见。
 */
function biasOf(goal, candidate) {
  if (!goal || goal.status !== GOAL_STATUS.ACTIVE) return 1;
  if (!candidate || !candidate.tool) return 1;

  const tool = candidate.tool;
  const args = candidate.args || {};
  const actionId = nodeIdOf(tool, args);

  if (actionId && goal.blockedActions.includes(actionId)) return BIAS.WRONG;
  if (actionId && goal.completedActions.includes(actionId)) return BIAS.DONE_ACTION;
  if (isRelated(goal, tool, args)) return BIAS.RELATED;

  return BIAS.NEUTRAL;
}

/* ---------------------------- 目标管理器 ---------------------------- */

/**
 * 目标管理器。
 *
 * 有状态，但只在内存里 —— 落盘由上层决定。
 * 这样离线测试可以直接 new 一个、喂假世界、断言状态转移。
 */
class GoalTracker {
  constructor(opts = {}) {
    this.goals = [];
    this.history = [];
    this.currentId = "";

    this.now = typeof opts.now === "function" ? opts.now : () => Date.now();
    this.maxGoals = Math.max(1, Number(opts.maxGoals) || DEFAULT_MAX_GOALS);
    this.maxFailures = Math.max(1, Number(opts.maxFailures) || DEFAULT_MAX_FAILURES);
    this.blockMs = Math.max(0, Number(opts.blockMs) || DEFAULT_BLOCK_MS);
    this.doneCooldownMs = Math.max(0, Number(opts.doneCooldownMs) || DEFAULT_DONE_COOLDOWN_MS);
    this.rules = Array.isArray(opts.rules) ? opts.rules : RULES;

    /**
     * 外部导入的目标图。
     * 图上「所有前置都完成」的节点会变成一条 goal，优先级高于状态差规则。
     */
    this.graphs = Array.isArray(opts.graphs) ? opts.graphs : [];
    /** graphName -> Set(nodeId) */
    this.graphDone =
      opts.graphDone instanceof Map ? opts.graphDone : new Map();
    /** 节点完成时的回调，交给上层落盘 */
    this.onNodeDone =
      typeof opts.onNodeDone === "function" ? opts.onNodeDone : null;
    /**
     * 目标变更通知：refresh / noteStep / setCurrent 之后调一次。
     * 面板靠它实时刷新；没有订阅者时就是空操作。
     */
    this.onChange =
      typeof opts.onChange === "function" ? opts.onChange : null;

    /**
     * 步骤归因：每一步执行推进了哪些目标。
     * 只留最近 MAX_STEP_LOG 条，面板按目标过滤即可。
     */
    this.stepLog = [];

    /**
     * 自检对账记录：哪些节点是靠背包事实补完成的。
     * 只保留最近 20 条，面板能看见「不是跑出来的，是对账补的」。
     */
    this.repairLog = [];

    /** 目标 id -> 解禁时间戳 */
    this.suppressed = new Map();
  }

  /** 当前目标（只返回 active 的） */
  current() {
    const goal = this.goals.find((g) => g.id === this.currentId);
    return goal && goal.status === GOAL_STATUS.ACTIVE ? goal : null;
  }

  /**
   * 按世界状态刷新目标列表。
   *
   * 顺序很重要：
   *   1. 先结算已完成/失败的目标（清当前指针、进历史、设冷静期）
   *   2. 再按规则补新目标
   *   3. 最后选一个 active
   *
   * 反过来的话，规则会看到「目标刚完成但背包还没更新」，
   * 立刻又造一个一模一样的目标。
   */
  refresh(world = {}) {
    const now = this.now();

    // 先对账，再结算。背包已经满足的目标不该继续挂在 active 上。
    this.reconcile(world);
    this.#settle(now);
    this.#generate(world, now);
    this.#generateFromGraphs(now);
    this.#select(now);

    const snap = this.snapshot();
    this.#emitChange(snap);
    return snap;
  }

  /**
   * 用背包事实对账：已经拿到的东西，目标节点直接完成。
   *
   * 只认精确物品名，不猜别名；manual 节点不动；没有 inventory 时不判。
   * 返回 { checked, completed, changed }，repeat 调用幂等。
   */
  reconcile(world = {}) {
    const inventory = world && world.inventory;
    if (!inventory) return { checked: 0, completed: [], changed: false };

    const now = this.now();
    const completed = [];

    const markDone = (goal, reason) => {
      goal.progress = goal.count;
      goal.status = GOAL_STATUS.DONE;
      goal.finishedAt = now;
      goal.updatedAt = now;
      // #completeNode 自己会跳过已落盘的节点，这里不要用 status 提前挡掉。
      if (goal.graphNodeId) this.#completeNode(goal, reason);
      completed.push({
        id: goal.id || `graph:${goal.graphName}:${goal.graphNodeId}`,
        graphName: goal.graphName || null,
        graphNodeId: goal.graphNodeId || null,
        target: goal.target,
        count: goal.count,
        reason,
      });
      this.repairLog.push({
        at: now,
        graphName: goal.graphName || null,
        graphNodeId: goal.graphNodeId || null,
        target: goal.target,
        reason,
      });
      if (this.repairLog.length > 20) {
        this.repairLog.splice(0, this.repairLog.length - 20);
      }
    };

    // 1) 图节点：背包里已有成品/原料，就补完成。
    for (const graph of this.graphs) {
      if (!graph || !Array.isArray(graph.nodes)) continue;
      const done = this.graphDone.get(graph.name) || new Set();

      for (const node of graph.nodes) {
        if (!node || !node.id || done.has(node.id)) continue;
        if (node.kind !== "collect" && node.kind !== "craft") continue;

        const target = String(node.recipe || node.id);
        const need = Math.max(1, Number(node.count) || 1);
        if (countOf(inventory, target) < need) continue;

        const goal = {
          id: `graph:${graph.name}:${node.id}`,
          kind: node.kind,
          target,
          count: need,
          progress: need,
          status: GOAL_STATUS.DONE,
          priority: Math.min(200, Number(node.priority) || 50),
          source: GOAL_SOURCE.GUIDE,
          title: node.title || null,
          graphName: graph.name,
          graphNodeId: node.id,
          finishedAt: now,
          updatedAt: now,
        };

        markDone(goal, "inventory");
        this.#pushHistory(goal);
        done.add(node.id);
        this.graphDone.set(graph.name, done);
      }
    }

    // 2) 已有的 active / pending 目标：背包数量够就直接完成。
    for (const goal of this.goals) {
      if (goal.status !== GOAL_STATUS.ACTIVE && goal.status !== GOAL_STATUS.PENDING) continue;
      if (goal.kind !== "collect" && goal.kind !== "craft" && goal.kind !== "obtain") continue;
      if (countOf(inventory, goal.target) < Math.max(1, Number(goal.count) || 1)) continue;

      markDone(goal, "inventory");
    }

    return { checked: this.goals.length, completed, changed: completed.length > 0 };
  }

  /** 通知订阅者目标变了。订阅者抛错不能把目标层带停 */
  #emitChange(snap) {
    if (!this.onChange) return;
    try {
      this.onChange(snap);
    } catch {
      /* 面板/日志掉线不影响目标推进 */
    }
  }

  /** 把一个已结束的目标移出活跃列表 */
  #settle(now) {
    const keep = [];

    for (const goal of this.goals) {
      if (goal.status === GOAL_STATUS.ACTIVE || goal.status === GOAL_STATUS.PENDING) {
        keep.push(goal);
        continue;
      }

      // DONE / FAILED：进历史，设冷静期，避免规则立刻重新生成。
      // 冷静期从「结束那一刻」算，不是从「被发现那一刻」算 ——
      // 否则一个早就完成的目标会被后来才发生的刷新无限续期。
      this.#pushHistory(goal);
      const finishedAt = Number.isFinite(goal.finishedAt) ? goal.finishedAt : now;
      if (goal.status === GOAL_STATUS.FAILED) {
        this.suppressed.set(goal.id, finishedAt + this.blockMs);
      } else if (goal.status === GOAL_STATUS.DONE) {
        this.suppressed.set(goal.id, finishedAt + this.doneCooldownMs);
      }
    }

    this.goals = keep;

    if (this.currentId && !this.goals.some((g) => g.id === this.currentId)) {
      this.currentId = "";
    }
  }

  #pushHistory(goal) {
    this.history.push({
      id: goal.id,
      kind: goal.kind,
      target: goal.target,
      count: goal.count,
      progress: goal.progress,
      status: goal.status,
      failures: goal.failures,
      at: this.now(),
    });

    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
  }

  /** 按规则补新目标 */
  #generate(world, now) {
    for (const rule of this.rules) {
      let hit = false;
      try {
        hit = Boolean(rule.when(world));
      } catch {
        // 规则自己报错就当没命中：世界字段缺失不该让整个驱动停摆
        hit = false;
      }
      if (!hit) continue;

      let spec = null;
      try {
        spec = rule.build(world);
      } catch {
        spec = null;
      }
      if (!spec || !spec.target) continue;

      const id = goalIdOf(spec);
      if (this.goals.some((g) => g.id === id)) continue;

      const until = this.suppressed.get(id);
      if (until && until > now) continue;

      this.goals.push(
        createGoal(
          { ...spec, priority: rule.priority },
          { now },
        ),
      );
      this.suppressed.delete(id);
    }

    if (this.goals.length > this.maxGoals) {
      this.goals.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
      this.goals = this.goals.slice(0, this.maxGoals);
    }
  }

  /**
   * 从目标图生成目标。
   *
   * 只放出「所有前置都完成、自己还没完成」的节点。
   * manual 节点是占位，不生成执行目标 —— 但会挡住它的下游，
   * 进度条会停在真正做得到的地方，不会假装已经打到末影龙。
   */
  #generateFromGraphs(now) {
    for (const graph of this.graphs) {
      if (!graph || !Array.isArray(graph.nodes)) continue;

      const done = this.graphDone.get(graph.name) || new Set();
      const next = nextNode(graph, done);
      if (!next) continue;
      if (next.kind === "manual") continue;

      const id = `graph:${graph.name}:${next.id}`;
      if (this.goals.some((g) => g.id === id)) continue;

      const until = this.suppressed.get(id);
      if (until && until > now) continue;

      const goal = createGoal(
        {
          kind: next.kind,
          target: next.recipe || next.id,
          count: 1,
          priority: Math.min(200, Number(next.priority) || 50),
          source: GOAL_SOURCE.GUIDE,
        },
        { now },
      );

      // 覆盖成图节点身份，避免和状态差目标重名
      goal.id = id;
      goal.title = next.title;
      goal.graphName = graph.name;
      goal.graphNodeId = next.id;

      this.goals.push(goal);
    }
  }

  /** 一个图节点完成：更新进度并通知上层落盘 */
  #completeNode(goal, reason = null) {
    if (!goal || !goal.graphNodeId) return;

    const done = this.graphDone.get(goal.graphName) || new Set();
    const already = done.has(goal.graphNodeId);
    done.add(goal.graphNodeId);
    this.graphDone.set(goal.graphName, done);

    // 已经落过盘的节点不再重复回调，避免同一节点写两次 history。
    if (already) return;

    if (this.onNodeDone) {
      try {
        this.onNodeDone(goal.graphName, goal.graphNodeId, {
          reason: reason || "step",
          goal,
        });
      } catch {
        // 落盘失败不影响内存里的进度
      }
    }
  }

  /** 选当前目标：已有 active 就保持，不每 tick 横跳 */
  #select(now) {
    const active = this.goals.find((g) => g.id === this.currentId && g.status === GOAL_STATUS.ACTIVE);
    if (active) return;

    const pending = this.goals
      .filter((g) => g.status === GOAL_STATUS.PENDING || g.status === GOAL_STATUS.ACTIVE)
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);

    if (!pending.length) {
      this.currentId = "";
      return;
    }

    const next = pending[0];
    next.status = GOAL_STATUS.ACTIVE;
    next.updatedAt = now;
    this.currentId = next.id;
  }

  /** 外部手动切换目标（测试与面板用） */
  setCurrent(id) {
    const goal = this.goals.find((g) => g.id === id);
    if (!goal) return false;

    for (const g of this.goals) {
      if (g.status === GOAL_STATUS.ACTIVE) g.status = GOAL_STATUS.PENDING;
    }
    goal.status = GOAL_STATUS.ACTIVE;
    goal.updatedAt = this.now();
    this.currentId = goal.id;
    this.#emitChange(this.snapshot());
    return true;
  }

  /**
   * 回写一步执行结果。
   * 遍历所有未结束的目标：一步可能同时推进多件事。
   *
   * 每一步都写进 stepLog（即使没有命中任何目标），
   * 面板才能看到「她走了这一步，但没有目标认领」这种空转。
   */
  noteStep(step = {}) {
    if (!step || !step.tool) return this.snapshot();

    const now = Number.isFinite(step.at) ? step.at : this.now();
    const row = { ...step, at: now };
    const related = [];

    for (const goal of this.goals) {
      if (goal.status !== GOAL_STATUS.ACTIVE && goal.status !== GOAL_STATUS.PENDING) continue;

      const hit = isRelated(goal, row.tool, row.args || {});
      const before = goal.status;
      advanceGoal(goal, row, { maxFailures: this.maxFailures });

      // 图节点刚完成：记进度，并通知上层落盘
      if (before !== GOAL_STATUS.DONE && goal.status === GOAL_STATUS.DONE) {
        this.#completeNode(goal);
      }

      if (hit) related.push(summarizeStepGoal(goal));
    }

    const approach = approachDiagOf(row.data);

    this.stepLog.push({
      at: now,
      tool: String(row.tool),
      args: row.args && typeof row.args === "object" ? { ...row.args } : {},
      ok: row.ok !== false,
      ms: Number(row.ms) || 0,
      origin: row.origin || "autoplay",
      goals: related,
      ...(approach ? { approach } : {}),
    });
    if (this.stepLog.length > MAX_STEP_LOG) {
      this.stepLog.splice(0, this.stepLog.length - MAX_STEP_LOG);
    }

    const snap = this.snapshot();
    this.#emitChange(snap);
    return snap;
  }

  /**
   * 给候选算偏置。没目标时恒为 1 —— 上层可以无脑调用。
   */
  bias(candidate) {
    return biasOf(this.current(), candidate);
  }

  snapshot() {
    const current = this.current();
    const counts = { active: 0, pending: 0, done: 0, failed: 0 };

    for (const goal of this.goals) {
      if (goal.status === GOAL_STATUS.ACTIVE) counts.active += 1;
      else if (goal.status === GOAL_STATUS.PENDING) counts.pending += 1;
    }
    for (const item of this.history) {
      if (item.status === GOAL_STATUS.DONE) counts.done += 1;
      else if (item.status === GOAL_STATUS.FAILED) counts.failed += 1;
    }

    return {
      current: current ? summarizeGoal(current) : null,
      goals: this.goals.map(summarizeGoal),
      history: this.history.slice(-5),
      /** 最近一步推进了什么：面板的步骤流直接读它 */
      recentSteps: this.stepLog.slice(-60),
      /** 自检对账补完成的目标：面板能区分「跑出来的」和「对账补的」 */
      repairs: this.repairLog.slice(-10),
      counts,
    };
  }
}

/** 步骤归因里的目标摘要：只留面板要显示的字段 */
function summarizeStepGoal(goal) {
  return {
    id: goal.id,
    kind: goal.kind,
    target: goal.target,
    title: goal.title || null,
    graphName: goal.graphName || null,
    graphNodeId: goal.graphNodeId || null,
    progress: goal.progress,
    count: goal.count,
    status: goal.status,
  };
}

/**
 * 采集接近诊断：只抽面板需要的字段。
 *
 * doCollect 在「走不到」和「到了但距离不够」时会读地形换接近面，
 * 返回 approachReason / tried / strategy。原样塞进 stepLog 太大，
 * 这里压成固定结构，让「每一步」能回答：她试了哪些面、卡在哪一条。
 */
function approachDiagOf(data) {
  if (!data || typeof data !== "object") return null;

  const diag = {};
  if (data.terrainKey) diag.terrainKey = String(data.terrainKey).slice(0, 80);
  if (data.strategy) diag.strategy = String(data.strategy).slice(0, 24);

  const reason = data.approachReason || data.reason;
  if (reason) diag.reason = String(reason).slice(0, 160);

  if (data.approach && typeof data.approach === "object") {
    const { x, y, z } = data.approach;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      diag.approach = { x, y, z };
    }
  }

  if (Array.isArray(data.tried) && data.tried.length) {
    diag.tried = data.tried.slice(0, 8).map((item) => {
      const row = { kind: String((item && item.kind) || "?") };
      if (item && Number.isFinite(item.dist)) row.dist = item.dist;
      if (item && item.error) row.error = String(item.error).slice(0, 80);
      return row;
    });
  }

  return Object.keys(diag).length ? diag : null;
}

/** 给外部看的干净副本 */
function summarizeGoal(goal) {
  return {
    id: goal.id,
    kind: goal.kind,
    target: goal.target,
    count: goal.count,
    progress: goal.progress,
    status: goal.status,
    priority: goal.priority,
    source: goal.source,
    /** 来自外部目标图时，标出图和节点 */
    title: goal.title || null,
    graphName: goal.graphName || null,
    graphNodeId: goal.graphNodeId || null,
    failures: goal.failures,
    attempts: goal.attempts,
    blockedActions: goal.blockedActions.slice(-3),
    /** 规划快照：能看到它打算怎么一步步做出来 */
    plan: goal.plan
      ? {
          steps: (goal.plan.steps || []).map((s) => `${s.kind}:${s.target}`),
          index: goal.plan.index,
          reason: goal.plan.reason || null,
        }
      : null,
  };
}

/** 一行短文本，给 prompt 注入用 */
function formatGoal(snapshot, maxLen = 80) {
  const current = snapshot && snapshot.current;
  if (!current) return "";

  const text = `${current.kind} ${current.target} ${current.progress}/${current.count}`;
  return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
}

module.exports = {
  GOAL_STATUS,
  GOAL_SOURCE,
  PRIORITY,
  BIAS,
  RULES,
  DEFAULT_MAX_GOALS,
  DEFAULT_MAX_FAILURES,
  DEFAULT_BLOCK_MS,
  DEFAULT_DONE_COOLDOWN_MS,
  inventoryCounts,
  countMatching,
  countOf,
  hasPickaxe,
  goalIdOf,
  createGoal,
  isRelated,
  gainOf,
  advanceGoal,
  biasOf,
  GoalTracker,
  summarizeGoal,
  formatGoal,
};
