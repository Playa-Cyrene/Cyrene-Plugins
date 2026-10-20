"use strict";

/**
 * 目标沉淀（Goal Sink）—— 节点完成的那一刻，把刚跑通的执行收进技能库
 *
 * ── 它补的是哪一段 ────────────────────────────────────────────────
 * goal-graph 知道「这个节点做完了」，skill-compiler 知道「这段轨迹能编成技能」，
 * 但两者之间原本没有线。结果就是：目标图只推进了进度，学不到任何东西，
 * 同一段路下次还得从零试。
 *
 * 这一层做的事很小：节点完成 → 取最近一段成功轨迹 → 编译 → 存成技能，
 * 并在技能 source 里记下它来自哪张图的哪个节点。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────
 * 1. **checkpoint=false 的节点不沉淀。**
 *    攻略作者明确说「这个节点不值得固化」，就尊重这个判断。
 *
 * 2. **同名技能已存在就不覆盖。**
 *    自动编译出来的技能可以被手改，手改过的比再编一次的值得多。
 *
 * 3. **沉淀失败只返回原因，不抛错。**
 *    它挂在节点完成的回调上。编译失败不该把进度落盘一起带崩，
 *    更不该让自主驱动停下来。
 */

const { compileEpisode } = require("./skill-compiler.cjs");

/** 技能名上限（和 skill-store 的 NAME_RE 一致） */
const MAX_NAME = 48;

/** 前缀：一眼看出这是目标图沉淀出来的 */
const PREFIX = "goal_";

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

/* ---------------------------- 命名 ---------------------------- */

/** 技能名安全化：只留字母数字下划线与短横线 */
function safeName(text) {
  const s = String(text || "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "node";
}

/**
 * 短哈希：同一张图里两个节点重名时用来区分。
 * 节点 id 一般够用，真正需要它的是「两张图用了同一个节点 id」。
 */
function shortHash(text) {
  let h = 2166136261;
  const s = String(text || "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

/** 基础名：goal_<nodeId> */
function baseNameOf(nodeId) {
  const tail = safeName(str(nodeId) || "node");
  return `${PREFIX}${tail}`.slice(0, MAX_NAME);
}

/**
 * 给这次沉淀挑一个名字。
 *
 * 默认用干净的名字；被别的图占了才加短哈希。
 * 同一张图的同名节点重复完成时仍然返回原名 —— 上层用它判断「已经沉淀过」。
 */
function nameFor(graphName, nodeId, store) {
  const base = baseNameOf(nodeId);
  if (!store || typeof store.get !== "function") return base;

  let existing = null;
  try {
    existing = store.get(base);
  } catch {
    existing = null;
  }
  if (!existing) return base;

  const owner =
    existing.source && existing.source.goal ? str(existing.source.goal.graph) : "";
  if (owner && owner === str(graphName)) return base;

  return `${base}_${shortHash(graphName)}`.slice(0, MAX_NAME);
}

/* ---------------------------- 查找 ---------------------------- */

/** 在图列表里找节点；找不到返回 null */
function findNode(graphs, graphName, nodeId) {
  if (!Array.isArray(graphs)) return null;
  const name = str(graphName);
  const id = str(nodeId);

  for (const graph of graphs) {
    if (!graph || str(graph.name) !== name) continue;
    if (!Array.isArray(graph.nodes)) continue;
    const node = graph.nodes.find((n) => n && str(n.id) === id);
    if (node) return node;
  }
  return null;
}

/* ---------------------------- 沉淀 ---------------------------- */

/**
 * 把一个刚完成的节点沉淀成技能。
 *
 * @param {object} opts
 * @param {Array<object>} opts.graphs 已加载的目标图
 * @param {string} opts.graphName 图名
 * @param {string} opts.nodeId 节点 id
 * @param {object} opts.trace TraceLogger（要 latestCompilableEpisode）
 * @param {object} opts.store SkillStore（get / save）
 * @param {number} [opts.minSteps] 至少几步才编
 * @returns {{ok:boolean, reason:string, name?:string, steps?:number, skill?:object}}
 */
function precipitateNode(opts = {}) {
  const graphs = opts.graphs;
  const graphName = str(opts.graphName);
  const nodeId = str(opts.nodeId);
  const trace = opts.trace;
  const store = opts.store;
  const minSteps = Math.max(1, Number(opts.minSteps) || 1);

  if (!graphName || !nodeId) return { ok: false, reason: "bad-input" };
  if (!store || typeof store.get !== "function" || typeof store.save !== "function") {
    return { ok: false, reason: "no-store" };
  }
  if (!trace || typeof trace.latestCompilableEpisode !== "function") {
    return { ok: false, reason: "no-trace" };
  }

  const node = findNode(graphs, graphName, nodeId);
  if (!node) return { ok: false, reason: "no-node" };
  if (node.checkpoint === false) {
    return { ok: false, reason: "checkpoint-off", name: baseNameOf(nodeId) };
  }

  const name = nameFor(graphName, nodeId, store);

  // 同名技能已经在了：不覆盖。手动改过的技能比自动编译的值钱。
  let existing = null;
  try {
    existing = store.get(name);
  } catch {
    existing = null;
  }
  if (existing) return { ok: false, reason: "exists", name };

  let episode = null;
  try {
    episode = trace.latestCompilableEpisode(minSteps);
  } catch (e) {
    return { ok: false, reason: "no-episode", name, error: e.message };
  }
  if (!Array.isArray(episode) || !episode.length) {
    return { ok: false, reason: "no-episode", name };
  }

  const title = str(node.title) || nodeId;
  const skill = compileEpisode(episode, {
    name,
    description: `${title}（${graphName}）`,
  });
  if (!skill) return { ok: false, reason: "not-compilable", name };

  skill.name = name;

  // source 是 skill-store 唯一原样保留的自由字段，把来源挂在这里。
  const source =
    skill.source && typeof skill.source === "object" ? { ...skill.source } : {};
  source.goal = { graph: graphName, node: nodeId, title };
  if (Array.isArray(node.steps) && node.steps.length) {
    // 攻略里写死的步骤留在 source 里备查：轨迹优先，但人工写法不该丢。
    source.guideSteps = node.steps.map((s) => ({
      cmd: str(s.tool) || "unknown",
      args: s.args && typeof s.args === "object" ? s.args : {},
    }));
  }
  skill.source = source;

  try {
    store.save(name, skill);
  } catch (e) {
    return { ok: false, reason: "save-failed", name, error: e.message };
  }

  return { ok: true, reason: "ok", name, steps: skill.steps.length, skill };
}

/** 一行摘要，给日志与面板用 */
function formatSink(result, maxLen = 80) {
  if (!result) return "";
  if (result.ok) {
    const text = `沉淀技能 ${result.name}（${result.steps} 步）`;
    return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
  }
  const text = result.name ? `未沉淀 ${result.name}：${result.reason}` : `未沉淀：${result.reason}`;
  return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
}

module.exports = {
  PREFIX,
  MAX_NAME,
  safeName,
  shortHash,
  baseNameOf,
  nameFor,
  findNode,
  precipitateNode,
  formatSink,
};
