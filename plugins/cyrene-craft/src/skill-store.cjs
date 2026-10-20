"use strict";

/**
 * 技能库（L1 里层存储）
 *
 * 技能是「一次验证成功的操作序列」的结构化产物，持久化在记忆树里：
 *   <memoryTree>/skills/<name>.json
 *
 * 为什么放记忆树：
 *   记忆树已有完整的路径越界保护，AI 可以自己读、自己改、自己删技能，
 *   跨会话保留，重启不丢。轨迹属于机器数据，才放在 dataDir/traces。
 *
 * 设计纪律：
 *   - 只接受相对路径，拒绝绝对路径与 .. 逃逸
 *   - 单个技能文件上限 4MB
 *   - 写入走「临时文件 + 改名」，避免写一半崩掉留下坏文件
 *   - 非法技能名直接拒绝，不做「尽力修正」
 */

const fs = require("node:fs");
const path = require("node:path");

/** 技能索引里用意图层做摘要，比类别名更能说明「这个技能想达成什么」 */
const { indexHint, diagnose } = require("./skill-intent.cjs");

/**
 * 触发签名的提取器住在编译器里。
 * 依赖方向是单向的：store → compiler → intent，compiler 不回头引 store，
 * 所以这里不会形成环。
 */
const { extractTriggers } = require("./skill-compiler.cjs");

/** 单技能文件上限 */
const MAX_SKILL_BYTES = 4 * 1024 * 1024;

/**
 * 触发签名的硬上限。
 * 反射层每次收到聊天都要扫一遍所有技能的触发词，这些数字直接决定扫描成本，
 * 也防止手工导入的技能把几句话的说明塞成几百个词。
 */
const TRIGGER_LIMITS = {
  words: 20,
  regex: 5,
  wordChars: 20,
  regexChars: 120,
};

/**
 * 触发签名版本。
 *
 * v1 只从意图层取动词，旧技能没有 intent 时会漏掉「砍」这类同义词。
 * v2 改为同时从步骤命令映射（collect → Mine → 砍/挖/采集）。
 * 读取时发现版本落后就重算，下次 save 自然落盘。
 */
const TRIGGER_VERSION = 2;

/** 技能名规则：字母数字下划线与短横线，1~48 字符 */
const NAME_RE = /^[a-zA-Z0-9_-]{1,48}$/;

/** 技能结构版本，将来改字段用得上 */
const SCHEMA_VERSION = 1;

/** 判断 child 是否严格在 root 内部 */
function isInside(root, child) {
  const rel = path.relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** 把生命值/饥饿值钳到合法范围 */
function clampStat(n) {
  return Math.max(0, Math.min(20, Math.round(n)));
}

/**
 * 触发签名归一化。
 *
 * 外部写入的 triggers 一律重建，不信任原始值：
 *   - 超长词直接丢，不截断（截断后的词更容易误命中）
 *   - 无效正则先编译验证，炸掉的丢弃
 *   - context 只保留认识的三个门禁，其余不往匹配器里带
 */
function normalizeTriggers(raw) {
  const t = raw && typeof raw === "object" ? raw : {};

  const words = [];
  const seen = new Set();
  for (const item of Array.isArray(t.words) ? t.words : []) {
    const w = String(item || "").trim();
    if (!w || w.length > TRIGGER_LIMITS.wordChars) continue;
    if (!/[\u4e00-\u9fa5A-Za-z0-9_]/.test(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    words.push(w);
    if (words.length >= TRIGGER_LIMITS.words) break;
  }

  const regex = [];
  for (const item of Array.isArray(t.regex) ? t.regex : []) {
    const r = String(item || "").trim();
    if (!r || r.length > TRIGGER_LIMITS.regexChars) continue;
    // 匹配器每次收到聊天都会编译这些正则。无效规则在这里就丢掉，
    // 不能让它在热路径上抛异常。
    try {
      new RegExp(r);
    } catch {
      continue;
    }
    if (regex.includes(r)) continue;
    regex.push(r);
    if (regex.length >= TRIGGER_LIMITS.regex) break;
  }

  const context = {};
  const src = t.context && typeof t.context === "object" ? t.context : {};
  if (typeof src.requireConnected === "boolean") context.requireConnected = src.requireConnected;
  for (const key of ["minFood", "minHealth"]) {
    const n = Number(src[key]);
    if (Number.isFinite(n)) context[key] = clampStat(n);
  }

  // 只保留显式声明的版本：旧技能没有版本号，归一化后是 0，
  // ensureTriggers 才能识别出「该重算」，不会被默认值骗过去。
  return { version: Number(t.version) || 0, words, regex, context };
}

/** 技能默认值，保证读出来的对象字段完整 */
function normalizeSkill(raw, name) {
  const s = raw && typeof raw === "object" ? raw : {};
  const steps = Array.isArray(s.steps) ? s.steps : [];

  return {
    schemaVersion: SCHEMA_VERSION,
    name: typeof s.name === "string" && s.name ? s.name : name,
    description: typeof s.description === "string" ? s.description : "",
    // 意图层：由编译器从 steps 推导，只用于解释与归因，不参与执行。
    // 上限 400 字，防止手工导入的技能塞进一整段话吃掉 prompt 预算。
    intent: typeof s.intent === "string" && s.intent ? s.intent.slice(0, 400) : null,
    // 触发签名：反射层在模型之前用它匹配玩家的话。
    // 只影响「能不能被自动执行」，不参与技能本身的执行逻辑。
    triggers: normalizeTriggers(s.triggers),
    level: [1, 2, 3].includes(s.level) ? s.level : 1,
    steps: steps
      .filter((st) => st && typeof st.cmd === "string")
      .map((st) => {
        const out = { cmd: st.cmd, args: st.args && typeof st.args === "object" ? st.args : {} };
        if (typeof st.wait === "number" && st.wait > 0) out.wait = st.wait;
        return out;
      }),
    params: s.params && typeof s.params === "object" ? s.params : {},
    preconditions: s.preconditions && typeof s.preconditions === "object" ? s.preconditions : {},
    stats: {
      runs: Number(s.stats && s.stats.runs) || 0,
      success: Number(s.stats && s.stats.success) || 0,
      fail: Number(s.stats && s.stats.fail) || 0,
      durations: Array.isArray(s.stats && s.stats.durations) ? s.stats.durations.slice(-20) : [],
      lastRunAt: (s.stats && s.stats.lastRunAt) || null,
      // 最近几次失败的原因，L2 归因靠它。只留文本与位置，不存整包结果。
      // cause / hint 是写入时算好的归因结论，读取时原样保留，
      // 否则归一化会把它抹掉，L2 又只能从报错文本重新猜。
      failures: Array.isArray(s.stats && s.stats.failures)
        ? s.stats.failures
            .filter((f) => f && typeof f === "object")
            .slice(-10)
            .map((f) => ({
              at: typeof f.at === "string" ? f.at : null,
              error: String(f.error || "").slice(0, 300),
              step: Number.isFinite(Number(f.step)) ? Number(f.step) : null,
              cmd: typeof f.cmd === "string" ? f.cmd : null,
              intent: typeof f.intent === "string" ? f.intent.slice(0, 400) : null,
              cause: typeof f.cause === "string" ? f.cause : null,
              hint: typeof f.hint === "string" ? f.hint.slice(0, 200) : null,
            }))
        : [],
    },
    safety: {
      idempotent: Boolean(s.safety && s.safety.idempotent),
      whitelist: s.safety ? s.safety.whitelist !== false : true,
      maxDurationMs: Number(s.safety && s.safety.maxDurationMs) || 30000,
    },
    // 归档：不参与排名、反射匹配与自动执行，但保留可查、可恢复。
    // 计划里的退役方式是「归档而非删除」——环境变了，旧流派要能回来。
    archived: s.archived === true,
    archivedAt: typeof s.archivedAt === "string" ? s.archivedAt : null,
    archivedReason: typeof s.archivedReason === "string" ? s.archivedReason.slice(0, 120) : null,
    // 流派竞争状态：连续几次评估低于主流程 60%。
    // 这是跨次状态，只能存在技能里；单次 rank 算不出来。
    competition: {
      weakStreak: Math.max(0, Math.floor(Number(s.competition && s.competition.weakStreak) || 0)),
      lastEvalAt: (s.competition && s.competition.lastEvalAt) || null,
    },
    source: s.source && typeof s.source === "object" ? s.source : {},
    createdAt: s.createdAt || new Date().toISOString(),
    updatedAt: s.updatedAt || new Date().toISOString(),
  };
}

class SkillStore {
  /**
   * @param {object} opts
   * @param {string} opts.rootDir 技能目录（<memoryTree>/skills）
   * @param {(msg:string)=>void} opts.log
   */
  constructor(opts) {
    this.rootDir = path.resolve(opts.rootDir);
    this.log = opts.log || (() => {});
    this.ensure();
  }

  ensure() {
    try {
      fs.mkdirSync(this.rootDir, { recursive: true });
    } catch (e) {
      this.log(`[skill] 建目录失败：${e.message}`);
    }
  }

  /** 校验技能名，非法直接抛错 */
  assertName(name) {
    const text = String(name || "").trim();
    if (!NAME_RE.test(text)) {
      throw new Error(
        `技能名非法：${name}。只允许字母、数字、下划线、短横线，长度 1~48`,
      );
    }
    return text;
  }

  /** 技能文件绝对路径，越界返回 null */
  fileOf(name) {
    const safe = this.assertName(name);
    const abs = path.join(this.rootDir, `${safe}.json`);
    if (!isInside(this.rootDir, abs)) return null;
    return abs;
  }

  /** 列出所有技能名 */
  listNames() {
    this.ensure();
    try {
      return fs
        .readdirSync(this.rootDir)
        .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
        .map((f) => f.slice(0, -5))
        .sort();
    } catch (e) {
      this.log(`[skill] 列目录失败：${e.message}`);
      return [];
    }
  }

  /** 读一个技能；不存在返回 null */
  get(name) {
    const file = this.fileOf(name);
    if (!file || !fs.existsSync(file)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const skill = normalizeSkill(raw, name);
      // 旧技能没有触发签名，读的时候在内存里补一份。
      // 读操作不写盘：技能目录可能被高频轮询，别让读取变成写放大。
      return this.ensureTriggers(skill);
    } catch (e) {
      this.log(`[skill] 读取 ${name} 失败：${e.message}`);
      return null;
    }
  }

  /**
   * 从 steps / description / intent 提取触发签名。
   * 提取失败不能让整个保存流程崩掉——最坏也只是这个技能不能被反射层自动执行。
   */
  triggersFor(skill) {
    try {
      const triggers = extractTriggers(
        Array.isArray(skill && skill.steps) ? skill.steps : [],
        (skill && skill.description) || "",
        (skill && skill.intent) || null,
      );
      // 提取结果显式盖当前版本章；ensureTriggers 靠它判断要不要重算
      return { ...triggers, version: TRIGGER_VERSION };
    } catch (e) {
      this.log(`[skill] 提取触发签名失败：${e.message}`);
      return { version: TRIGGER_VERSION, words: [], regex: [], context: {} };
    }
  }

  /** 触发签名为空或版本落后时补一份（旧技能兼容） */
  ensureTriggers(skill) {
    if (!skill) return skill;
    const t = skill.triggers;
    if (t && t.version === TRIGGER_VERSION && (t.words.length || t.regex.length)) return skill;

    skill.triggers = normalizeTriggers(this.triggersFor(skill));
    return skill;
  }

  /** 保存（覆盖）一个技能，自动补默认值 */
  save(name, skill) {
    const safe = this.assertName(name);
    const file = this.fileOf(safe);
    if (!file) throw new Error(`技能路径越界：${name}`);

    const now = new Date().toISOString();
    const existing = this.get(safe);

    const next = {
      ...skill,
      name: safe,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    // 没有带 triggers、或版本落后，就现提一份：
    // 手动保存和导入的技能走的是同一个提取器，
    // 免得同一套步骤因为来源不同而拿到两套触发词。
    if (
      !next.triggers ||
      typeof next.triggers !== "object" ||
      next.triggers.version !== TRIGGER_VERSION
    ) {
      next.triggers = this.triggersFor(skill);
    }

    const normalized = normalizeSkill(next, safe);

    const data = Buffer.from(JSON.stringify(normalized, null, 2), "utf8");
    if (data.length > MAX_SKILL_BYTES) {
      throw new Error(`技能太大（${data.length} 字节），上限 ${MAX_SKILL_BYTES}`);
    }

    // 临时文件 + 改名，避免写一半崩掉
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
    return normalized;
  }

  /** 删除 */
  remove(name) {
    const safe = this.assertName(name);
    const file = this.fileOf(safe);
    if (!file) throw new Error(`技能路径越界：${name}`);
    if (!fs.existsSync(file)) return { removed: false, name: safe };
    fs.unlinkSync(file);
    return { removed: true, name: safe };
  }

  /**
   * 记录一次执行结果，更新统计。
   * 不存在的技能不做任何事。
   *
   * @param {string} name
   * @param {boolean} ok
   * @param {number} durationMs
   * @param {object} [detail] 失败细节（L2 归因用）：{ error, step, cmd }
   */
  recordRun(name, ok, durationMs, detail = null) {
    const skill = this.get(name);
    if (!skill) return null;

    skill.stats.runs += 1;
    if (ok) skill.stats.success += 1;
    else skill.stats.fail += 1;

    if (!ok && detail && typeof detail === "object") {
      // 归因结论就地算好存下来。
      // L2 读历史失败时不必再依赖当时的报错文本能否复现——
      // 有些错误信息只在那一刻存在（比如「附近没有橡木」），事后重跑未必一样。
      let diagnosis = null;
      try {
        diagnosis = diagnose(skill.intent, detail);
      } catch {
        /* 归因失败不影响记统计 */
      }

      const entry = {
        at: new Date().toISOString(),
        error: String(detail.error || "").slice(0, 300),
        step: Number.isFinite(Number(detail.step)) ? Number(detail.step) : null,
        cmd: typeof detail.cmd === "string" ? detail.cmd : null,
        intent: typeof skill.intent === "string" ? skill.intent.slice(0, 400) : null,
        cause: diagnosis ? diagnosis.cause : null,
        hint: diagnosis ? String(diagnosis.hint).slice(0, 200) : null,
      };
      skill.stats.failures = [...(skill.stats.failures || []), entry].slice(-10);
    }

    if (Number.isFinite(durationMs) && durationMs >= 0) {
      skill.stats.durations.push(Math.round(durationMs));
      if (skill.stats.durations.length > 20) {
        skill.stats.durations.splice(0, skill.stats.durations.length - 20);
      }
    }

    skill.stats.lastRunAt = new Date().toISOString();
    return this.save(name, skill);
  }

  /** 成功率：没跑过返回 null，避免用 0 误导 */
  successRate(skill) {
    const runs = skill && skill.stats ? skill.stats.runs : 0;
    if (!runs) return null;
    return skill.stats.success / runs;
  }

  /**
   * 技能索引：给 prompt 注入用的一句话摘要。
   * 严格控制总长度，避免为了省 token 反而更烧 token。
   */
  index(maxChars = 200) {
    const names = this.listNames();
    if (!names.length) return "";

    const lines = [];
    let used = 0;

    for (const name of names) {
      const skill = this.get(name);
      if (!skill) continue;

      const rate = this.successRate(skill);
      const rateText = rate === null ? "未运行" : `${Math.round(rate * 100)}%`;
      // 优先用意图首段：它比「采集+挖掘 橡木」这种类别名更能让模型判断是否该用。
      // 坐标要剥掉——技能跨位置复用，索引里写死坐标会误导。
      const hint = indexHint(skill.intent);
      const desc = hint || skill.description || skill.steps.map((s) => s.cmd).join("→");
      const line = `${name}（${desc}，成功率 ${rateText}）`;

      // 留一个字符给换行
      if (used + line.length + 1 > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }

    if (!lines.length) return "";
    return `【可用技能】\n${lines.map((l) => `- ${l}`).join("\n")}`;
  }

  /**
   * 导出整个技能库为可传输的对象。
   *
   * @param {object} opts
   * @param {string[]} [opts.names] 只导出这些（不传则全部）
   * @param {boolean} [opts.withStats=true] 是否带上运行统计
   */
  exportBundle(opts = {}) {
    const names = Array.isArray(opts.names) && opts.names.length ? opts.names : this.listNames();
    const withStats = opts.withStats !== false;
    const skills = [];

    for (const name of names) {
      const skill = this.get(name);
      if (!skill) continue;
      if (!withStats) {
        skill.stats = { runs: 0, success: 0, fail: 0, durations: [], lastRunAt: null };
      }
      skills.push(skill);
    }

    return {
      kind: "cyrene-craft-skills",
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      count: skills.length,
      skills,
    };
  }

  /**
   * 从导出的 bundle 导入技能。
   *
   * 安全纪律：
   *   - 只接受结构合法的技能，字段全部重新规范化，不信任文件里的任何原始值
   *   - 名字非法直接跳过，不做「尽力修正」
   *   - 冲突策略：skip（默认，保留本地）/ overwrite（覆盖）/ rename（加后缀并存）
   *
   * @param {object} bundle 传入的 JSON
   * @param {object} opts
   * @param {"skip"|"overwrite"|"rename"} [opts.onConflict="skip"]
   * @param {string} [opts.prefix] rename 时的后缀
   * @returns {{added:string[], skipped:string[], overwritten:string[], renamed:string[], errors:string[]}}
   */
  importBundle(bundle, opts = {}) {
    const onConflict = ["skip", "overwrite", "rename"].includes(opts.onConflict)
      ? opts.onConflict
      : "skip";
    const suffix = String(opts.prefix || "_imported").slice(0, 16);

    const out = { added: [], skipped: [], overwritten: [], renamed: [], errors: [] };

    if (!bundle || typeof bundle !== "object") {
      out.errors.push("文件内容不是合法 JSON 对象");
      return out;
    }

    const list = Array.isArray(bundle.skills)
      ? bundle.skills
      : // 兼容单个技能文件直接导入
        bundle.steps
        ? [{ ...bundle, name: bundle.name || "imported" }]
        : [];

    if (!list.length) {
      out.errors.push("文件里没有找到 skills 数组，也不是单个技能对象");
      return out;
    }

    const existing = new Set(this.listNames());

    for (const raw of list) {
      try {
        if (!raw || typeof raw !== "object") {
          out.errors.push("跳过一条非对象记录");
          continue;
        }

        const rawName = String(raw.name || "").trim();
        if (!NAME_RE.test(rawName)) {
          out.errors.push(`技能名非法，已跳过：${rawName || "(空)"}`);
          continue;
        }

        let targetName = rawName;
        const exists = existing.has(targetName);

        if (exists) {
          if (onConflict === "skip") {
            out.skipped.push(targetName);
            continue;
          }
          if (onConflict === "rename") {
            let n = 1;
            do {
              targetName = `${rawName}${suffix}${n === 1 ? "" : n}`.slice(0, 48);
              n += 1;
            } while (existing.has(targetName) && n < 100);
            if (existing.has(targetName)) {
              out.errors.push(`重名太多无法改写：${rawName}`);
              continue;
            }
          }
          // overwrite 直接用原名覆盖
        }

        // normalizeSkill 会重建全部字段，外部多余字段不会带进来
        const saved = this.save(targetName, {
          description: typeof raw.description === "string" ? raw.description.slice(0, 500) : "",
          level: raw.level,
          steps: raw.steps,
          params: raw.params,
          preconditions: raw.preconditions,
          safety: raw.safety,
          stats: raw.stats,
          source: { importedAt: new Date().toISOString() },
        });

        existing.add(saved.name);

        if (exists && onConflict === "overwrite") out.overwritten.push(saved.name);
        else if (targetName !== rawName) out.renamed.push(`${rawName} → ${targetName}`);
        else out.added.push(saved.name);
      } catch (e) {
        out.errors.push(`导入失败：${e.message}`);
      }
    }

    return out;
  }
}

module.exports = {
  SkillStore,
  MAX_SKILL_BYTES,
  SCHEMA_VERSION,
  TRIGGER_LIMITS,
  TRIGGER_VERSION,
  normalizeSkill,
  normalizeTriggers,
  NAME_RE,
};
