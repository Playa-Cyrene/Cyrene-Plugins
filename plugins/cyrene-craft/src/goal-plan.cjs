"use strict";

/**
 * 目标规划层（Goal Plan）—— 把「要做的东西」拆成「先做什么」
 *
 * ── 它补的是哪一段 ────────────────────────────────────────────────
 * 目标层知道「现在要做一把木镐」，但不知道木镐需要工作台，
 * 也不知道工作台需要四块木板。它只会把 craft wooden_pickaxe 丢出去，
 * 失败了记一次 failure，然后重试 —— 这是机器的方式。
 *
 * 玩家的脑子里会自动过一遍：
 *   有工作台吗？没有 → 先做工作台
 *   有木板吗？没有 → 先做木板
 *   有原木吗？没有 → 先去砍
 *   箱子里有现成的吗？有 → 先去拿
 *
 * 这一层就是把这段常识写下来。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────
 * 1. **只规划，不执行。**
 *    输出是一串步骤，谁来跑由上层决定。这样能离线喂假背包断言顺序。
 *
 * 2. **缺料就停，不硬编步骤。**
 *    原料都备不齐时，成品步骤根本不进计划 —— 免得跑一半才发现白跑。
 *
 * 3. **资源优先级：背包 → 箱子 → 采集 / 制作。**
 *    箱子里的现成货比新做便宜，采集又比制作便宜。
 *    顺序错了会绕远路（比如明明有一箱木板还去砍树）。
 */

/** 从背包里数一个物品 */
function countOf(inventory, name) {
  const target = String(name);
  let total = 0;

  if (inventory instanceof Map) {
    return Number(inventory.get(target)) || 0;
  }

  if (Array.isArray(inventory)) {
    for (const it of inventory) {
      if (!it) continue;
      const n = it.name || it.item || it.id;
      if (n === target) total += Number(it.count) || 1;
    }
    return total;
  }

  if (inventory && typeof inventory === "object") {
    return Number(inventory[target]) || 0;
  }

  return 0;
}

/* ---------------------------- 配方知识 ---------------------------- */

/**
 * 配方表。
 *
 * requires 是「做一次需要的材料」，yields 是一次产出几个（默认 1）。
 * needsTable 表示这个配方要 3×3 工作台，没有就得先做一张。
 *
 * 只写当前会用到的一小撮。加新配方不改逻辑，往这里加一条就行。
 */
const RECIPES = {
  oak_planks: {
    needsTable: false,
    yields: 4,
    requires: [{ item: "oak_log", count: 1 }],
  },
  stick: {
    needsTable: false,
    yields: 4,
    requires: [{ item: "oak_planks", count: 2 }],
  },
  crafting_table: {
    needsTable: false,
    yields: 1,
    requires: [{ item: "oak_planks", count: 4 }],
  },
  chest: {
    needsTable: false,
    yields: 1,
    requires: [{ item: "oak_planks", count: 8 }],
  },
  furnace: {
    needsTable: false,
    yields: 1,
    requires: [{ item: "cobblestone", count: 8 }],
  },
  torch: {
    needsTable: false,
    yields: 4,
    requires: [
      { item: "coal", count: 1 },
      { item: "stick", count: 1 },
    ],
  },
  wooden_pickaxe: {
    needsTable: true,
    yields: 1,
    requires: [
      { item: "oak_planks", count: 3 },
      { item: "stick", count: 2 },
    ],
  },
  wooden_sword: {
    needsTable: true,
    yields: 1,
    requires: [
      { item: "oak_planks", count: 2 },
      { item: "stick", count: 1 },
    ],
  },
  stone_pickaxe: {
    needsTable: true,
    yields: 1,
    requires: [
      { item: "cobblestone", count: 3 },
      { item: "stick", count: 2 },
    ],
  },
};

/** 会挖矿需要的方块：没有对应工具就采不动 */
const NEEDS_PICKAXE = new Set(["cobblestone", "stone", "coal_ore", "iron_ore", "copper_ore"]);

/**
 * 能直接去采的方块。
 *
 * 没有配方的东西不一定是「搞不到」—— 木头、圆石、沙子都是走过去挖就行。
 * planner 认不出这一类的话，会把它当缺料直接放弃。
 */
const GATHERABLE = new Set([
  "oak_log",
  "spruce_log",
  "birch_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
  "cobblestone",
  "stone",
  "sand",
  "dirt",
  "gravel",
  "clay",
  "coal_ore",
  "iron_ore",
  "copper_ore",
  "wheat",
  "carrot",
  "potato",
  "beetroot",
  "sweet_berries",
  "melon_slice",
]);

/* ---------------------------- 环境查询 ---------------------------- */

/** 附近有没有某种方块（scan 结果） */
function hasBlockNearby(blocks, name) {
  if (!Array.isArray(blocks)) return false;
  const target = String(name);
  return blocks.some((b) => b && (b.name === target || b.block === target));
}

/** 容器里某物品的库存汇总 */
function containerStock(containers, item) {
  const target = String(item);
  let total = 0;
  let where = null;

  for (const c of Array.isArray(containers) ? containers : []) {
    if (!c) continue;
    for (const it of Array.isArray(c.items) ? c.items : []) {
      if (!it || it.name !== target) continue;
      total += Number(it.count) || 0;
      if (!where) where = c.position || null;
    }
  }

  return { total, where };
}

/* ---------------------------- 规划 ---------------------------- */

/**
 * 把目标拆成有序步骤。
 *
 * @param {object} goal   { kind, target, count }
 * @param {object} world  { inventory, blocks, containers }
 * @param {object} [opts] { depth, maxSteps }
 * @returns {{ok:boolean, steps:Array, missing:string[], reason:string|null}}
 */
function planGoal(goal, world = {}, opts = {}) {
  const steps = [];
  const missing = [];

  const depthLimit = Math.max(1, Number(opts.depth) || 4);
  const maxSteps = Math.max(1, Number(opts.maxSteps) || 14);

  const inventory = world.inventory;
  const blocks = world.blocks;
  const containers = world.containers;

  /**
   * 保证某样东西有 count 个。
   *
   * 顺序：背包已有 → 箱子有 → 自己做（先递归备料）。
   * 返回 false 表示这条路走不通，调用方不要 push 依赖它的步骤。
   */
  function ensure(item, count, depth) {
    if (steps.length >= maxSteps) return false;

    const need = Math.max(1, Number(count) || 1);
    const have = countOf(inventory, item);
    if (have >= need) return true;

    const lack = need - have;

    // 箱子里的现成货
    const stock = containerStock(containers, item);
    if (stock.total > 0) {
      steps.push({
        kind: "withdraw",
        target: item,
        count: Math.min(lack, stock.total),
        from: stock.where,
        reason: `箱子里有 ${item}`,
      });
      if (stock.total >= lack) return true;
      // 只够一部分，剩下的继续走制作
    }

    const recipe = RECIPES[item];
    if (!recipe) {
      // 没有配方但能直接采 —— 生成采集步骤，别当缺料放弃
      if (GATHERABLE.has(item)) {
        steps.push({
          kind: "collect",
          target: item,
          count: lack,
          reason: `采集 ${item}`,
        });
        return true;
      }
      missing.push(item);
      return false;
    }
    if (depth >= depthLimit) {
      missing.push(item);
      return false;
    }

    const times = Math.ceil(Math.max(0, lack - (stock.total || 0)) / (Number(recipe.yields) || 1))
      || 1;

    // 备料：任何一样备不齐就整条放弃，别留半截计划
    let ready = true;
    for (const req of recipe.requires) {
      if (!ensure(req.item, req.count * times, depth + 1)) ready = false;
    }
    if (!ready) return false;

    // 需要工作台但附近没有 → 先做一张再放下。
    // ensure 已经负责「做」，这里只补「放」，不然会生成两次 craft。
    if (recipe.needsTable && !hasBlockNearby(blocks, "crafting_table")) {
      if (!ensure("crafting_table", 1, depth + 1)) return false;
      steps.push({ kind: "place", target: "crafting_table", count: 1, reason: "放下工作台" });
    }

    steps.push({
      kind: "craft",
      target: item,
      count: Math.max(1, lack - (stock.total || 0)),
      reason: `制作 ${item}`,
    });

    return true;
  }

  // 采集类目标直接一步，不涉及配方
  if (goal && goal.kind === "collect") {
    const have = countOf(inventory, goal.target);
    const need = Math.max(1, Number(goal.count) || 1);
    if (have >= need) {
      return { ok: true, steps: [], missing: [], reason: null };
    }

    const stock = containerStock(containers, goal.target);
    if (stock.total >= need - have) {
      return {
        ok: true,
        steps: [{
          kind: "withdraw",
          target: goal.target,
          count: need - have,
          from: stock.where,
          reason: `箱子里有 ${goal.target}`,
        }],
        missing: [],
        reason: null,
      };
    }

    return {
      ok: true,
      steps: [{
        kind: "collect",
        target: goal.target,
        count: need - have,
        reason: `采集 ${goal.target}`,
      }],
      missing: [],
      reason: null,
    };
  }

  // craft 类：从成品往下递归
  const target = goal && goal.target;
  const need = Math.max(1, Number(goal.count) || 1);

  if (!target) {
    return { ok: false, steps: [], missing: [], reason: "目标没有产物名" };
  }

  ensure(target, need, 0);

  if (!steps.length && !missing.length && countOf(inventory, target) >= need) {
    return { ok: true, steps: [], missing: [], reason: null };
  }

  return {
    ok: missing.length === 0,
    steps,
    missing: [...new Set(missing)],
    reason: missing.length ? `还缺 ${[...new Set(missing)].join(" / ")}` : null,
  };
}

/* ---------------------------- 步骤判定 ---------------------------- */

/** 这一步现在还需要做吗（背包变了就跳过） */
function isStepNeeded(step, world = {}) {
  if (!step) return false;

  if (step.kind === "collect" || step.kind === "craft" || step.kind === "withdraw") {
    return countOf(world.inventory, step.target) < Math.max(1, Number(step.count) || 1);
  }

  if (step.kind === "place") {
    return !hasBlockNearby(world.blocks, step.target);
  }

  return true;
}

/** 把步骤压成工具调用。place 的坐标由调用方补 */
function stepToAction(step) {
  if (!step) return null;

  if (step.kind === "collect") {
    return { tool: "collect", args: { block: step.target, count: step.count } };
  }
  if (step.kind === "craft") {
    return { tool: "craft", args: { item: step.target, count: step.count } };
  }
  if (step.kind === "withdraw") {
    return { tool: "container", args: { action: "withdraw", item: step.target, count: step.count } };
  }
  if (step.kind === "place") {
    return { tool: "place", args: { block: step.target } };
  }
  return null;
}

/** 一行短文本，给面板和日志用 */
function formatPlan(plan, maxLen = 120) {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) {
    return plan && plan.reason ? plan.reason : "没有可执行的步骤";
  }

  const text = plan.steps
    .map((s) => `${s.kind}:${s.target}${s.count > 1 ? `×${s.count}` : ""}`)
    .join(" → ");

  return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
}

module.exports = {
  RECIPES,
  NEEDS_PICKAXE,
  countOf,
  hasBlockNearby,
  containerStock,
  planGoal,
  isStepNeeded,
  stepToAction,
  formatPlan,
};
