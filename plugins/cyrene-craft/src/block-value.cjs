"use strict";

/**
 * 方块资源珍惜度（Block Value）
 *
 * 垫高、搭桥这类消耗性动作要先用「不值钱」的方块：
 *   0 级：泥土、圆石、沙砾、下界岩 —— 满地都是，优先烧
 *   1 级：木板、原木、脚手架 —— 能再加工，谨慎用
 *   2 级：玻璃、砖、羊毛 —— 需要加工，尽量少用
 *   3 级：铁块、金块、铜块 —— 矿物块，别拿来垫脚
 *   4 级：钻石块、绿宝石块、下界合金块 —— 硬需求素材，永不消耗
 *
 * 「当前目标需要的方块」由调用方通过 protectedItems 传进来，
 * 与珍惜度无关：目标要橡木原木时，即使原木只是 1 级也不能烧。
 */

const RULES = [
  {
    tier: 4,
    test: /^(diamond|emerald|netherite)_block$|^ancient_debris$|^netherite_scrap$/,
  },
  {
    tier: 3,
    test: /^(iron|gold|copper|lapis|redstone|quartz|amethyst)_block$/,
  },
  {
    tier: 0,
    test:
      /^(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|sand|red_sand|gravel|cobblestone|stone|andesite|diorite|granite|tuff|deepslate|calcite|netherrack|basalt|blackstone|soul_sand|soul_soil|clay|mud|packed_mud|snow_block|ice|packed_ice)$/,
  },
  {
    tier: 1,
    test: /(_planks|_log|_wood|scaffolding)$/,
  },
  {
    tier: 2,
    test: /^(glass|bricks|stone_bricks|terracotta|.*_terracotta|.*_wool|.*_concrete|.*_glass|.*_leaves)$/,
  },
];

/** 未知方块按 2 级保守处理，不当成免费材料 */
const DEFAULT_TIER = 2;

function valueOf(name) {
  const block = String(name || "");
  if (!block) return DEFAULT_TIER;

  for (const rule of RULES) {
    if (rule.test.test(block)) return rule.tier;
  }
  return DEFAULT_TIER;
}

function isProtected(name, protectedItems) {
  const block = String(name || "");
  if (!block) return false;
  return (protectedItems || []).some((item) => String(item || "") === block);
}

/**
 * 从背包里挑一块最适合消耗的方块。
 *
 * @param {Array<{name:string,count:number}>} inventory
 * @param {object} [opts]
 * @param {number} [opts.maxTier] 允许消耗的最高珍惜度，默认 2
 * @param {string[]} [opts.protectedItems] 当前目标需要的方块，永不消耗
 * @param {string} [opts.prefer] 优先使用的方块（比如脚手架）
 * @returns {{name:string,count:number,tier:number}|null}
 */
function pickConsumable(inventory, opts = {}) {
  const maxTier = Number.isFinite(opts.maxTier) ? opts.maxTier : 2;
  const protectedItems = opts.protectedItems || [];
  const prefer = opts.prefer ? String(opts.prefer) : "";

  const rows = (inventory || [])
    .filter((it) => it && it.name && (Number(it.count) || 0) > 0)
    .map((it) => ({
      name: String(it.name),
      count: Number(it.count) || 0,
      tier: valueOf(it.name),
    }))
    .filter((it) => it.tier <= maxTier && !isProtected(it.name, protectedItems));

  if (!rows.length) return null;

  if (prefer) {
    const hit = rows.find((it) => it.name === prefer);
    if (hit) return hit;
  }

  rows.sort((a, b) => a.tier - b.tier || b.count - a.count || a.name.localeCompare(b.name));
  return rows[0];
}

/** 背包里有没有能安全消耗的方块 */
function hasConsumable(inventory, opts = {}) {
  return Boolean(pickConsumable(inventory, opts));
}

module.exports = {
  DEFAULT_TIER,
  valueOf,
  isProtected,
  pickConsumable,
  hasConsumable,
};
