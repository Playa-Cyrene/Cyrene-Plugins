"use strict";

/**
 * 目标视图（Goal View）—— 把目标图与追踪器压成前端能直接画的形状
 *
 * 前端不该自己猜「这个节点算完成还是卡住」。这一层只做三件事：
 *   1. 给每个节点算深度与状态
 *   2. 汇总每张图的进度、下一个节点、依赖边
 *   3. 把小目标与步骤归因原样带出去
 *
 * 它是纯函数：不读文件、不碰追踪器，输入什么就输出什么。
 * 这样面板、测试和离线检查工具能用同一套口径。
 */

const { nextNode, progressOf, depthsOf } = require("./goal-graph.cjs");

/** 节点状态：前端按这个上色 */
const NODE_STATUS = {
  DONE: "done",
  ACTIVE: "active",
  READY: "ready",
  BLOCKED: "blocked",
  MANUAL: "manual",
};

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 单个节点的状态。
 *
 * done 优先：已经完成的事不因为当前目标切走而改色。
 * manual 只表示「当前能力做不了」，不代表已完成或就绪。
 */
function statusOf(node, doneSet, graphName, current) {
  if (doneSet.has(node.id)) return NODE_STATUS.DONE;

  if (
    current &&
    current.graphName === graphName &&
    current.graphNodeId === node.id
  ) {
    return NODE_STATUS.ACTIVE;
  }

  if (node.kind === "manual") return NODE_STATUS.MANUAL;

  const ready = (node.requires || []).every((req) => doneSet.has(req));
  return ready ? NODE_STATUS.READY : NODE_STATUS.BLOCKED;
}

/**
 * 一张图的视图。
 *
 * @param {object} graph 已解析的目标图
 * @param {Set<string>} doneSet 已完成的节点
 * @param {Map<string, object>} goalByNode `${图名}\u0000${节点}` -> 目标摘要
 * @param {object|null} current 当前 active 目标
 */
function buildGraphView(graph, doneSet, goalByNode, current) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const depthOf = depthsOf(graph);
  const name = String(graph.name || "");

  const nodeViews = nodes.map((node) => {
    const key = `${name}\u0000${node.id}`;
    const goal = goalByNode.get(key) || null;
    const requires = Array.isArray(node.requires) ? node.requires.slice() : [];

    return {
      id: node.id,
      title: node.title || node.id,
      kind: node.kind || "craft",
      recipe: node.recipe || null,
      priority: numOr(node.priority, 50),
      requires,
      depth: depthOf.has(node.id) ? depthOf.get(node.id) : 0,
      status: statusOf(node, doneSet, name, current),
      checkpoint: node.checkpoint !== false,
      note: node.note || null,
      /** 这个节点对应的 goal（没生成时是 null） */
      goalId: goal ? goal.id : null,
      goalStatus: goal ? goal.status : null,
      progress: goal ? numOr(goal.progress, 0) : 0,
      count: goal ? Math.max(1, numOr(goal.count, 1)) : 1,
      failures: goal ? numOr(goal.failures, 0) : 0,
      attempts: goal ? numOr(goal.attempts, 0) : 0,
    };
  });

  // 依赖边：前置 -> 节点。前端画连线或列前置 chips 都用它。
  const edges = [];
  for (const node of nodes) {
    for (const req of node.requires || []) {
      edges.push({ from: req, to: node.id });
    }
  }

  const progress = progressOf(graph, doneSet);
  const next = nextNode(graph, doneSet);

  return {
    name,
    source: graph.source || null,
    total: progress.total,
    done: progress.done,
    percent: progress.percent,
    next: next
      ? {
          id: next.id,
          title: next.title || next.id,
          kind: next.kind || "craft",
          recipe: next.recipe || null,
        }
      : null,
    nodes: nodeViews,
    edges,
    stats: {
      manual: nodeViews.filter((n) => n.status === NODE_STATUS.MANUAL).length,
      ready: nodeViews.filter((n) => n.status === NODE_STATUS.READY).length,
      blocked: nodeViews.filter((n) => n.status === NODE_STATUS.BLOCKED).length,
      active: nodeViews.filter((n) => n.status === NODE_STATUS.ACTIVE).length,
      done: progress.done,
    },
  };
}

/**
 * 组装完整目标视图。
 *
 * @param {object} input
 * @param {Array<object>} [input.graphs]
 * @param {Map<string, Set<string>>} [input.graphDone]
 * @param {object} [input.snapshot] GoalTracker.snapshot()
 * @param {string} [input.now]
 * @returns {object}
 */
function buildGoalView(input = {}) {
  const graphs = Array.isArray(input.graphs) ? input.graphs : [];
  const graphDone =
    input.graphDone instanceof Map ? input.graphDone : new Map();
  const snapshot =
    input.snapshot && typeof input.snapshot === "object" ? input.snapshot : {};

  const smallGoals = Array.isArray(snapshot.goals) ? snapshot.goals : [];
  const current = snapshot.current || null;
  const stepLog = Array.isArray(snapshot.recentSteps) ? snapshot.recentSteps : [];
  const history = Array.isArray(snapshot.history) ? snapshot.history : [];

  const goalByNode = new Map();
  for (const goal of smallGoals) {
    if (goal && goal.graphName && goal.graphNodeId) {
      goalByNode.set(`${goal.graphName}\u0000${goal.graphNodeId}`, goal);
    }
  }

  const bigGoals = graphs
    .filter((graph) => graph && Array.isArray(graph.nodes))
    .map((graph) => {
      const done =
        graphDone.get(graph.name) instanceof Set
          ? graphDone.get(graph.name)
          : new Set();
      return buildGraphView(graph, done, goalByNode, current);
    });

  return {
    ok: true,
    now: input.now || new Date().toISOString(),
    current,
    bigGoals,
    smallGoals,
    history,
    stepLog,
    counts: snapshot.counts || { active: 0, pending: 0, done: 0, failed: 0 },
  };
}

module.exports = {
  NODE_STATUS,
  statusOf,
  buildGraphView,
  buildGoalView,
};
