"use strict";

/**
 * 流派层（提纯机制）
 *
 * 解决的问题：技能库只增不减，重复和劣质条目会一直堆积，
 * 而且没有「当前最优路径」的概念。模型每次都要自己判断该用哪一条。
 *
 * 这一层的职责：
 *   1. 给技能算一个可比较的分数（成功率、步骤数、耗时、新鲜度）
 *   2. 按目标分组，组内竞争出 primary / backup / archived
 *   3. 相似的技能合并，统计累加，劣质的那条归档
 *   4. 图与技能库的剪枝（归档不删除，环境变了还能回来）
 *
 * 设计纪律：
 *   - 这个文件是纯函数，不碰文件、不碰 store。
 *     落盘由调用方（index.cjs 的 skill 工具）负责，方便离线测试与 dry-run。
 *   - 归档是软删除：archived=true + 原因 + 时间，随时可恢复。
 *   - 剪枝默认要能 dry-run：先看清单，再决定落不落盘。
 */

const { NON_ACTIONABLE } = require("./skill-compiler.cjs");
const { absolutizeSteps } = require("./route-memory.cjs");

/**
 * 评分权重档位。
 * success 是幂次（2 ≈ 平方），steps / time 是幂次（3 ≈ 立方）。
 * 计划里 balanced 的 success=2 正好对应原式 successRate²。
 */
const PROFILES = {
  speedrun: { success: 1, steps: 3, time: 3 },
  safe: { success: 3, steps: 1, time: 1 },
  balanced: { success: 2, steps: 1, time: 1 },
};

const DEFAULT_PROFILE = "balanced";

/** 低于主流程这个比例，记一次「弱」 */
const WEAK_RATIO = 0.6;

/** 连续几次弱之后归档 */
const WEAK_STREAK_LIMIT = 3;

/** 技能步骤相似度阈值 */
const SIMILARITY_THRESHOLD = 0.8;

/** 各类上限 */
const MAX_SKILLS = 200;
const MAX_GRAPH_NODES = 500;
const MAX_GRAPH_EDGES = 2000;

/** 边多久没更新且权重为 0 就删 */
const EDGE_STALE_DAYS = 7;

const DAY_MS = 86400000;

/** 取技能成功率；无样本按 0 */
function successRate(skill) {
  const stats = (skill && skill.stats) || {};
  const runs = Number(stats.runs) || 0;
  if (runs <= 0) return 0;
  const success = Number(stats.success) || 0;
  return Math.max(0, Math.min(1, success / runs));
}

/** 平均耗时（秒）；没有耗时样本返回 null，不编数字 */
function averageSeconds(skill) {
  const stats = (skill && skill.stats) || {};
  const durations = Array.isArray(stats.durations) ? stats.durations : [];
  const valid = durations.map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  if (!valid.length) return null;
  const avgMs = valid.reduce((a, b) => a + b, 0) / valid.length;
  return Math.max(0.001, avgMs / 1000);
}

/** 距离上次运行/更新的天数 */
function ageDays(skill, now = Date.now()) {
  const stats = (skill && skill.stats) || {};
  const stamp = stats.lastRunAt || (skill && skill.updatedAt) || (skill && skill.createdAt);
  const ts = Date.parse(stamp || "");
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, (now - ts) / DAY_MS);
}

/** 新鲜度：30 天衰减一半 */
function freshness(skill, now = Date.now()) {
  return Math.pow(0.5, ageDays(skill, now) / 30);
}

/**
 * 流派评分。
 *   pathScore = successRate^w.success × (1/steps)^w.steps × (1/avgSec)^w.time × freshness
 * 没跑过的技能成功率为 0，分数也就是 0，会自然排到组尾。
 */
function pathScore(skill, opts = {}) {
  const profile = PROFILES[opts.profile] ? opts.profile : DEFAULT_PROFILE;
  const w = PROFILES[profile];
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  const rate = successRate(skill);
  const steps = Math.max(1, Array.isArray(skill && skill.steps) && skill.steps.length ? skill.steps.length : 1);
  const sec = averageSeconds(skill);
  // 没有耗时样本时按 1 秒处理：不奖励也不惩罚
  const time = sec === null ? 1 : Math.max(0.001, sec);

  return Math.pow(rate, w.success) * Math.pow(1 / steps, w.steps) * Math.pow(1 / time, w.time) * freshness(skill, now);
}

/** 取步骤的主对象，顺序与编译器保持一致 */
function primaryTarget(args) {
  if (!args || typeof args !== "object") return null;
  for (const key of ["block", "item", "action", "shape", "player"]) {
    const v = args[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/**
 * 技能的目标。
 * 取第一条真正改变世界的步骤（跳过查询/会话类），用「命令:主对象」表示。
 * 取不到目标就退回命令本身。
 */
function goalOf(skill) {
  const steps = Array.isArray(skill && skill.steps) ? skill.steps : [];
  const step = steps.find((s) => s && typeof s.cmd === "string" && !NON_ACTIONABLE.has(s.cmd));
  if (!step) return "unknown";

  const target = primaryTarget(step.args);
  return target ? `${step.cmd}:${target}` : step.cmd;
}

/**
 * 按目标分组。归档技能不参与竞争。
 * @returns {Array<{goal:string, skills:object[]}>}
 */
function groupByGoal(skills) {
  const groups = new Map();

  for (const skill of Array.isArray(skills) ? skills : []) {
    if (!skill || typeof skill !== "object") continue;
    if (skill.archived === true) continue;

    const goal = goalOf(skill);
    if (!groups.has(goal)) groups.set(goal, []);
    groups.get(goal).push(skill);
  }

  return [...groups.entries()].map(([goal, list]) => ({ goal, skills: list }));
}

/**
 * 组内排名。
 *
 * 状态：
 *   primary   组内最优，而且是唯一有样本的第一名
 *   backup    第 2–3 名
 *   candidate 整组都还没样本，先观望，不归档也不给 primary
 *   archived  其余，或连续 3 次低于主流程 60%
 *
 * @returns {{groups:Array, archive:string[]}}
 */
function rank(groups, opts = {}) {
  const profile = PROFILES[opts.profile] ? opts.profile : DEFAULT_PROFILE;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  const out = [];
  const archive = [];

  for (const group of Array.isArray(groups) ? groups : []) {
    const entries = (Array.isArray(group.skills) ? group.skills : []).map((skill) => ({
      skill,
      name: skill.name,
      runs: Number(skill.stats && skill.stats.runs) || 0,
      score: pathScore(skill, { profile, now }),
      prevStreak: Math.max(0, Number(skill.competition && skill.competition.weakStreak) || 0),
    }));

    entries.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));

    const sampled = entries.filter((e) => e.runs > 0);
    const hasSample = sampled.length > 0;
    const primary = hasSample ? sampled[0] : null;
    const primaryScore = primary ? primary.score : 0;

    const decided = entries.map((entry, index) => {
      let status;
      if (!hasSample) {
        status = "candidate";
      } else if (entry === primary) {
        status = "primary";
      } else if (index >= 1 && index <= 2) {
        status = "backup";
      } else {
        status = "archived";
      }

      const weak = Boolean(primary) && entry !== primary && primaryScore > 0 && entry.score < primaryScore * WEAK_RATIO;
      const weakStreak = weak ? entry.prevStreak + 1 : 0;

      // 连续 3 次弱 → 归档；先归档的不再参与下一次竞争
      if (weak && weakStreak >= WEAK_STREAK_LIMIT) status = "archived";

      if (status === "archived") archive.push(entry.name);

      return {
        name: entry.name,
        score: entry.score,
        status,
        weakStreak,
      };
    });

    out.push({
      goal: group.goal,
      primary: primary ? primary.name : null,
      entries: decided,
    });
  }

  return { groups: out, archive };
}

/** 步骤签名：命令 + 主对象。数量不同不算不同流派 */
function signatureOf(step) {
  const cmd = step && typeof step.cmd === "string" ? step.cmd : "?";
  const target = primaryTarget(step && step.args);
  return target ? `${cmd}:${target}` : cmd;
}

/** 最长公共子序列长度（滚动数组，避免长技能把内存顶爆） */
function lcsLength(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return 0;

  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    const cur = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[m];
}

/** 两条技能的步骤相似度：LCS / max(lenA, lenB) */
function similarity(a, b) {
  const sa = (Array.isArray(a && a.steps) ? a.steps : []).map(signatureOf);
  const sb = (Array.isArray(b && b.steps) ? b.steps : []).map(signatureOf);
  const max = Math.max(sa.length, sb.length);
  if (!max) return 0;
  return lcsLength(sa, sb) / max;
}

/** 取一份干净的统计副本 */
function statsOf(skill) {
  const s = (skill && skill.stats) || {};
  return {
    runs: Number(s.runs) || 0,
    success: Number(s.success) || 0,
    fail: Number(s.fail) || 0,
    durations: Array.isArray(s.durations) ? s.durations.slice(-20) : [],
    lastRunAt: s.lastRunAt || null,
  };
}

/** 两次统计相加 */
function addStats(a, b) {
  const left = statsOf(a && a.stats ? a : { stats: a });
  const right = statsOf(b && b.stats ? b : { stats: b });

  const lastRunAt = [left.lastRunAt, right.lastRunAt]
    .filter(Boolean)
    .sort()
    .pop() || null;

  return {
    runs: left.runs + right.runs,
    success: left.success + right.success,
    fail: left.fail + right.fail,
    durations: [...left.durations, ...right.durations].slice(-20),
    lastRunAt,
  };
}

/**
 * 规划合并。
 *
 * 组内按分数降序，逐个和已保留的代表比较；
 * 相似度 ≥ 0.8 就并入代表，统计累加。代表本身的统计也会在多次合并中累加。
 *
 * @returns {Array<{keep:string, drop:string, stats:object, archivedReason:string}>}
 */
function planMerges(groups, opts = {}) {
  const profile = PROFILES[opts.profile] ? opts.profile : DEFAULT_PROFILE;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const merges = [];

  for (const group of Array.isArray(groups) ? groups : []) {
    const sorted = (Array.isArray(group.skills) ? group.skills : [])
      .slice()
      .sort((a, b) => pathScore(b, { profile, now }) - pathScore(a, { profile, now }) || String(a.name).localeCompare(String(b.name)));

    const kept = [];
    for (const skill of sorted) {
      if (skill.archived === true) continue;

      const target = kept.find((k) => similarity(k, skill) >= SIMILARITY_THRESHOLD);
      if (!target) {
        kept.push(skill);
        continue;
      }

      const stats = addStats(target.stats, skill.stats);
      target.stats = stats;

      merges.push({
        keep: target.name,
        drop: skill.name,
        stats,
        archivedReason: `并入 ${target.name}`,
      });
    }
  }

  return merges;
}

/**
 * 技能库剪枝：超过上限时归档分数最低的尾部。
 * @returns {{archive:string[], dryRun:boolean, limit:number, total:number}}
 */
function pruneSkills(skills, opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || MAX_SKILLS);
  const dryRun = opts.dryRun === true;

  const active = (Array.isArray(skills) ? skills : []).filter((s) => s && s.archived !== true);
  if (active.length <= limit) {
    return { archive: [], dryRun, limit, total: active.length };
  }

  const scored = active
    .map((skill) => ({ name: skill.name, score: pathScore(skill, opts) }))
    .sort((a, b) => a.score - b.score || String(a.name).localeCompare(String(b.name)));

  const overflow = active.length - limit;
  return {
    archive: scored.slice(0, overflow).map((x) => x.name),
    dryRun,
    limit,
    total: active.length,
  };
}

/**
 * 图剪枝。
 *
 * 图是从轨迹派生的，删掉不需要真的写盘——这里返回一份清理后的图，
 * 调用方拿去喂给决策层即可。
 *
 * @param {object} graph {nodes: Map, edges: Map}
 * @param {object} opts  {now, dryRun, maxNodes, maxEdges, edgeStaleDays}
 * @returns {{graph:object, dropEdges:string[], dropNodes:string[], dryRun:boolean}}
 */
function pruneGraph(graph, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const dryRun = opts.dryRun === true;
  const maxNodes = Math.max(1, Number(opts.maxNodes) || MAX_GRAPH_NODES);
  const maxEdges = Math.max(1, Number(opts.maxEdges) || MAX_GRAPH_EDGES);
  const staleMs = Math.max(1, Number(opts.edgeStaleDays) || EDGE_STALE_DAYS) * DAY_MS;

  const srcNodes = graph && graph.nodes instanceof Map ? graph.nodes : new Map();
  const srcEdges = graph && graph.edges instanceof Map ? graph.edges : new Map();

  const nodes = new Map(srcNodes);
  const edges = new Map(srcEdges);

  const dropEdgeSet = new Set();

  // 1. 权重衰减到 0，且太久没更新 → 删边
  for (const [key, edge] of edges) {
    if (Number(edge && edge.weight) === 0 && now - (Number(edge && edge.lastAt) || 0) > staleMs) {
      dropEdgeSet.add(key);
    }
  }

  // 2. 孤立节点（把将要删掉的边也算作已删）且样本不足 → 删点
  const connected = new Set();
  for (const [key, edge] of edges) {
    if (dropEdgeSet.has(key)) continue;
    connected.add(edge.from);
    connected.add(edge.to);
  }

  const dropNodeSet = new Set();
  for (const [id, node] of nodes) {
    if (!connected.has(id) && (Number(node && node.runs) || 0) < 2) {
      dropNodeSet.add(id);
    }
  }

  // 3. 边数上限：按权重从低到高淘汰
  const keptEdgeKeys = [...edges.keys()].filter((key) => !dropEdgeSet.has(key));
  if (keptEdgeKeys.length > maxEdges) {
    const overflow = keptEdgeKeys.length - maxEdges;
    keptEdgeKeys
      .map((key) => ({ key, weight: Number(edges.get(key) && edges.get(key).weight) || 0 }))
      .sort((a, b) => a.weight - b.weight)
      .slice(0, overflow)
      .forEach((x) => dropEdgeSet.add(x.key));
  }

  // 4. 节点数上限：按 runs × 成功率淘汰尾部
  const keptNodeIds = [...nodes.keys()].filter((id) => !dropNodeSet.has(id));
  if (keptNodeIds.length > maxNodes) {
    const overflow = keptNodeIds.length - maxNodes;
    const scoreOf = (node) => {
      const runs = Number(node && node.runs) || 0;
      const success = Number(node && node.success) || 0;
      return runs > 0 ? runs * (success / runs) : 0;
    };

    keptNodeIds
      .map((id) => ({ id, score: scoreOf(nodes.get(id)) }))
      .sort((a, b) => a.score - b.score)
      .slice(0, overflow)
      .forEach((x) => dropNodeSet.add(x.id));
  }

  const dropEdges = [...dropEdgeSet];
  const dropNodes = [...dropNodeSet];

  if (dryRun) {
    return { graph, dropEdges, dropNodes, dryRun: true };
  }

  for (const key of dropEdges) edges.delete(key);
  for (const id of dropNodes) nodes.delete(id);

  return {
    graph: { ...(graph || {}), nodes, edges },
    dropEdges,
    dropNodes,
    dryRun: false,
  };
}

/**
 * 空闲巩固：把剪枝、分组、排名、合并串成一次计算。
 *
 * 纯计算，不落盘。调用方拿到计划后按顺序应用：
 *   1. merges：先给 keep 写累加后的 stats，再把 drop 标 archived
 *   2. rank：把 archived 的技能标 archived，把 weakStreak 写回
 *   3. pruneSkills：归档超出上限的尾部
 *
 * @param {object} opts
 * @param {object[]} opts.skills
 * @param {object} [opts.graph]
 * @param {string} [opts.profile]
 * @param {number} [opts.now]
 * @param {boolean} [opts.dryRun]
 * @param {object} [opts.limits]
 * @returns {object}
 */
function consolidate(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const dryRun = opts.dryRun !== false;
  const limits = opts.limits && typeof opts.limits === "object" ? opts.limits : {};

  const skills = (Array.isArray(opts.skills) ? opts.skills : []).filter((s) => s && typeof s === "object");

  const graphResult = opts.graph
    ? pruneGraph(opts.graph, {
        now,
        dryRun,
        maxNodes: limits.maxNodes,
        maxEdges: limits.maxEdges,
      })
    : { dropEdges: [], dropNodes: [], dryRun, graph: null };

  const groups = groupByGoal(skills);
  const ranking = rank(groups, { profile: opts.profile, now });
  const merges = planMerges(groups, { profile: opts.profile, now });
  const prune = pruneSkills(skills, {
    now,
    dryRun,
    profile: opts.profile,
    limit: limits.maxSkills,
    maxNodes: limits.maxNodes,
    maxEdges: limits.maxEdges,
  });

  const archived = new Set([...ranking.archive, ...prune.archive, ...merges.map((m) => m.drop)]);

  const summary =
    `归档 ${archived.size} 条技能（合并 ${merges.length} 条、竞争 ${ranking.archive.length} 条、超限 ${prune.archive.length} 条）` +
    `｜清理图节点 ${graphResult.dropNodes.length} 个、边 ${graphResult.dropEdges.length} 条` +
    (dryRun ? "｜dry-run，未落盘" : "");

  return {
    dryRun,
    graph: {
      dropEdges: graphResult.dropEdges,
      dropNodes: graphResult.dropNodes,
    },
    groups: ranking.groups,
    merges,
    archiveSkills: [...archived],
    summary,
  };
}

/** 恢复一个已归档技能的补丁 */
function restorePatch() {
  return { archived: false, archivedAt: null, archivedReason: null, competition: { weakStreak: 0, lastEvalAt: null } };
}

/* ---------------------------- 路线流派 ---------------------------- */

/**
 * 路线步骤签名。
 *
 * move 只记「走到位」，不记坐标 —— 换个目标，坐标必然不同。
 * 垫高、跳跃、搭桥、挖挡路都是与目标无关的通用段，可以跨目标迁移。
 */
function routeStepSignature(step) {
  const action = String((step && step.action) || "");
  const a = step && step.args ? step.args : {};
  if (action === "pillar") return `pillar:${Number(a.height) || 1}`;
  if (action === "bridge") return "bridge";
  if (action === "jump") return "jump";
  if (action === "dig") return "dig";
  if (action === "move") return "move";
  return action;
}

/**
 * 从路线库里提取流派模板。
 *
 * 同 goal 的多条路线，取「每条都出现过」的步骤类型作为公共段。
 * 只出现一次的路线不构成流派，跳过。
 *
 * @param {Array<object>} routes
 * @returns {Array<{goal:string, base:string, support:number, steps:Array, signatures:string[]}>}
 */
function extractRouteTemplates(routes) {
  const groups = new Map();
  for (const r of Array.isArray(routes) ? routes : []) {
    if (!r || !r.goal || !Array.isArray(r.steps) || !r.steps.length) continue;
    if (!groups.has(r.goal)) groups.set(r.goal, []);
    groups.get(r.goal).push(r);
  }

  const out = [];
  for (const [goal, list] of groups) {
    if (list.length < 2) continue;

    // 用成功率最高的那条当基准
    const base = list
      .slice()
      .sort((a, b) => {
        const ra = a.runs ? a.ok / a.runs : 0;
        const rb = b.runs ? b.ok / b.runs : 0;
        return rb - ra;
      })[0];

    const common = [];
    for (const step of base.steps) {
      const sig = routeStepSignature(step);
      if (list.every((r) => r.steps.some((s) => routeStepSignature(s) === sig))) {
        if (!common.some((c) => routeStepSignature(c) === sig)) common.push(step);
      }
    }

    if (common.length) {
      out.push({
        goal,
        base: base.id,
        support: list.length,
        steps: common.map((s) => ({ action: s.action, args: { ...(s.args || {}) } })),
        signatures: common.map(routeStepSignature),
      });
    }
  }
  return out;
}

/**
 * 把模板里的相对偏移映射到当前目标。
 * 通用段（pillar/jump/bridge/dig）不依赖目标，直接可用。
 */
function applyRouteTemplate(template, targetPos) {
  if (!template || !Array.isArray(template.steps) || !targetPos) return [];
  return absolutizeSteps(template.steps, targetPos);
}

/**
 * 路线评分与排序。
 * 和技能评分同一个思路：成功率高、步骤少、新鲜。
 */
function rankRoutes(routes, opts = {}) {
  const now = opts.now || Date.now();
  return (Array.isArray(routes) ? routes : [])
    .map((r) => {
      const runs = Number(r.runs) || 0;
      const rate = runs ? (Number(r.ok) || 0) / runs : 0;
      const steps = Array.isArray(r.steps) ? r.steps.length : 1;
      const age = r.lastAt ? (now - r.lastAt) / DAY_MS : 999;
      const fresh = Math.pow(0.5, age / 30);
      const score = (Math.pow(rate, 2) / Math.sqrt(Math.max(1, steps))) * fresh;
      return {
        ...r,
        successRate: Math.round(rate * 1000) / 1000,
        score: Math.round(score * 1000) / 1000,
      };
    })
    .sort((a, b) => b.score - a.score);
}

module.exports = {
  PROFILES,
  DEFAULT_PROFILE,
  WEAK_RATIO,
  WEAK_STREAK_LIMIT,
  SIMILARITY_THRESHOLD,
  MAX_SKILLS,
  MAX_GRAPH_NODES,
  MAX_GRAPH_EDGES,
  EDGE_STALE_DAYS,
  successRate,
  averageSeconds,
  ageDays,
  freshness,
  pathScore,
  goalOf,
  groupByGoal,
  rank,
  similarity,
  lcsLength,
  addStats,
  planMerges,
  pruneSkills,
  pruneGraph,
  consolidate,
  restorePatch,
  routeStepSignature,
  extractRouteTemplates,
  applyRouteTemplate,
  rankRoutes,
};
