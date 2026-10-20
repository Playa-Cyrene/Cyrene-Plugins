"use strict";

/**
 * 类脑决策层（Brain Graph）—— SiFu 的无参形态
 *
 * ── 为什么要这一层 ────────────────────────────────────────────────
 * 现在「下一步做什么」只有两个来源：
 *   1. 大模型下发指令  —— 每次一个来回，慢，而且贵
 *   2. instincts.cjs   —— 只会保命反射（逃/吃/捡/插火把）
 *
 * 中间那一大片是空的：挖完木头该合成还是继续挖？背包快满了该回程
 * 还是先丢掉？手上没食物但附近有牛，走不走？
 * 这些今天全都要问模型。
 *
 * ── 借的是什么 ────────────────────────────────────────────────────
 * BriLLM 的 SiFu 机制里，去掉 torch 和权重之后，真正起作用的是三件事：
 *
 *   · 节点       = 可解释的动作单元（这里：技能 / 工具调用）
 *   · 边         = 动作之间的转移关系，带权重
 *   · 能量扩散   = 沿边传播，能量最大者成为下一步
 *
 * 这三件事全是算术。不需要 8.77 GB 权重，不需要 Python，不需要 GPU。
 * 边权从 trace.cjs 已经录好的真实轨迹里统计出来，跑得越多越准。
 *
 * 对应 BriLLM 的：
 *   e_{i+1} = GeLU(W · e_i + b + PE_i)      ← 这里退化成一维标量能量
 *   v = argmax ‖E‖                            ← 这里取能量最大的候选
 *
 * 区别在于：那边 W 是训练出来的矩阵，这边 W 是统计出来的边权。
 * 前者要 8 张 A800，后者要一份 jsonl。
 *
 * ── 设计纪律 ──────────────────────────────────────────────────────
 * 1. **只建议，不执行**。这一层输出「建议下一步」，交给上层决定要不要跑。
 *    直接执行会让调试变得极难——你分不清是图算错了还是动作本身有问题。
 * 2. **样本不够就说不够**。边权至少 2 次共现才给非零值，1 次只留痕。
 *    宁可推荐「没把握」，也不要拿一次偶然当规律。
 * 3. **硬门禁优先于能量**。前置条件不满足的节点，能量直接归零，
 *    不参与比较。挖矿要先有镐，这是事实，不是概率。
 */

/** 边权最低共现次数：低于这个值只记痕，不参与排序 */
const MIN_EDGE_SUPPORT = 2;

/** 能量扩散的衰减系数（每跳乘一次） */
const DEFAULT_DECAY = 0.55;

/** 最多扩散几跳 */
const DEFAULT_MAX_HOPS = 3;

/** 时间衰减半衰期：这么久之前的轨迹权重减半 */
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** 单节点能量上限，防止环形结构把能量算爆 */
const MAX_ENERGY = 1e6;

/** 一次最多返回几个候选 */
const DEFAULT_LIMIT = 4;

/**
 * 这些参数不参与节点身份判定。
 * 半径、数量、坐标这类东西变来变去，但它们仍然是「同一个动作」。
 * 如果把它们算进节点名，chop_oak(count=8) 和 chop_oak(count=16)
 * 会变成两个互不相干的节点，边永远连不起来。
 */
const VOLATILE_ARGS = new Set([
  "radius",
  "count",
  "maxDistance",
  "travelMs",
  "timeoutMs",
  "x",
  "y",
  "z",
  "ms",
]);

/**
 * 参与节点身份的参数。只有这些值不同才算不同动作。
 * 不在这个清单里的参数一律忽略，避免节点爆炸。
 */
const IDENTITY_ARGS = new Set(["block", "item", "player", "action", "target", "name", "tool"]);

/* ---------------------------- 节点身份 ---------------------------- */

/**
 * 把一个工具调用压成节点 id。
 *
 * collect { block: "oak_log", count: 8 }  ->  "collect:oak_log"
 * dig     { x: 10, y: 64, z: 3 }         ->  "dig"
 * move    { player: "Mori" }             ->  "move:player=Mori"
 *
 * 返回空串表示这条记录不该进图（比如纯查询类）。
 */
function nodeIdOf(tool, args) {
  if (typeof tool !== "string" || !tool) return "";

  const parts = [tool];
  const a = args && typeof args === "object" ? args : {};

  for (const key of IDENTITY_ARGS) {
    const v = a[key];
    if (v == null) continue;
    if (typeof v === "number" || typeof v === "boolean") {
      parts.push(`${key}=${v}`);
    } else if (typeof v === "string" && v && v.length <= 40) {
      parts.push(`${key}=${v}`);
    }
  }

  return parts.join(":");
}

/**
 * 只读类工具不进图：它们不改变世界，也就不构成「下一步该做什么」。
 *
 * skill / fs / 元工具也在这里，理由不同但结论一致：
 * 它们是「用来管理这套系统的」，不是「在 Minecraft 里做的事」。
 * 放进图的后果是真的会发生的 —— 实跑时 skill:action=trace 以 2.17 的
 * 能量高居榜首，执行环连跑四次查询自己的轨迹，一步都没走出原地。
 */
const READ_ONLY_TOOLS = new Set([
  // 查询类：看一眼，不改世界
  "status",
  "context",
  "players",
  "entities",
  "scan",
  "map",
  "height",
  "inventory",
  "events",
  "rules",
  "capabilities",
  "diag",
  "admin",
  "lan",
  "ping",
  "sessions",
  "accounts",
  "config",
  "express",
  // 元工具：管理这套插件本身，不是游戏里的动作。
  // 它们进图会真的坏事 —— 实跑时 skill:action=trace 以 2.17 能量高居榜首，
  // 执行环连跑四次查自己的轨迹，一步都没走出原地。
  "skill",
  "fs",
  "image",
  "watch",
  "instincts",
  "share",
]);

function isActionTool(tool) {
  return !READ_ONLY_TOOLS.has(tool);
}

/* ---------------------------- 建图 ---------------------------- */

/**
 * 从轨迹建立动作转移图。
 *
 * @param {Array<object>} records  轨迹记录数组，形如
 *   { ts, tool, args, ok, ms, origin }
 * @param {object} opts
 *   - episodeGapMs  间隔超过这个值就断开 episode（默认 15000）
 *   - now           当前时间，用于时间衰减（默认 Date.now()）
 * @returns {{nodes: Map, edges: Map, episodes: number, transitions: number}}
 */
function buildGraph(records, opts = {}) {
  const gapMs = opts.episodeGapMs || 15_000;
  const now = opts.now || Date.now();

  const nodes = new Map(); // id -> { id, tool, args, runs, success, fail, lastAt }
  const edges = new Map(); // "a\u0000b" -> { from, to, count, success, totalMs, lastAt }

  // 先把记录按时间排序，并且切 episode
  const sorted = [...records]
    .filter((r) => r && typeof r.tool === "string")
    .sort((x, y) => (x.ts || 0) - (y.ts || 0));

  let prevId = "";
  let prevTs = 0;
  let episodes = 0;
  let transitions = 0;

  for (const r of sorted) {
    // 技能执行产生的轨迹不参与建图：那是我们自己编出来的路径，
    // 拿它去引导下一次决策会形成自我强化循环。
    if (r.origin === "skill") {
      prevId = "";
      continue;
    }

    const id = nodeIdOf(r.tool, r.args);
    if (!id || !isActionTool(r.tool)) {
      // 只读工具不建节点，但 episode 不因它断开——
      // 中间插一次 scan 再挖矿，仍然是同一件事的两个动作。
      continue;
    }

    const ts = Number(r.ts) || 0;
    const gap = prevId ? ts - prevTs : Infinity;
    const newEpisode = gap > gapMs;

    // 记录节点
    let node = nodes.get(id);
    if (!node) {
      node = {
        id,
        tool: r.tool,
        args: r.args && typeof r.args === "object" ? { ...r.args } : {},
        runs: 0,
        success: 0,
        fail: 0,
        totalMs: 0,
        totalGain: 0,
        lastAt: 0,
      };
      nodes.set(id, node);
    }
    node.runs += 1;
    if (r.ok) node.success += 1;
    else node.fail += 1;
    if (Number.isFinite(r.ms) && r.ms >= 0) node.totalMs += r.ms;
    const gain = Number(r && r.detail && r.detail.gained);
    if (Number.isFinite(gain) && gain > 0) node.totalGain += gain;
    if (ts > node.lastAt) node.lastAt = ts;

    // 记录转移
    if (prevId && !newEpisode && prevId !== id) {
      const key = `${prevId}\u0000${id}`;
      let edge = edges.get(key);
      if (!edge) {
        edge = {
          from: prevId,
          to: id,
          count: 0,
          success: 0,
          totalMs: 0,
          totalGain: 0,
          lastAt: 0,
          autoplay: 0,
        };
        edges.set(key, edge);
      }
      edge.count += 1;
      edge.totalMs += Number(r.ms) || 0;
      const edgeGain = Number(r && r.detail && r.detail.gained);
      if (Number.isFinite(edgeGain) && edgeGain > 0) edge.totalGain += edgeGain;
      if (r.ok) edge.success += 1;
      // 记下有多少次是自主驱动自己选的，边权要对这部分打折
      if (r.origin === "autoplay") edge.autoplay += 1;
      if (ts > edge.lastAt) edge.lastAt = ts;
      transitions += 1;
    }

    if (newEpisode) episodes += 1;
    prevId = id;
    prevTs = ts;
  }

  // 把边权算出来挂回去
  for (const edge of edges.values()) {
    edge.weight = edgeWeight(edge, now);
  }

  return { nodes, edges, episodes, transitions, builtAt: now };
}

/**
 * 边权 = 共现频率 × 目标成功率 × 时间新鲜度
 *
 * 用对数压一下 count，否则跑得多的那条边会独裁，
 * 图就退化成「永远推荐最常做的那件事」。
 */
function edgeWeight(edge, now) {
  if (!edge || edge.count < MIN_EDGE_SUPPORT) return 0;

  const freq = Math.log1p(edge.count); // count=2 -> 1.10, count=100 -> 4.62
  const rate = edge.count > 0 ? edge.success / edge.count : 0;
  const age = Math.max(0, now - (edge.lastAt || 0));
  const freshness = Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);

  // 自主驱动自己跑出来的边要打折：那是「我自己决定的」，不是「用户教的」。
  // 不打折会形成自我强化 —— 越自动，越推荐自己刚才做过的动作。
  // 全自主的边权重减半，混合来源按比例过渡。
  const autoShare =
    edge.count > 0 ? Math.min(1, (Number(edge.autoplay) || 0) / edge.count) : 0;
  const autonomyPenalty = 1 - 0.5 * autoShare;

  return freq * rate * freshness * autonomyPenalty;
}

/* ---------------------------- 能量扩散 ---------------------------- */

/**
 * SiFu 的能量扩散。
 *
 * 从 seed 节点出发，能量沿出边传播：
 *   E(next) += E(cur) × weight(cur→next) × decay^hop
 *
 * 对应 BriLLM 的 argmax ‖E‖：谁累积到的能量最多，谁就最该做。
 *
 * @param {object} graph        buildGraph 的返回值
 * @param {string|string[]} seeds  当前所处节点（可以有多个起点）
 * @param {object} opts
 *   - decay       每跳衰减，默认 0.55
 *   - maxHops     最多几跳，默认 3
 *   - visited     已经做过的节点，能量打折（避免原地打转）
 * @returns {Map<string, {energy, hop, via}>}
 */
function diffuse(graph, seeds, opts = {}) {
  const decay = Number.isFinite(opts.decay) ? opts.decay : DEFAULT_DECAY;
  const maxHops = Number.isFinite(opts.maxHops) ? opts.maxHops : DEFAULT_MAX_HOPS;
  const visited = opts.visited instanceof Set ? opts.visited : new Set();
  const revisitPenalty = Number.isFinite(opts.revisitPenalty) ? opts.revisitPenalty : 0.25;

  const startList = Array.isArray(seeds) ? seeds : [seeds];
  const energy = new Map();

  // frontier: 当前这一跳的 { id, energy }
  let frontier = [];
  for (const s of startList) {
    if (!s) continue;
    const e = 1.0;
    energy.set(s, { energy: e, hop: 0, via: null });
    frontier.push({ id: s, energy: e });
  }

  // 按出边索引，避免每跳都遍历全图
  const outIndex = new Map(); // from -> [edge]
  for (const edge of graph.edges.values()) {
    if (!edge.weight) continue; // 支持不足的边不参与扩散
    let list = outIndex.get(edge.from);
    if (!list) {
      list = [];
      outIndex.set(edge.from, list);
    }
    list.push(edge);
  }

  for (let hop = 1; hop <= maxHops; hop++) {
    const nextFrontier = [];
    const hopFactor = Math.pow(decay, hop);

    for (const cur of frontier) {
      const outs = outIndex.get(cur.id);
      if (!outs) continue;

      for (const edge of outs) {
        let gain = cur.energy * edge.weight * hopFactor;

        // 已经做过的动作打折，防止 A→B→A→B 无限循环
        if (visited.has(edge.to)) gain *= revisitPenalty;

        const prev = energy.get(edge.to);
        const total = Math.min(MAX_ENERGY, (prev ? prev.energy : 0) + gain);

        if (!prev || total > prev.energy) {
          energy.set(edge.to, { energy: total, hop, via: edge.from });
          nextFrontier.push({ id: edge.to, energy: total });
        }
      }
    }

    if (!nextFrontier.length) break;
    frontier = nextFrontier;
  }

  // 起点本身不算候选
  for (const s of startList) if (s) energy.delete(s);

  return energy;
}

/* ---------------------------- 上下文门禁 ---------------------------- */

/**
 * 硬门禁：前置条件不满足的节点，能量归零。
 *
 * 这不是概率判断，是事实判断。没有镐就挖不了石头，
 * 不管这条边在历史上出现过多少次。
 *
 * @param {object} node    graph.nodes 里的节点
 * @param {object} ctx     当前世界状态
 *   - inventory: Map|object  item -> count
 *   - blocks:    Map|object  附近可及方块 item -> count
 *   - health, food, oxygen     数值
 *   - connected                是否连着服务器
 * @returns {{pass: boolean, reason: string}}
 */
function gate(node, ctx = {}) {
  if (!node) return { pass: false, reason: "节点不存在" };

  if (ctx.connected === false) {
    return { pass: false, reason: "未连接服务器" };
  }

  const inv = toCountMap(ctx.inventory);
  const blocks = toCountMap(ctx.blocks);
  const args = node.args || {};

  // 采集类：需要附近真的有这个方块
  if (node.tool === "collect" && args.block) {
    if (blocks && !blocks.has(args.block)) {
      return { pass: false, reason: `附近找不到 ${args.block}` };
    }
  }

  // 挖掘类：需要附近有这个方块，且手上得有镐（石头以上）
  if (node.tool === "dig") {
    const needsPick = ctx.targetHardness !== undefined && ctx.targetHardness > 0.5;
    if (needsPick && inv && !hasAnyPickaxe(inv)) {
      return { pass: false, reason: "没有镐，挖不动" };
    }
  }

  // 放置 / 建造：背包里得有对应的方块
  if ((node.tool === "build" || node.tool === "act") && args.block) {
    if (inv && !inv.has(args.block)) {
      return { pass: false, reason: `背包里没有 ${args.block}` };
    }
  }

  // 装备 / 使用物品：背包里得有
  if (node.tool === "act" && args.item) {
    if (inv && !inv.has(args.item)) {
      return { pass: false, reason: `背包里没有 ${args.item}` };
    }
  }

  // 吃饭类：得真的有食物
  if (node.tool === "act" && args.action === "eat") {
    if (inv && !hasAnyFood(inv)) {
      return { pass: false, reason: "背包里没有吃的" };
    }
  }

  // 血量过低时，非保命动作一律让位
  const lowHealth = Number(ctx.health) > 0 && Number(ctx.health) <= 12;
  if (lowHealth && !isSurvivalTool(node.tool)) {
    return { pass: false, reason: "血量偏低，先保命" };
  }

  // 溺水时不做别的
  const lowOxygen = Number(ctx.oxygen) > 0 && Number(ctx.oxygen) < 60;
  if (lowOxygen && !isSurvivalTool(node.tool)) {
    return { pass: false, reason: "溺水，先上浮" };
  }

  return { pass: true, reason: "" };
}

const PICKAXES = new Set([
  "wooden_pickaxe",
  "stone_pickaxe",
  "iron_pickaxe",
  "golden_pickaxe",
  "diamond_pickaxe",
  "netherite_pickaxe",
]);

const FOODS = new Set([
  "bread",
  "apple",
  "cooked_beef",
  "cooked_porkchop",
  "cooked_mutton",
  "cooked_chicken",
  "cooked_rabbit",
  "cooked_cod",
  "cooked_salmon",
  "baked_potato",
  "golden_carrot",
  "carrot",
  "beef",
  "porkchop",
  "mutton",
  "chicken",
  "rabbit",
  "cod",
  "salmon",
  "potato",
  "cookie",
  "sweet_berries",
  "melon_slice",
  "dried_kelp",
]);

const SURVIVAL_TOOLS = new Set(["move", "act", "dig"]);

function isSurvivalTool(tool) {
  return SURVIVAL_TOOLS.has(tool);
}

function hasAnyPickaxe(inv) {
  for (const k of inv.keys()) if (PICKAXES.has(k)) return true;
  return false;
}

function hasAnyFood(inv) {
  for (const k of inv.keys()) if (FOODS.has(k)) return true;
  return false;
}

function toCountMap(v) {
  if (!v) return null;
  if (v instanceof Map) return v;
  if (Array.isArray(v)) {
    const m = new Map();
    for (const it of v) {
      if (!it) continue;
      const name = it.name || it.item || it.id;
      if (!name) continue;
      m.set(name, (m.get(name) || 0) + (Number(it.count) || 1));
    }
    return m;
  }
  if (typeof v === "object") {
    const m = new Map();
    for (const [k, c] of Object.entries(v)) m.set(k, Number(c) || 1);
    return m;
  }
  return null;
}

/* ---------------------------- 对外主入口 ---------------------------- */

/**
 * 算出「下一步应该做什么」。
 *
 * @param {object} graph    buildGraph 的返回值
 * @param {object} ctx      当前世界状态（含 current 节点 / 各项属性）
 * @param {object} opts
 *   - limit          返回几个候选，默认 4
 *   - visited        本轮已做过的节点集合
 *   - decay / maxHops 透传给 diffuse
 * @returns {{pick: object|null, candidates: Array, note: string}}
 */
function nextAction(graph, ctx = {}, opts = {}) {
  const limit = opts.limit || DEFAULT_LIMIT;
  const current = ctx.current || ctx.currentNode || "";

  if (!graph || !graph.nodes || graph.nodes.size === 0) {
    return { pick: null, candidates: [], note: "图里还没有节点，先跑几次真实任务" };
  }

  // 没有当前节点时，退化成「全局最高分」而不是扩散
  let energy = current ? diffuse(graph, current, opts) : new Map();

  // 当前节点可能是链条末端（刚做完最后一个动作），没有出边可扩散。
  // 这时候不能直接说「没有下一步」——那等于每次做完动作就失忆。
  // 退化为全局评分：问「整个图里，最该做的下一件事是什么」。
  let fallback = false;
  if (!energy.size) {
    energy = globalScore(graph, opts);
    fallback = true;
  }

  const scored = [];
  let blockedCount = 0;

  for (const [id, info] of energy) {
    const node = graph.nodes.get(id);
    if (!node) continue;

    const g = gate(node, ctx);
    if (!g.pass) {
      blockedCount += 1;
      continue;
    }

    // 成功率也进最终分：做了会失败的动作不值得推荐
    const rate = node.runs > 0 ? node.success / node.runs : 0;
    const rateFactor = 0.3 + 0.7 * rate; // 0% 成功率保底 0.3，不至于永远归零

    // 效率也进分：同样成功，一次拿 4 个和一次拿 1 个不是一回事。
    const avgGain = node.runs ? node.totalGain / node.runs : 0;
    const gainPerSec = node.totalMs > 0 ? node.totalGain / (node.totalMs / 1000) : 0;
    const efficiencyFactor = gainPerSec > 0 ? 1 + Math.min(0.5, gainPerSec / 4) : 1;

    // 样本少时给一点探索空间，避免新工具永远排不上来。
    const exploreFactor = node.runs < 3 ? 1.05 : 1;

    const finalScore = info.energy * rateFactor * efficiencyFactor * exploreFactor;

    scored.push({
      id,
      tool: node.tool,
      args: node.args,
      score: finalScore,
      energy: info.energy,
      hop: info.hop,
      via: info.via,
      runs: node.runs,
      successRate: rate,
      avgMs: node.runs ? Math.round(node.totalMs / node.runs) : null,
      avgGain: node.runs ? Math.round(avgGain * 100) / 100 : null,
      gainPerSec: Math.round(gainPerSec * 1000) / 1000,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, limit);

  let note = "";
  if (!candidates.length) {
    note = blockedCount
      ? `${blockedCount} 个候选被前置条件挡住`
      : "没有可推荐的下一步，图可能太稀疏";
  } else if (fallback) {
    // 说明这是退化结果，不是扩散结果——免得用户以为「刚做完 A 就该做 B」
    note = "当前动作之后没有后续样本，按全局评分给出";
  } else if (candidates[0].runs < MIN_EDGE_SUPPORT) {
    note = "样本偏少，这个建议仅供参考";
  }

  return { pick: candidates[0] || null, candidates, note, fallback };
}

/**
 * 没有当前节点时用的退化评分。
 * 按「被指向的能量总和 × 成功率」排，相当于问「最该先做的是哪件」。
 */
function globalScore(graph, opts = {}) {
  const acc = new Map();
  for (const edge of graph.edges.values()) {
    if (!edge.weight) continue;
    const prev = acc.get(edge.to) || { energy: 0, hop: 0, via: null };
    prev.energy = Math.min(MAX_ENERGY, prev.energy + edge.weight);
    prev.via = edge.from;
    acc.set(edge.to, prev);
  }
  return acc;
}

/* ---------------------------- 文本输出 ---------------------------- */

/**
 * 把建议压成一行短文本，给 prompt 注入用。
 * 上限 120 字，超了就砍——技能索引那边已经占了不少上下文。
 */
function formatSuggestion(result, maxLen = 120) {
  if (!result || !result.pick) {
    return result && result.note ? result.note.slice(0, maxLen) : "";
  }

  const p = result.pick;
  const argText = describeArgs(p.args);
  const parts = [`下一步建议：${p.tool}${argText}`];

  if (p.successRate < 0.8) {
    parts.push(`成功率 ${Math.round(p.successRate * 100)}%`);
  }
  if (p.via) {
    const viaName = p.via.split(":")[0];
    parts.push(`接在 ${viaName} 之后`);
  }
  if (result.note) parts.push(result.note);

  const text = parts.join("｜");
  return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
}

function describeArgs(args) {
  if (!args || typeof args !== "object") return "";
  const keys = ["block", "item", "player", "action", "name"];
  const bits = [];
  for (const k of keys) {
    if (args[k] == null) continue;
    bits.push(String(args[k]));
  }
  if (args.count != null) bits.push(`×${args.count}`);
  return bits.length ? `(${bits.join(",")})` : "";
}

module.exports = {
  // 建图
  buildGraph,
  nodeIdOf,
  edgeWeight,
  isActionTool,
  // 推理
  diffuse,
  gate,
  nextAction,
  globalScore,
  // 输出
  formatSuggestion,
  // 常量
  MIN_EDGE_SUPPORT,
  DEFAULT_DECAY,
  DEFAULT_MAX_HOPS,
};
