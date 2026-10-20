"use strict";

/**
 * 手段注册表（Affordance Registry）
 *
 * 规划器不再写死 if 链。每个手段声明三件事：
 *   when(ctx)  -> boolean        当前世界能不能用
 *   cost(ctx)  -> number         大致代价，越小越先试
 *   plan(ctx)  -> variants[]     具体步骤；一个手段可以给多个候选
 *
 * planRoute 枚举所有 when 为真的手段，展开候选，按 cost 从低到高排序。
 * 加新手段只要 registerAffordance，不用改规划器本身。
 */

const {
  pickConsumable,
  isProtected,
} = require("./block-value.cjs");

const registry = [];

/** 注册一个手段 */
function registerAffordance(def) {
  if (!def || !def.id || typeof def.when !== "function" || typeof def.plan !== "function") {
    throw new Error("affordance 需要 id / when / plan");
  }

  registry.push({
    id: String(def.id),
    when: def.when,
    cost: typeof def.cost === "function" ? def.cost : () => 1,
    plan: def.plan,
  });

  return String(def.id);
}

/** 当前注册了哪些手段 */
function listAffordances() {
  return registry.map((item) => item.id);
}

/** 按当前世界状态枚举可用策略，cost 从低到高 */
function planAffordances(ctx) {
  const out = [];

  for (const item of registry) {
    let variants;
    try {
      if (!item.when(ctx)) continue;
      variants = item.plan(ctx);
    } catch {
      // 单个手段规划失败不影响其它手段
      continue;
    }

    if (!Array.isArray(variants)) continue;

    for (const v of variants) {
      if (!v || !Array.isArray(v.steps) || !v.steps.length) continue;

      const rawCost = Number.isFinite(v.cost) ? v.cost : item.cost(ctx);
      out.push({
        kind: item.id,
        approach: v.approach || ctx.nearest || null,
        steps: v.steps,
        cost: applyBias(item.id, Number.isFinite(rawCost) ? rawCost : 1, ctx),
      });
    }
  }

  out.sort((a, b) => a.cost - b.cost);
  return out;
}

function hasItem(inventory, name) {
  return (inventory || []).some(
    (it) => it && it.name === name && (Number(it.count) || 0) > 0,
  );
}

function span(from, target) {
  return Math.max(Math.abs(target.x - from.x), Math.abs(target.z - from.z));
}

/**
 * 经验偏置：上次这条路线里某个手段成功率越高，这次越优先。
 * bias 由上层从路线记忆 / 类脑决策传进来，形如 { pillar: 0.8, bridge: 0.3 }。
 * 只调整代价，不改变 when 门禁 —— 不安全的策略不会因为历史成功率高就复活。
 */
function applyBias(kind, cost, ctx) {
  const rate = Number(ctx && ctx.bias ? ctx.bias[kind] : NaN);
  if (!Number.isFinite(rate)) return cost;
  return Math.max(0.1, cost - Math.max(0, Math.min(1, rate)) * 2);
}

/* ------------------------------ 内置手段 ------------------------------ */

registerAffordance({
  id: "walk",
  when: (ctx) => Array.isArray(ctx.ordered) && ctx.ordered.length > 0,
  cost: (ctx) => (ctx.ordered[0] ? ctx.ordered[0].distance : 1),
  plan: (ctx) =>
    ctx.ordered.slice(0, 3).map((point) => ({
      approach: point,
      // 树顶那种顶面通常走不上去，排在水平面之后，
      // 不然会先耗一次 12 秒寻路超时。
      cost: point.distance + (point.face === "top" ? 10 : 0),
      steps: [{ action: "move", args: { x: point.x, y: point.y, z: point.z } }],
    })),
});

registerAffordance({
  id: "jump",
  when: (ctx) => ctx.dy === 2,
  cost: (ctx) => ctx.nearest.distance + 0.5,
  plan: (ctx) => [
    {
      approach: ctx.nearest,
      steps: [
        { action: "move", args: { x: ctx.nearest.x, y: ctx.nearest.y, z: ctx.nearest.z } },
        { action: "jump", args: {} },
      ],
    },
  ],
});

registerAffordance({
  id: "pillar",
  when: (ctx) =>
    ctx.allowPlace &&
    ctx.pillarHeight >= 2 &&
    Boolean(pickConsumable(ctx.inventory, { protectedItems: ctx.protectedItems })),
  cost: (ctx) => 2 + Math.min(8, ctx.pillarHeight),
  plan: (ctx) => {
    const anchor = ctx.pillarBase || ctx.nearest;
    const item = pickConsumable(ctx.inventory, { protectedItems: ctx.protectedItems });
    if (!item) return [];

    return [
      {
        approach: anchor,
        steps: [
          { action: "move", args: { x: anchor.x, y: anchor.y, z: anchor.z } },
          {
            action: "pillar",
            args: {
              height: Math.min(8, Math.max(1, ctx.pillarHeight)),
              item: item.name,
              protectedItems: ctx.protectedItems || [],
            },
          },
        ],
      },
    ];
  },
});

registerAffordance({
  id: "scaffold",
  // 脚手架能直接往上堆，但比泥土贵；用户要求优先烧无价值方块，
  // 所以它的代价略高于普通垫高，只在没有便宜方块时才轮到它。
  when: (ctx) =>
    ctx.allowPlace &&
    ctx.pillarHeight >= 2 &&
    hasItem(ctx.inventory, "scaffolding") &&
    !isProtected("scaffolding", ctx.protectedItems),
  cost: (ctx) => 2.5 + Math.min(8, ctx.pillarHeight),
  plan: (ctx) => {
    const anchor = ctx.pillarBase || ctx.nearest;
    return [
      {
        approach: anchor,
        steps: [
          { action: "move", args: { x: anchor.x, y: anchor.y, z: anchor.z } },
          {
            action: "pillar",
            args: {
              height: Math.min(8, Math.max(1, ctx.pillarHeight)),
              item: "scaffolding",
              protectedItems: ctx.protectedItems || [],
            },
          },
        ],
      },
    ];
  },
});

registerAffordance({
  id: "bridge",
  when: (ctx) =>
    ctx.allowPlace &&
    span(ctx.from, ctx.target) >= 2 &&
    Boolean(pickConsumable(ctx.inventory, { protectedItems: ctx.protectedItems })),
  cost: (ctx) => 3 + span(ctx.from, ctx.target),
  plan: (ctx) => {
    const item = pickConsumable(ctx.inventory, { protectedItems: ctx.protectedItems });
    if (!item) return [];

    const dx = ctx.target.x - ctx.from.x;
    const dz = ctx.target.z - ctx.from.z;
    return [
      {
        approach: ctx.nearest,
        steps: [
          {
            action: "bridge",
            args: {
              dx: Math.sign(dx) * Math.min(4, Math.round(Math.abs(dx))),
              dz: Math.sign(dz) * Math.min(4, Math.round(Math.abs(dz))),
              item: item.name,
              protectedItems: ctx.protectedItems || [],
            },
          },
          { action: "move", args: { x: ctx.nearest.x, y: ctx.nearest.y, z: ctx.nearest.z } },
        ],
      },
    ];
  },
});

registerAffordance({
  id: "dig",
  when: (ctx) => ctx.allowDig && Array.isArray(ctx.blocks) && ctx.blocks.length > 0,
  cost: (ctx) => 4 + ctx.blocks.length * 1.5,
  plan: (ctx) => [
    {
      approach: ctx.nearest,
      steps: [
        ...ctx.blocks
          .slice(0, 3)
          .map((b) => ({ action: "dig", args: { x: b.x, y: b.height, z: b.z } })),
        { action: "move", args: { x: ctx.nearest.x, y: ctx.nearest.y, z: ctx.nearest.z } },
      ],
    },
  ],
});

registerAffordance({
  id: "tunnel",
  // 朝目标方向挖开高出来的列：不只看直线上的挡路列，也处理侧面绕不过去的情况
  when: (ctx) => ctx.allowDig && typeof ctx.heightAt === "function",
  cost: (ctx) => 5,
  plan: (ctx) => {
    const dirX = Math.sign(ctx.target.x - ctx.from.x);
    const dirZ = Math.sign(ctx.target.z - ctx.from.z);
    if (!dirX && !dirZ) return [];

    const baseY = Math.floor(ctx.from.y);
    const steps = [];

    for (let i = 1; i <= 3; i += 1) {
      const x = Math.round(ctx.from.x + dirX * i);
      const z = Math.round(ctx.from.z + dirZ * i);
      const h = ctx.heightAt(x, z);
      if (h === null) continue;
      if (h > baseY + 1) steps.push({ action: "dig", args: { x, y: h, z } });
    }

    if (!steps.length) return [];

    steps.push({ action: "move", args: { x: ctx.nearest.x, y: ctx.nearest.y, z: ctx.nearest.z } });
    return [{ steps, cost: 5 + steps.length }];
  },
});

module.exports = {
  registerAffordance,
  listAffordances,
  planAffordances,
};
