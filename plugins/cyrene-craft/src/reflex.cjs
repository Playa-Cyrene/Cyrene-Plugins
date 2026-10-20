"use strict";

/**
 * 反射层（肌肉记忆）
 *
 * 位置：模型之前。
 * 玩家在游戏里说「砍点木头」，如果技能库里已经有一条练熟的采集技能，
 * 就不该再把这句话送进 LLM 重新推理一遍——直接命中、直接执行。
 *
 * 设计纪律：
 *   - 这个文件是纯函数，零 IO、不碰 bridge、不碰文件。
 *     匹配逻辑能离线单测，接线放在 channel 里。
 *   - 宁可漏触发，不可乱触发。误触发的代价是角色在真实世界里做错事，
 *     比多烧一次 token 贵得多。
 *   - 词按长度加权：单字「砍」和长词「工作台」的可信度不一样。
 *   - 否定词优先：说了「不要砍树」，就不许命中。
 */

/** 命中一个词的基础分 */
const BASE_SCORE = 0.45;

/** 同时命中多个词的组合加成 */
const COMBO_BONUS = 0.1;

/** 正则命中的基础分 */
const REGEX_SCORE = 0.8;

/** 分数上限（留一点余量，避免任何单条规则拿到满分） */
const MAX_SCORE = 0.95;

/** 默认自动执行门槛，与计划一致 */
const DEFAULT_MIN_CONFIDENCE = 0.72;

/** 否定词：出现在命中词之前这个窗口内，就不算命中 */
const NEGATIONS = ["不", "别", "不要", "不用", "停", "取消", "算了"];

/** 否定词向前看的窗口长度（字符） */
const NEGATION_WINDOW = 4;

/** 自动执行禁止出现的命令：对外发声、改连接状态、紧急停止都不该由反射层代劳 */
const AUTO_DENY_COMMANDS = new Set(["say", "command", "connect", "disconnect", "stop"]);

/** 单条技能自动执行的步骤上限 */
const MAX_AUTO_STEPS = 30;

/**
 * 归一化文本。
 *
 * NFKC 一次解决全角转半角，然后统一小写、把所有标点换成空格。
 * 中文不做分词——触发词本身就是从中文里切出来的，直接子串匹配更可控。
 */
function normalizeText(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 按码点算长度，避免代理对被算成两个字符 */
function charLength(text) {
  return [...String(text || "")].length;
}

/**
 * 词的可信度权重。
 * 1 字 0.10 / 2 字 0.20 / 3 字 0.28 / 4 字以上 0.35。
 * 单字词必须配合另一个词才能过门槛，这就是「树」不会单独触发采集的原因。
 */
function wordWeight(word) {
  const len = charLength(word);
  if (len <= 1) return 0.1;
  if (len === 2) return 0.2;
  if (len === 3) return 0.28;
  return 0.35;
}

/** 找出 needle 在 text 里的全部出现位置 */
function findPositions(text, needle) {
  const out = [];
  if (!needle) return out;

  let from = 0;
  while (from <= text.length - needle.length) {
    const i = text.indexOf(needle, from);
    if (i === -1) break;
    out.push(i);
    from = i + 1;
  }
  return out;
}

/** 命中位置之前 4 字内是否有否定词 */
function isNegated(text, index) {
  const before = text.slice(Math.max(0, index - NEGATION_WINDOW), index);
  return NEGATIONS.some((n) => before.includes(n));
}

/**
 * 收集一个词的有效命中位置。
 * 同一个词出现多次时，只要有一次没被否定就算命中——
 * 「不要砍树，去砍石头」里的第二个「砍」是有效指令。
 */
function effectiveHits(text, word) {
  const normalized = normalizeText(word);
  if (!normalized) return [];

  return findPositions(text, normalized).filter((i) => !isNegated(text, i));
}

/**
 * 正则命中位置。
 * 用户写的正则可能带 g，统一重建并加 gi；零宽匹配要手动推进，
 * 否则 exec 会在同一个位置无限循环。
 */
function regexHits(text, pattern) {
  let re;
  try {
    re = new RegExp(pattern, "gi");
  } catch {
    return [];
  }

  const hits = [];
  let match;
  let guard = 0;

  while ((match = re.exec(text)) !== null && guard < 50) {
    hits.push(match.index);
    if (match[0].length === 0) re.lastIndex += 1;
    guard += 1;
  }

  return hits.filter((i) => !isNegated(text, i));
}

/** 上下文门禁键 → ctx 字段名 */
const CONTEXT_FIELDS = { minFood: "food", minHealth: "health" };

/**
 * 上下文门禁。
 * 门禁要求了但 ctx 没给值 → 视为不满足。
 * 反射层能拿到的信息本来就少，宁可放过，也不要拿猜测去执行。
 */
function passesContext(gate, ctx) {
  if (!gate || typeof gate !== "object") return true;

  if (gate.requireConnected === true) {
    if (!ctx || ctx.connected !== true) return false;
  }

  for (const key of ["minFood", "minHealth"]) {
    if (!Number.isFinite(Number(gate[key]))) continue;
    const field = CONTEXT_FIELDS[key] || key;
    const actual = Number(ctx && ctx[field]);
    if (!Number.isFinite(actual) || actual < Number(gate[key])) return false;
  }

  return true;
}

/**
 * 用一条技能的触发签名去匹配一句话。
 *
 * @param {string} text 玩家说的话（已去掉聊天前缀）
 * @param {object} skill 技能对象（需要 triggers / stats / steps / safety）
 * @param {object} [ctx] 上下文：{ connected, food, health }
 * @returns {{skill:object, score:number, reason:{words:string[], regex:string[]}}|null}
 */
function matchSkill(text, skill, ctx) {
  if (!skill || typeof skill !== "object") return null;
  if (skill.archived === true) return null;

  const triggers = skill.triggers;
  if (!triggers || typeof triggers !== "object") return null;

  const normalized = normalizeText(text);
  if (!normalized) return null;

  if (!passesContext(triggers.context, ctx)) return null;

  const hitWords = [];
  for (const word of Array.isArray(triggers.words) ? triggers.words : []) {
    if (effectiveHits(normalized, word).length) hitWords.push(String(word));
  }

  const hitRegex = [];
  for (const pattern of Array.isArray(triggers.regex) ? triggers.regex : []) {
    if (regexHits(normalized, pattern).length) hitRegex.push(String(pattern));
  }

  if (!hitWords.length && !hitRegex.length) return null;

  let score = 0;
  if (hitWords.length) {
    score = BASE_SCORE + hitWords.reduce((sum, w) => sum + wordWeight(w), 0);
    if (hitWords.length >= 2) score += COMBO_BONUS;
  }
  if (hitRegex.length) score = Math.max(score, REGEX_SCORE);

  return {
    skill,
    score: Math.round(Math.min(MAX_SCORE, score) * 1000) / 1000,
    reason: { words: hitWords, regex: hitRegex },
  };
}

/**
 * 对整库技能做匹配，按分数降序。
 *
 * @param {string} text
 * @param {Array<object>} skills
 * @param {object} [ctx]
 * @returns {Array<{skill:object, score:number, reason:object}>}
 */
function match(text, skills, ctx) {
  const candidates = [];
  for (const skill of Array.isArray(skills) ? skills : []) {
    const hit = matchSkill(text, skill, ctx);
    if (hit) candidates.push(hit);
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

/**
 * 信心公式：
 *
 *   confidence = score × successRate × min(1, runs / 10)
 *
 * 三个因子缺一不可：
 *   - 匹配得准（score）
 *   - 过去跑得成（successRate）
 *   - 跑得够多（样本系数，10 次才算练熟）
 *
 * 没有样本时 successRate 按 0 处理：新技能再像也不能自动执行，
 * 先让模型跑几次，把统计攒出来。
 */
function confidence(candidate) {
  const skill = candidate && candidate.skill ? candidate.skill : candidate;
  const score = Number(candidate && candidate.score);
  const safeScore = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;

  const stats = (skill && skill.stats) || {};
  const runs = Number(stats.runs) || 0;
  const success = Number(stats.success) || 0;

  const successRate = runs > 0 ? Math.max(0, Math.min(1, success / runs)) : 0;
  const sample = Math.min(1, runs / 10);

  return Math.round(safeScore * successRate * sample * 1000) / 1000;
}

/**
 * 从候选里挑一条可以自动执行的。
 *
 * @param {Array} candidates match 的结果
 * @param {object} [opts]
 * @param {number} [opts.minConfidence=0.72]
 * @returns {object|null} 命中的候选（附 confidence 字段）
 */
function pick(candidates, opts = {}) {
  const raw = Number(opts.minConfidence);
  const minConfidence = Number.isFinite(raw) ? raw : DEFAULT_MIN_CONFIDENCE;

  let best = null;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const conf = confidence(candidate);
    if (conf < minConfidence) continue;
    if (!best || conf > best.confidence) {
      best = { ...candidate, confidence: conf };
    }
  }

  return best;
}

/**
 * 自动执行的安全门禁。
 *
 * 反射层绕过了模型，没有人再替这次执行做最后一道判断，
 * 所以规则必须写死在这里：
 *   - 技能必须显式声明在安全白名单里
 *   - 步骤里不能出现对外发声、执行指令、改连接状态、紧急停止
 *   - 步骤数不能太多（长流程的环境依赖更强，不适合盲跑）
 *   - 归档技能不参与自动执行
 */
function isAutoAllowed(skill) {
  if (!skill || typeof skill !== "object") return false;
  if (skill.archived === true) return false;
  if (!skill.safety || skill.safety.whitelist !== true) return false;

  const steps = Array.isArray(skill.steps) ? skill.steps : [];
  if (!steps.length || steps.length > MAX_AUTO_STEPS) return false;

  for (const step of steps) {
    if (!step || typeof step.cmd !== "string") return false;
    if (AUTO_DENY_COMMANDS.has(step.cmd)) return false;
  }

  return true;
}

module.exports = {
  match,
  matchSkill,
  confidence,
  pick,
  isAutoAllowed,
  normalizeText,
  passesContext,
  DEFAULT_MIN_CONFIDENCE,
  MAX_AUTO_STEPS,
  AUTO_DENY_COMMANDS,
};
