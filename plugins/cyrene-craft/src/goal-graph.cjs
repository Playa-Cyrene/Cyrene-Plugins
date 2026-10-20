"use strict";

/**
 * 目标图（Goal Graph）—— 外部攻略变成可执行的大目标
 *
 * ── 它补的是哪一段 ────────────────────────────────────────────────
 * goal-plan 能拆「木镐需要什么」，但它只知道配方。
 * 「击败末影龙」不是配方，是一串任务：找要塞、凑末影之眼、开传送门、
 * 打水晶、杀龙。这些依赖关系不在任何配方表里。
 *
 * 这一层把外部攻略写成一张有向无环图：
 *   节点 = 一个能独立判断完成的大目标
 *   边   = 前置依赖（做这件事之前必须先完成哪些）
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────
 * 1. **只认结构化的东西。**
 *    攻略是自然语言，模型可以帮人读懂，但落盘必须是节点 + 依赖 + 步骤。
 *    直接让模型写技能步骤，提纯出来的是不可验证的幻觉。
 *
 * 2. **环必须挡住。**
 *    A 需要 B、B 又需要 A 的图会让执行永久卡死。
 *    导入时就做拓扑排序，有环直接拒绝整份文件。
 *
 * 3. **不知道的依赖不猜。**
 *    节点引用了不存在的 id，导入失败并指出是哪一条。
 *    宁可让用户改文件，不要让运行时静默跳过。
 */

/** 图格式版本 */
const SCHEMA_VERSION = 1;

/** 设备识别的文件类型 */
const KIND = "cyrene-craft-goals";

/* ---------------------------- 规范化 ---------------------------- */

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * 规范化单个节点。
 * 返回 null 表示这条不合法，错误写进 errors。
 */
function normalizeNode(raw, index, errors) {
  if (!raw || typeof raw !== "object") {
    errors.push(`第 ${index + 1} 个节点不是对象`);
    return null;
  }

  const id = str(raw.id);
  if (!id) {
    errors.push(`第 ${index + 1} 个节点缺少 id`);
    return null;
  }

  // 步骤：允许 { tool, args } 或 { cmd, args } 两种写法
  const steps = [];
  for (const s of asArray(raw.steps)) {
    if (!s || typeof s !== "object") continue;
    const tool = str(s.tool) || str(s.cmd);
    if (!tool) continue;
    steps.push({
      tool,
      args: s.args && typeof s.args === "object" ? { ...s.args } : {},
    });
  }

  return {
    id,
    title: str(raw.title) || id,
    priority: Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 50,
    requires: asArray(raw.requires).map(str).filter(Boolean),
    /**
     * 节点类型：
     *   collect / craft —— 交给 goal-plan 递归拆解
     *   manual          —— 当前能力做不了，只占位、不生成执行目标
     */
    kind: ["collect", "craft", "manual"].includes(str(raw.kind))
      ? str(raw.kind)
      : "craft",
    /** 产物名：collect 是方块，craft 是物品 */
    recipe: str(raw.recipe) || null,
    /** 显式步骤：攻略里写清楚的固定操作 */
    steps,
    /** 完成后是否值得沉淀成技能 */
    checkpoint: raw.checkpoint !== false,
    /** 原始备注，只给人看 */
    note: str(raw.note) || null,
  };
}

/* ---------------------------- 环检测 ---------------------------- */

/**
 * 拓扑排序。
 * @returns {{ok:boolean, order:string[], cycle:string[]}}
 */
function topoSort(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  const out = new Map(nodes.map((n) => [n.id, []]));

  for (const node of nodes) {
    for (const req of node.requires) {
      if (!byId.has(req)) continue;
      indegree.set(node.id, (indegree.get(node.id) || 0) + 1);
      out.get(req).push(node.id);
    }
  }

  const queue = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);

  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of out.get(id) || []) {
      const deg = indegree.get(next) - 1;
      indegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  if (order.length === nodes.length) {
    return { ok: true, order, cycle: [] };
  }

  const cycle = nodes.map((n) => n.id).filter((id) => !order.includes(id));
  return { ok: false, order, cycle };
}

/* ---------------------------- 解析 ---------------------------- */

/**
 * 解析一份目标图文件。
 *
 * @param {object|string} input JSON 对象或字符串
 * @returns {{ok:boolean, graph:object|null, errors:string[]}}
 */
function parseGraph(input) {
  const errors = [];

  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (e) {
      return { ok: false, graph: null, errors: [`JSON 解析失败：${e.message}`] };
    }
  }

  if (!raw || typeof raw !== "object") {
    return { ok: false, graph: null, errors: ["文件内容不是对象"] };
  }

  if (raw.kind && raw.kind !== KIND) {
    errors.push(`kind 应为 ${KIND}，实际是 ${raw.kind}`);
  }

  const nodes = [];
  const seen = new Set();

  asArray(raw.nodes).forEach((n, i) => {
    const node = normalizeNode(n, i, errors);
    if (!node) return;
    if (seen.has(node.id)) {
      errors.push(`节点 id 重复：${node.id}`);
      return;
    }
    seen.add(node.id);
    nodes.push(node);
  });

  if (!nodes.length) errors.push("没有任何节点");

  // 引用了不存在的依赖
  for (const node of nodes) {
    for (const req of node.requires) {
      if (!seen.has(req)) {
        errors.push(`节点 ${node.id} 依赖了不存在的 ${req}`);
      }
    }
  }

  if (errors.length) {
    return { ok: false, graph: null, errors };
  }

  const topo = topoSort(nodes);
  if (!topo.ok) {
    return {
      ok: false,
      graph: null,
      errors: [`依赖成环：${topo.cycle.join(" → ")}`],
    };
  }

  return {
    ok: true,
    graph: {
      kind: KIND,
      schemaVersion: Number(raw.schemaVersion) || SCHEMA_VERSION,
      name: str(raw.name) || "未命名目标图",
      source: str(raw.source) || null,
      nodes,
      order: topo.order,
      importedAt: new Date().toISOString(),
    },
    errors: [],
  };
}

/* ---------------------------- 就绪判断 ---------------------------- */

/**
 * 哪些节点现在可以做。
 *
 * 条件：自己没完成，且所有前置都完成了。
 * 顺序按 priority 降序，同优先级按图里的声明顺序。
 */
function readyNodes(graph, done = new Set()) {
  if (!graph || !Array.isArray(graph.nodes)) return [];

  const doneSet = done instanceof Set ? done : new Set(asArray(done));
  const indexOf = new Map(graph.nodes.map((n, i) => [n.id, i]));

  return graph.nodes
    .filter((n) => !doneSet.has(n.id))
    .filter((n) => n.requires.every((req) => doneSet.has(req)))
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        (indexOf.get(a.id) || 0) - (indexOf.get(b.id) || 0),
    );
}

/** 当前最该推进的一个大目标 */
function nextNode(graph, done = new Set()) {
  return readyNodes(graph, done)[0] || null;
}

/** 图整体进度：完成几个 / 总共几个 */
function progressOf(graph, done = new Set()) {
  const doneSet = done instanceof Set ? done : new Set(asArray(done));
  const total = graph && Array.isArray(graph.nodes) ? graph.nodes.length : 0;
  const finished = graph
    ? graph.nodes.filter((n) => doneSet.has(n.id)).length
    : 0;

  return {
    total,
    done: finished,
    percent: total ? Math.round((finished / total) * 100) : 0,
  };
}

/** 被卡住的节点：前置做不了，或者根本不在图里（已由导入挡掉） */
function blockedNodes(graph, done = new Set()) {
  const doneSet = done instanceof Set ? done : new Set(asArray(done));
  return (graph && Array.isArray(graph.nodes) ? graph.nodes : []).filter(
    (n) =>
      !doneSet.has(n.id) &&
      n.requires.some((req) => !doneSet.has(req)),
  );
}

/**
 * 每个节点的依赖深度：没有前置是 0，多前置取最大层 + 1。
 *
 * 图在导入时已经做过环检测，这里仍然带一层访问保护：
 * 面板可能拿到手写或热改的图，坏数据不该把渲染栈直接打爆。
 *
 * @returns {Map<string, number>} nodeId -> depth
 */
function depthsOf(graph) {
  const out = new Map();
  if (!graph || !Array.isArray(graph.nodes)) return out;

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const visiting = new Set();

  const walk = (id) => {
    if (out.has(id)) return out.get(id);
    if (visiting.has(id)) return 0;

    const node = byId.get(id);
    if (!node || !Array.isArray(node.requires) || !node.requires.length) {
      out.set(id, 0);
      return 0;
    }

    visiting.add(id);
    let depth = 0;
    for (const req of node.requires) {
      depth = Math.max(depth, walk(req) + 1);
    }
    visiting.delete(id);
    out.set(id, depth);
    return depth;
  };

  for (const node of graph.nodes) walk(node.id);
  return out;
}

/* ---------------------------- 输出 ---------------------------- */

/** 一行短文本，给 prompt 和面板用 */
function formatGraph(graph, done = new Set(), maxLen = 120) {
  if (!graph) return "";

  const next = nextNode(graph, done);
  const p = progressOf(graph, done);
  const text = next
    ? `${graph.name} ${p.done}/${p.total}｜下一个：${next.title}`
    : `${graph.name} ${p.done}/${p.total}${p.done === p.total ? "｜已完成" : ""}`;

  return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
}

module.exports = {
  SCHEMA_VERSION,
  KIND,
  parseGraph,
  topoSort,
  readyNodes,
  nextNode,
  progressOf,
  blockedNodes,
  depthsOf,
  formatGraph,
};
