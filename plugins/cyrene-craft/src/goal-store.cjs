"use strict";

/**
 * 目标图仓库（Goal Store）—— 攻略导入与持久化
 *
 * 存到 `<记忆树>/goals/*.json`，跟技能库同一个根。
 * 导入只做两件事：解析校验、写盘。执行由目标层负责。
 *
 * 为什么不让模型直接写节点：
 * 攻略里的「先挖三个木头再做工作台」是自然语言。
 * 让模型一步翻译成步骤，写法会在两次调用之间漂移，
 * 提纯出来的东西没法验证。所以中间必须停在一个 JSON 上，
 * 模型可以帮人起草这个 JSON，但最终落盘的是结构化节点。
 */

const fs = require("node:fs");
const path = require("node:path");

const { parseGraph, KIND } = require("./goal-graph.cjs");

/** 目录名：跟着记忆树走 */
const DIR_NAME = "goals";

/** 单份图的大小上限：目标图是手写数据，不该有几十兆 */
const MAX_BYTES = 512 * 1024;

/** 图名 → 文件名。只保留安全字符，避免路径穿越 */
function slugOf(name) {
  const s = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "goal-graph";
}

/** 图目录 */
function dirOf(rootDir) {
  return path.join(rootDir, DIR_NAME);
}

function ensureDir(rootDir) {
  const dir = dirOf(rootDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ---------------------------- 读取 ---------------------------- */

/**
 * 读入全部目标图。
 *
 * 单份坏文件不影响其它文件：错误收集起来一起返回。
 * @returns {{graphs:Array, errors:Array<{file:string, errors:string[]}>}}
 */
function loadGraphs(rootDir) {
  const dir = dirOf(rootDir);
  const graphs = [];
  const errors = [];

  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return { graphs, errors };
  }

  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const stat = fs.statSync(full);
      if (stat.size > MAX_BYTES) {
        errors.push({ file, errors: [`文件超过 ${MAX_BYTES} 字节`] });
        continue;
      }

      const text = fs.readFileSync(full, "utf8");
      const parsed = parseGraph(text);
      if (!parsed.ok) {
        errors.push({ file, errors: parsed.errors });
        continue;
      }

      graphs.push({ ...parsed.graph, file });
    } catch (e) {
      errors.push({ file, errors: [e.message] });
    }
  }

  return { graphs, errors };
}

/* ---------------------------- 写入 ---------------------------- */

/**
 * 保存一份图。
 * @returns {{ok:boolean, file:string, errors:string[]}}
 */
function saveGraph(rootDir, graph) {
  if (!graph || graph.kind !== KIND) {
    return { ok: false, file: "", errors: [`不是 ${KIND} 文件`] };
  }

  try {
    ensureDir(rootDir);
    const file = `${slugOf(graph.name)}.json`;
    const full = path.join(dirOf(rootDir), file);

    // 写盘前重新解析一遍：确保任何调用方传进来的东西都过同样的校验
    const check = parseGraph(graph);
    if (!check.ok) return { ok: false, file, errors: check.errors };

    fs.writeFileSync(full, JSON.stringify(check.graph, null, 2), "utf8");
    return { ok: true, file, errors: [] };
  } catch (e) {
    return { ok: false, file: "", errors: [e.message] };
  }
}

/**
 * 导入一份图（JSON 字符串或对象）。
 * @returns {{ok:boolean, graph:object|null, file:string, errors:string[]}}
 */
function importGraph(rootDir, input) {
  const parsed = parseGraph(input);
  if (!parsed.ok) {
    return { ok: false, graph: null, file: "", errors: parsed.errors };
  }

  const saved = saveGraph(rootDir, parsed.graph);
  if (!saved.ok) {
    return { ok: false, graph: parsed.graph, file: saved.file, errors: saved.errors };
  }

  return { ok: true, graph: parsed.graph, file: saved.file, errors: [] };
}

/** 删除一份图 */
function removeGraph(rootDir, name) {
  try {
    const full = path.join(dirOf(rootDir), `${slugOf(name)}.json`);
    if (!fs.existsSync(full)) return { ok: false, errors: ["文件不存在"] };
    fs.unlinkSync(full);
    return { ok: true, errors: [] };
  } catch (e) {
    return { ok: false, errors: [e.message] };
  }
}

/* ---------------------------- 进度 ---------------------------- */

/** 进度文件：哪个图的哪个节点做完了 */
function progressFile(rootDir) {
  return path.join(dirOf(rootDir), "progress.json");
}

/**
 * 读进度。
 * @returns {object} { [graphName]: string[] }
 */
function loadProgress(rootDir) {
  try {
    const raw = fs.readFileSync(progressFile(rootDir), "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return {};

    const out = {};
    for (const [name, list] of Object.entries(data)) {
      if (Array.isArray(list)) out[name] = list.filter((x) => typeof x === "string");
    }
    return out;
  } catch {
    return {};
  }
}

/** 写进度 */
function saveProgress(rootDir, progress) {
  try {
    ensureDir(rootDir);
    fs.writeFileSync(
      progressFile(rootDir),
      JSON.stringify(progress || {}, null, 2),
      "utf8",
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, errors: [e.message] };
  }
}

/** 标记一个节点完成 */
function markNodeDone(rootDir, graphName, nodeId) {
  const progress = loadProgress(rootDir);
  const list = new Set(progress[graphName] || []);
  list.add(nodeId);
  progress[graphName] = [...list];
  return saveProgress(rootDir, progress);
}

module.exports = {
  DIR_NAME,
  MAX_BYTES,
  slugOf,
  dirOf,
  loadGraphs,
  saveGraph,
  importGraph,
  removeGraph,
  loadProgress,
  saveProgress,
  markNodeDone,
};
