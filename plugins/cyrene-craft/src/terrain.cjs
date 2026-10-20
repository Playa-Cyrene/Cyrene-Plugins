"use strict";

/**
 * 地形感知（Terrain）—— 把「脚下这片地长什么样」变成可比较、可复用的指纹。
 *
 * ── 它补的是哪一段 ────────────────────────────────────────────────
 * doCollect 原来直接拿目标方块坐标去 GoalNear。树干悬在 y=136、
 * 人站在 y=127 时，寻路只能走到树下方，然后返回「到了位置但距离仍有 7.1 格」。
 *
 * 问题不在寻路器，在于没人告诉它「应该站到树的哪一边」。
 * 这一层负责三件事：
 *   1. 读高度矩阵，压成低分辨率指纹，回答「这是哪片地形」
 *   2. 找目标方块周围真正站得住的位置，回答「该站到哪」
 *   3. 沿路径找比两端明显高的列，回答「什么东西挡路」
 *
 * ── 为什么指纹用相对高度 ──────────────────────────────────────────
 * 绝对高度会把「同一片树林在不同海拔」判成两种地形。
 * 取全局高度中位数做基准，只记每格相对基准的高低差，换到同类型的
 * 山坡/树林仍然能认出来。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────
 * 纯函数，不碰 bot、不碰文件、不调模型。输入高度矩阵，输出结构。
 * 这样它可以在离线测试里被喂任意地形，也能被 autoplay / doCollect 共用。
 */

const {
  planAffordances,
  registerAffordance,
  listAffordances,
} = require("./affordances.cjs");

/** 默认降采样格数（9×9） */
const DEFAULT_CELLS = 9;
/** 相对高度编码范围：-3..4，映射成字符 '0'..'7' */
const MIN_DELTA = -3;
const MAX_DELTA = 4;
/** 指纹格式版本 */
const VERSION = 1;

function isNum(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * 取二维高度矩阵某个矩形区域的中位数，忽略 null。
 * 用中位数而不是平均值：树干、悬崖这类离群值不该把整片地形拉偏。
 */
function medianOf(heights, i0, i1, j0, j1) {
  const values = [];
  for (let i = i0; i < i1; i++) {
    const row = heights[i];
    if (!Array.isArray(row)) continue;
    for (let j = j0; j < j1; j++) {
      const v = row[j];
      if (isNum(v)) values.push(v);
    }
  }
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/**
 * 地形指纹。
 *
 * @param {Array<Array<number|null>>} heights 高度矩阵，heights[dz][dx]
 * @param {object} [opts]
 * @param {number} [opts.cells] 降采样格数，默认 9
 * @returns {string} `v1:9:012345678...`，空矩阵返回空串
 */
function fingerprint(heights, opts = {}) {
  if (!Array.isArray(heights) || !heights.length) return "";

  const n = heights.length;
  const cells = clamp(Math.floor(Number(opts.cells) || DEFAULT_CELLS), 3, 15);

  // 基准取全局中位数：同一片地形换个海拔还是同一个指纹
  const base = medianOf(heights, 0, n, 0, n);
  if (base === null) return "";

  const chars = [];
  for (let cy = 0; cy < cells; cy++) {
    const i0 = Math.floor((cy * n) / cells);
    const i1 = Math.max(i0 + 1, Math.floor(((cy + 1) * n) / cells));
    for (let cx = 0; cx < cells; cx++) {
      const j0 = Math.floor((cx * n) / cells);
      const j1 = Math.max(j0 + 1, Math.floor(((cx + 1) * n) / cells));

      const m = medianOf(heights, i0, i1, j0, j1);
      const delta = m === null ? 0 : clamp(Math.round(m - base), MIN_DELTA, MAX_DELTA);
      chars.push(String.fromCharCode(48 + delta - MIN_DELTA));
    }
  }

  return `v${VERSION}:${cells}:${chars.join("")}`;
}

/** 解析指纹；格式不认识返回 null */
function parseKey(key) {
  const m = /^v(\d+):(\d+):([0-7]+)$/.exec(String(key || ""));
  if (!m) return null;
  const values = [];
  for (const ch of m[3]) values.push(ch.charCodeAt(0) - 48);
  return { version: Number(m[1]), cells: Number(m[2]), values };
}

/**
 * 两片地形的相似度，0–1。
 *
 * 允许 1 格误差：草方块和小麦田差一格不该算两种地形。
 * 差 2 格只算半分，差 3 格以上直接不算。
 */
function similarity(a, b) {
  const pa = parseKey(a);
  const pb = parseKey(b);
  if (!pa || !pb) return 0;
  if (pa.cells !== pb.cells || pa.values.length !== pb.values.length) return 0;
  if (!pa.values.length) return 0;

  let score = 0;
  let maxDiff = 0;
  for (let i = 0; i < pa.values.length; i++) {
    const d = Math.abs(pa.values[i] - pb.values[i]);
    if (d === 0) score += 1;
    else if (d === 1) score += 0.8;
    else if (d === 2) score += 0.4;
    if (d > maxDiff) maxDiff = d;
  }

  // 局部断崖要压整体分：81 格里只有 1 格差 3 米，
  // 平均下来仍然 0.98，但那 1 格足以让路线完全不同。
  // 所以只要出现 3 格以上落差，整体再打折。
  if (maxDiff >= 4) score *= 0.7;
  else if (maxDiff >= 3) score *= 0.8;

  return score / pa.values.length;
}

/* ---------------------------- 地形查询 ---------------------------- */

/**
 * 取世界坐标处的地表高度。
 *
 * @param {object} terrain { heights, radius, origin:{x,z} }
 * @param {number} x
 * @param {number} z
 * @returns {number|null}
 */
function heightAt(terrain, x, z) {
  if (!terrain || !Array.isArray(terrain.heights) || !terrain.heights.length) return null;

  const radius = Number(terrain.radius);
  const origin = terrain.origin || {};
  if (!isNum(radius) || !isNum(origin.x) || !isNum(origin.z)) return null;

  const dz = Math.round(z) - Math.round(origin.z) + radius;
  const dx = Math.round(x) - Math.round(origin.x) + radius;
  if (dz < 0 || dx < 0) return null;

  const row = terrain.heights[dz];
  if (!Array.isArray(row) || dx >= row.length) return null;

  const h = row[dx];
  return isNum(h) ? h : null;
}

/**
 * 目标方块周围能站住的位置。
 *
 * 判断标准：这一列有地表，站上去之后头顶不是方块（这里用高度近似，
 * 真正的碰撞交给 pathfinder），并且站立点与目标的垂直差不超过 reach。
 *
 * @param {{x:number,y:number,z:number}} target 方块坐标
 * @param {object} terrain
 * @param {object} [opts]
 * @param {number} [opts.reach] 允许的垂直差，默认 3
 * @param {number} [opts.limit] 最多返回几个，默认 6
 * @returns {Array<{x:number,y:number,z:number,face:string,distance:number}>}
 */
function standPoints(target, terrain, opts = {}) {
  if (!target || !isNum(target.x) || !isNum(target.y) || !isNum(target.z)) return [];

  const reach = clamp(Number(opts.reach) || 3, 1, 8);
  const limit = clamp(Number(opts.limit) || 6, 1, 12);

  const out = [];
  const push = (x, y, z, face) => {
    const distance = Math.hypot(x - target.x, y - target.y, z - target.z);
    out.push({ x: Math.round(x), y: Math.round(y), z: Math.round(z), face, distance });
  };

  // 目标必须在已读取的地形范围内，否则站上去也无从判断
  const below = heightAt(terrain, target.x, target.z);
  if (below === null) return [];

  // 站在方块顶上：最直接，也最容易被 pathfinder 接受
  push(target.x, target.y + 1, target.z, "top");

  // 站在方块下方：只有目标悬空时才成立
  if (below < target.y - 1) {
    push(target.x, below + 1, target.z, "bottom");
  }

  // 四个水平方向：取该列地表，站上去够得到目标才算
  const sides = [
    [1, 0, "east"],
    [-1, 0, "west"],
    [0, 1, "south"],
    [0, -1, "north"],
  ];
  for (const [dx, dz, face] of sides) {
    const x = target.x + dx;
    const z = target.z + dz;
    const h = heightAt(terrain, x, z);
    if (h === null) continue;

    const y = h + 1;
    if (Math.abs(y - target.y) > reach) continue;
    push(x, y, z, face);
  }

  // 去重：同一列只留最近的那一个
  const seen = new Set();
  const unique = [];
  for (const p of out) {
    const key = `${p.x},${p.y},${p.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }

  // 距离相同时优先顶面：站到方块顶上能挖到它，水平面还要看朝向。
  const faceRank = (p) => (p.face === "top" ? 0 : p.face === "bottom" ? 1 : 2);
  unique.sort((a, b) => a.distance - b.distance || faceRank(a) - faceRank(b) || a.y - b.y);
  return unique.slice(0, limit);
}

/**
 * 沿 from→target 直线找明显高于两端的列。
 *
 * 这些就是「挡路的东西」：树干、墙、石头坡。
 * 不返回方块 id，因为 doHeight 只给高度；要挖什么由上层再 scan 确认。
 *
 * @returns {Array<{x:number,z:number,height:number,rise:number}>}
 */
function obstacles(terrain, from, target, opts = {}) {
  if (!from || !target) return [];

  const sample = clamp(Number(opts.sample) || 24, 4, 64);
  const riseLimit = Number(opts.riseLimit) || 2;

  const out = [];
  for (let i = 1; i < sample; i++) {
    const t = i / sample;
    const x = Math.round(from.x + (target.x - from.x) * t);
    const z = Math.round(from.z + (target.z - from.z) * t);
    const h = heightAt(terrain, x, z);
    if (h === null) continue;

    const expected = from.y + (target.y - from.y) * t;
    const rise = h - expected;
    if (rise >= riseLimit) {
      out.push({ x, z, height: h, rise: Math.round(rise * 10) / 10 });
    }
  }
  return out;
}

/* ---------------------------- 路线规划 ---------------------------- */

/**
 * 本地路线规划。
 *
 * 只做「候选策略」，不判断哪条一定走得通 —— 那是 pathfinder 和实际执行的活。
 * 上层按顺序试，哪条成功就把哪条记下来。
 *
 * @param {{x:number,y:number,z:number}} from 当前位置
 * @param {{x:number,y:number,z:number}} target 目标方块
 * @param {object} terrain
 * @param {object} [opts]
 * @param {boolean} [opts.allowPlace] 是否允许垫高，默认 true
 * @param {boolean} [opts.allowDig] 是否允许挖挡路，默认 true
 * @returns {{ok:boolean, terrainKey:string, approach:object|null, strategies:Array, obstacles:Array, reason?:string}}
 */
function planRoute(from, target, terrain, opts = {}) {
  const terrainKey = fingerprint(terrain && terrain.heights, opts);
  const points = standPoints(target, terrain, opts);

  if (!points.length) {
    return {
      ok: false,
      terrainKey,
      approach: null,
      strategies: [],
      obstacles: [],
      reason: "目标周围没有可站立面",
    };
  }

  const allowPlace = opts.allowPlace !== false;
  const allowDig = opts.allowDig !== false;

  // 先试水平面，再试顶面。树顶通常走不上去，代价里会加上惩罚。
  const ordered = [...points].sort(
    (a, b) => (a.face === "top" ? 1 : 0) - (b.face === "top" ? 1 : 0) || a.distance - b.distance,
  );

  const nearest = points[0];
  const dy = nearest.y - Math.floor(from.y);

  // 垫高基点选目标旁边的可站立面，不能选目标正下方 ——
  // 那一列通常就是树干本身，pathfinder 走不进去。
  const pillarBase = points.find((p) => p.face !== "top" && p.y <= nearest.y) || null;
  const pillarHeight = pillarBase ? nearest.y - pillarBase.y : dy;

  const blocks = obstacles(terrain, from, target, opts);

  // 把世界状态交给手段注册表，由它枚举所有可用策略并按代价排序。
  // 新手段只要 registerAffordance，不改这里。
  const strategies = planAffordances({
    from,
    target,
    terrain,
    opts,
    points,
    ordered,
    nearest,
    dy,
    pillarBase,
    pillarHeight,
    blocks,
    allowPlace,
    allowDig,
    inventory: Array.isArray(opts.inventory) ? opts.inventory : [],
    // 当前目标需要的方块永不拿来垫高 / 搭桥
    protectedItems: [
      ...(Array.isArray(opts.protectedItems) ? opts.protectedItems : []),
      ...(opts.targetBlock ? [String(opts.targetBlock)] : []),
    ],
    // 经验偏置：路线记忆 / 类脑决策给的历史成功率，形如 { pillar: 0.8 }
    bias: opts.bias && typeof opts.bias === "object" ? opts.bias : {},
    heightAt: (x, z) => heightAt(terrain, x, z),
  });

  return {
    ok: true,
    terrainKey,
    approach: nearest,
    strategies,
    obstacles: blocks,
  };
}

module.exports = {
  fingerprint,
  parseKey,
  similarity,
  heightAt,
  standPoints,
  obstacles,
  planRoute,
  registerAffordance,
  listAffordances,
  DEFAULTS: {
    cells: DEFAULT_CELLS,
    minDelta: MIN_DELTA,
    maxDelta: MAX_DELTA,
    version: VERSION,
  },
};
