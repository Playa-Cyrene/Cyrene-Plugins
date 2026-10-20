"use strict";

/**
 * 大纲提纯（Goal Outline）—— 把缩进列表整理成目标图
 *
 * 攻略常常先是一段人话：
 *
 *   # Minecraft 主线
 *   - 取得原木 [collect oak_log] @get_wood
 *     - 做出木镐 [craft wooden_pickaxe]
 *       - 取得圆石 [collect cobblestone]
 *   - 击败末影龙
 *
 * 这一层只做确定性的结构整理：缩进就是前置，方括号写类型与产物。
 * 它不调用模型，也不直接写盘；生成后仍然交给 goal-graph 做重复 id、
 * 悬空依赖与环检测。提纯失败时宁可整份拒绝，也不猜一个能跑的版本。
 *
 * 不支持写在括号里的节点默认按 manual 处理：
 * 攻略作者没写清楚怎么执行，就不该让它进入执行链。
 */

const { parseGraph, KIND, depthsOf } = require("./goal-graph.cjs");

/** 图名行：# 名字 */
const HEADING_RE = /^#\s+(.+?)\s*$/;

/** 节点行：缩进 + -/*+ + 内容 */
const NODE_RE = /^([ \t]*)[-*+]\s+(.+?)\s*$/;

/** 算缩进宽度，tab 按 4 个空格算 */
function indentWidth(text) {
  let width = 0;
  for (const ch of String(text || "")) {
    if (ch === "\t") width += 4;
    else if (ch === " ") width += 1;
    else break;
  }
  return width;
}

/** 标题 → id。保留中文，只去掉会干扰解析的符号与空白 */
function slugOf(title, index) {
  const s = String(title || "")
    .replace(/\s+/g, "_")
    .replace(/[#@[\]{}]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .trim();
  return s || `node_${index + 1}`;
}

/**
 * 拆一行节点内容。
 *
 * 支持的注解：
 *   [collect oak_log] / [craft wooden_pickaxe] / [manual]
 *   [oak_log]            只写物品，按 collect 处理
 *   @get_wood            显式节点 id
 *   {checkpoint=false}   完成后不沉淀技能
 *   {priority=80}        显式优先级
 *
 * @returns {{title:string,id:string,kind:string,recipe:string,checkpoint:boolean|null,priority:number|null,errors:string[]}}
 */
function parseNodeBody(body) {
  let text = String(body || "").trim();
  let id = "";
  let checkpoint = null;
  let priority = null;
  let kind = "";
  let recipe = "";
  const errors = [];

  text = text.replace(/@([^\s{}[\]]+)/g, (match, value) => {
    if (!id) id = value;
    return "";
  });

  text = text.replace(/\{([^}]*)\}/g, (match, inner) => {
    for (const part of String(inner).split(/[,;]/)) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();

      if (key === "checkpoint") checkpoint = value !== "false";
      else if (key === "priority") {
        const n = Number(value);
        if (Number.isFinite(n)) priority = n;
      }
    }
    return "";
  });

  text = text.replace(/\[([^\]]*)\]/g, (match, inner) => {
    const parts = String(inner).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "";

    if (["collect", "craft", "manual"].includes(parts[0])) {
      kind = parts[0];
      recipe = parts[1] || "";
    } else {
      // 只写了物品名：作者显然想采集它
      kind = "collect";
      recipe = parts[0];
    }
    return "";
  });

  const title = text.replace(/\s+/g, " ").trim();

  if ((kind === "collect" || kind === "craft") && !recipe) {
    errors.push(`${kind} 需要写清产物，例如 [${kind} oak_log]`);
  }

  return { title, id, kind, recipe, checkpoint, priority, errors };
}

/**
 * 解析大纲。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.name] 没写 # 标题时的图名
 * @returns {{ok:boolean, graph:object|null, errors:string[], stats:{nodes:number, depth:number}}}
 */
function parseOutline(text, opts = {}) {
  const errors = [];
  const raw = String(text || "").replace(/\r\n?/g, "\n");
  const lines = raw.split("\n");

  let name = "";
  const nodes = [];
  /** 缩进栈：{ indent, id } */
  const stack = [];
  const used = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;

    const heading = line.match(HEADING_RE);
    if (heading) {
      if (!name) name = heading[1].trim();
      continue;
    }

    const match = line.match(NODE_RE);
    if (!match) continue;

    const lineNo = i + 1;
    const indent = indentWidth(match[1]);
    const parsed = parseNodeBody(match[2]);

    if (parsed.errors.length) {
      for (const err of parsed.errors) errors.push(`第 ${lineNo} 行：${err}`);
    }

    const title = parsed.title || parsed.recipe;
    if (!title) {
      errors.push(`第 ${lineNo} 行：节点没有标题`);
      continue;
    }

    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parentId = stack.length ? stack[stack.length - 1].id : "";

    let id = parsed.id;
    if (id) {
      if (used.has(id)) {
        errors.push(`第 ${lineNo} 行：id 重复 ${id}`);
        continue;
      }
    } else {
      const base = slugOf(title, nodes.length);
      id = base;
      let suffix = 2;
      while (used.has(id)) {
        id = `${base}_${suffix}`;
        suffix += 1;
      }
    }
    used.add(id);

    // 没写类型：按占位处理，避免提纯出来的东西直接进入执行链
    const kind = parsed.kind || "manual";
    const node = {
      id,
      title,
      kind,
      priority:
        parsed.priority !== null
          ? parsed.priority
          : Math.max(1, 100 - nodes.length),
      requires: parentId ? [parentId] : [],
      checkpoint: parsed.checkpoint !== false,
    };
    if (parsed.recipe) node.recipe = parsed.recipe;
    nodes.push(node);

    stack.push({ indent, id });
  }

  if (!nodes.length) {
    errors.push("没有识别到节点：每行用 - 开头，缩进表示前置");
  }

  if (errors.length) {
    return { ok: false, graph: null, errors, stats: { nodes: 0, depth: 0 } };
  }

  const parsed = parseGraph({
    kind: KIND,
    schemaVersion: 1,
    name: name || opts.name || "导入的攻略",
    source: "大纲提纯",
    nodes,
  });

  if (!parsed.ok) {
    return {
      ok: false,
      graph: null,
      errors: parsed.errors,
      stats: { nodes: nodes.length, depth: 0 },
    };
  }

  const depthMap = depthsOf(parsed.graph);
  let maxDepth = 0;
  for (const depth of depthMap.values()) maxDepth = Math.max(maxDepth, depth);

  return {
    ok: true,
    graph: parsed.graph,
    errors: [],
    stats: { nodes: parsed.graph.nodes.length, depth: maxDepth + 1 },
  };
}

module.exports = {
  parseOutline,
  parseNodeBody,
  indentWidth,
  slugOf,
};
