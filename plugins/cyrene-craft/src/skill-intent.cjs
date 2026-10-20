"use strict";

/**
 * 意图层（Grounding）生成器 —— 借鉴 OpenHA 的 Chain of Action 两段式输出
 *
 * OpenHA 让模型先输出 high-level abstracted action（Grounding / Motion），
 * 再输出可执行的 raw action。核心价值在于「意图」和「参数」被拆成两段，
 * 失败时能分清是「想错了」还是「抛锚了」。
 *
 * 这里把这套结构移植到技能系统上：
 *
 *   Grounding: Mine oak_log @(-9, 129, 9)
 *   Action:    collect(block="oak_log", count=8)
 *
 * 设计纪律：
 *   - 意图层是给人看的标注，不是给机器解析的协议。机器照旧读 steps。
 *   - 意图必须能从 steps 推导出来。推不出就返回 null，不硬造。
 *   - 不从意图层反推行为，只从它反推失败归属。
 */

/** 命令 → 意图动词。与 CMD_LABEL 分开：那里是「类别」，这里是「意图」 */
const INTENT_VERB = {
  collect: "Mine",
  dig: "Mine",
  attack: "Kill",
  build: "Place",
  place: "Place",
  move: "Approach",
  pickup: "Pick",
  give: "Give",
  craft: "Craft",
  smelt: "Smelt",
  act: "Use",
  use: "Use",
  equip: "Equip",
  eat: "Eat",
  sleep: "Sleep",
  drop: "Drop",
  jump: "Jump",
  sneak: "Sneak",
  command: "Command",
};

/**
 * 只声明「做什么」不声明「对什么」的命令。
 * 它们的目标来自上下文（当前朝向、当前目标），写进意图层是伪造信息。
 */
const CONTEXT_ONLY = new Set(["move", "jump", "sneak", "sleep", "stop"]);

/** 从 args 里取目标名。顺序与 compiler 的 primaryObject 保持一致 */
function targetOf(args) {
  if (!args || typeof args !== "object") return null;
  for (const key of ["block", "item", "action", "shape", "player", "command"]) {
    const v = args[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/** 取坐标三元组。三项都齐才认，缺一个就返回 null，不猜 */
function coordOf(args) {
  if (!args || typeof args !== "object") return null;
  const { x, y, z } = args;
  const nums = [x, y, z].map(Number);
  if (!nums.every((n) => Number.isFinite(n))) return null;
  return `(${Math.round(nums[0])}, ${Math.round(nums[1])}, ${Math.round(nums[2])})`;
}

/**
 * 生成单个步骤的意图。
 * @returns {{verb:string, target:string|null, coord:string|null, text:string}|null}
 */
function intentOfStep(step) {
  if (!step || typeof step.cmd !== "string") return null;

  const verb = INTENT_VERB[step.cmd];
  if (!verb) return null;

  const args = step.args || {};
  const target = CONTEXT_ONLY.has(step.cmd) ? null : targetOf(args);
  const coord = coordOf(args);

  // 既无目标也无坐标 → 这条意图没有任何约束力，不生成
  if (!target && !coord) return null;

  const parts = [verb];
  if (target) parts.push(target);
  if (coord) parts.push(`@${coord}`);

  return { verb, target, coord, text: parts.join(" ") };
}

/**
 * 找出步骤里第一个 ${name} 占位符对应的参数默认值。
 * 参数名可能是 count / amount / times，不能写死。
 */
function paramHintOf(step, params) {
  const args = step && step.args;
  if (!args || typeof args !== "object" || !params) return null;

  for (const value of Object.values(args)) {
    if (typeof value !== "string") continue;
    if (!value.startsWith("${") || !value.endsWith("}")) continue;

    const key = value.slice(2, -1);
    const def = params[key];
    const d = Number(def && def.default);
    if (Number.isFinite(d)) return `${key}=${d}`;
  }
  return null;
}

/**
 * 为整个技能渲染意图层。
 *
 * @param {Array} steps 技能步骤
 * @param {object} params 参数表
 * @returns {string|null} 形如 "Mine oak_log @(-9,129,9) → Collect count=8"
 */
function renderIntent(steps, params) {
  if (!Array.isArray(steps) || !steps.length) return null;

  const parts = [];
  for (const step of steps) {
    const it = intentOfStep(step);
    if (!it) continue;

    const hint = paramHintOf(step, params);
    parts.push(hint ? `${it.text} ${hint}` : it.text);
  }

  return parts.length ? parts.join(" → ") : null;
}

/**
 * 从意图层与报错反推失败归属。
 *
 * - intent_miss：意图指向的目标在当前场景不成立（附近没有 / 视野外）
 * - param_off ：目标存在，但参数不合理（够不着 / 太多）
 * - env       ：环境拒绝（超时 / 被打断 / 断线）
 * - unknown   ：归不进去
 *
 * 前三类的处置方式完全不同：换目标、调参数、等环境。
 * 现有 classifyFailure 只按报错文本分类，分不出 intent_miss 和 param_off。
 *
 * @param {string} intent renderIntent 的结果
 * @param {object} failure 失败明细（含 error）
 * @returns {{cause:string, hint:string}}
 */
function diagnose(intent, failure) {
  const err = String((failure && (failure.error || failure.reason)) || "").toLowerCase();
  const text = String(intent || "");

  if (/not\s*found|no\s*such|找不到|附近没有|empty|没有可用/.test(err)) {
    return {
      cause: "intent_miss",
      hint: text ? `意图指向的目标不在当前场景：${text}` : "意图目标不存在",
    };
  }

  if (/too\s*far|maxdistance|max_distance|超距|exceed|out\s*of\s*range/.test(err)) {
    return {
      cause: "param_off",
      hint: "目标存在但超出可接受距离，需要放宽 maxDistance 或换更近的目标",
    };
  }

  if (/timeout|timed?\s*out|超时|abort|cancel|interrupt/.test(err)) {
    return { cause: "env", hint: "动作被中断或超时，与环境状态有关，不是技能逻辑问题" };
  }

  if (/disconnect|not\s*connected|掉线|connection/.test(err)) {
    return { cause: "env", hint: "连接状态异常，与技能本身无关" };
  }

  return { cause: "unknown", hint: text ? `无法归因，当时意图为：${text}` : "无法归因" };
}

/**
 * 去掉意图里的坐标，供 prompt 索引使用。
 * 技能是跨位置复用的，索引里写死坐标会让模型以为只能在那一点用。
 */
function stripCoord(intent) {
  if (typeof intent !== "string") return "";
  return intent.replace(/\s*@\([^)]*\)/g, "");
}

/**
 * 取意图首段，用于技能索引的一行摘要。
 * @returns {string} 空字符串表示没有可用意图
 */
function indexHint(intent, maxChars = 60) {
  const first = stripCoord(String(intent || "").split("→")[0].trim());
  if (!first) return "";
  return first.length > maxChars ? `${first.slice(0, maxChars - 1)}…` : first;
}

module.exports = {
  INTENT_VERB,
  CONTEXT_ONLY,
  intentOfStep,
  renderIntent,
  diagnose,
  stripCoord,
  indexHint,
};
