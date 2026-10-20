"use strict";

/**
 * 肌肉记忆（Muscle）—— 世界状态 → 下一个动作的直映射。
 *
 * ── 它补的是哪一段 ────────────────────────────────────────────────
 * skill-graph 每次都要从轨迹重建图、再跑能量扩散。算得准，但那是「思考」。
 * 同一个局面反复出现时，人不会再想一遍：看到背包里有斧子、旁边是橡木，
 * 手就伸过去了。这一层就是把那次思考的结果留下来。
 *
 * ── 为什么不含坐标 ────────────────────────────────────────────────
 * 坐标每走一步都变。把坐标放进指纹，缓存活不过三秒。
 * 所以指纹只取那些「决策真正依赖」的粗粒度特征：
 * 维度、昼夜、血量档、饥饿档、背包物资结构、附近可采集种类、当前节点。
 *
 * ── 命中与失效 ────────────────────────────────────────────────────
 * 第一次不命中，第二次也不命中，跑够 minRuns 次、成功率过线才开始直出。
 * 直出之后仍然统计：连续失败 maxFailStreak 次，这条记忆立刻删掉。
 * 记忆不是信仰，是赌注 —— 赌错了就要认。
 *
 * ── 持久化 ────────────────────────────────────────────────────────
 * 写 <dataDir>/muscle.json。写盘不阻塞调用方，500ms 防抖合并，
 * 上限 maxEntries 条，超了按最近使用时间淘汰。
 */

const fs = require("node:fs");
const path = require("node:path");

/** 默认参数 */
const DEFAULTS = {
  /** 记忆有效期：十分钟。再久，世界可能已经不是那个世界 */
  ttlMs: 10 * 60 * 1000,
  /** 至少跑过几次才允许直出 */
  minRuns: 3,
  /** 直出所需成功率 */
  minRate: 0.85,
  /** 记忆条数上限，超出按 LRU 淘汰 */
  maxEntries: 500,
  /** 连续失败几次删掉这条记忆 */
  maxFailStreak: 2,
  /**
   * 同一条记忆两次直出之间的最短间隔。
   *
   * 没有这条，一次成功会把同一个动作变成每 tick 都做的死循环：
   * context 这种只读动作尤其明显，看起来像抽风。
   * 3 秒足够挡住连发，又不会拖慢采集这类本来就要十几秒的动作。
   */
  minIntervalMs: 3000,
  /** 写盘防抖 */
  saveDebounceMs: 500,
};

/**
 * 背包物资分组。
 *
 * 用正则而不是穷举物品表：Minecraft 的物品太多，穷举永远漏。
 * 分组只关心「有没有、够不够做下一步」，不关心具体是哪种木头。
 */
const ITEM_GROUPS = [
  ["axe", /_axe$/],
  ["pickaxe", /_pickaxe$/],
  ["sword", /_sword$/],
  ["shovel", /_shovel$/],
  ["food", /^(bread|cooked_|baked_potato|apple|carrot|potato|beef|porkchop|mutton|chicken|rabbit|cod|salmon|melon_slice|cookie|sweet_berries|dried_kelp|golden_carrot)/],
  ["torch", /^(torch|lantern|glowstone|soul_torch)$/],
  ["log", /_log$/],
  ["planks", /_planks$/],
  ["stone", /^(stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite)$/],
  ["ore", /(_ore$|^raw_|^coal$|^iron_ingot$|^gold_ingot$|^diamond$|^emerald$|^redstone$|^lapis_lazuli$)/],
  ["crafting", /^(crafting_table|furnace|stick)$/],
];

/** 数值分档：决策只关心「有没有 / 多不多」，不关心 17 还是 18 */
function bucket(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0";
  if (v < 5) return "1";
  if (v < 16) return "2";
  return "3";
}

/** 血量/饥饿按 5 点一档 */
function statBucket(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "?";
  return String(Math.max(0, Math.min(4, Math.floor(v / 5))));
}

/**
 * 把背包展开成分组计数。
 * 输入兼容三种形态：{ name: count }、[{ name, count }]、以及 null。
 */
function groupInventory(inventory) {
  const counts = Object.create(null);
  if (!inventory) return counts;

  const entries = Array.isArray(inventory)
    ? inventory.map((it) => [it && it.name, it && it.count])
    : Object.entries(inventory);

  for (const [rawName, rawCount] of entries) {
    const name = String(rawName || "");
    if (!name) continue;
    const count = Number(rawCount) || 1;
    for (const [group, re] of ITEM_GROUPS) {
      if (re.test(name)) counts[group] = (counts[group] || 0) + count;
    }
  }
  return counts;
}

/** 物资结构：固定顺序拼，避免对象键序抖动 */
function inventoryBits(inventory) {
  const counts = groupInventory(inventory);
  return ITEM_GROUPS.map(([group]) => `${group}${bucket(counts[group] || 0)}`).join(",");
}

/** 附近方块：只取前几种，排序后再拼，避免扫描顺序影响指纹 */
function blockBits(blocks) {
  if (!blocks) return "-";
  const names = Array.isArray(blocks)
    ? blocks.map((b) => (typeof b === "string" ? b : b && b.name))
    : typeof blocks === "object"
      ? Object.keys(blocks)
      : [];

  const clean = [...new Set(names.map((n) => String(n || "").trim()).filter(Boolean))]
    .sort()
    .slice(0, 3);
  return clean.length ? clean.join("+") : "-";
}

/**
 * 世界指纹。
 *
 * @param {object} world
 * @param {string} [current] 当前所处节点（skill-graph 的 nodeId）
 * @returns {string}
 */
function fingerprint(world, current = "") {
  const w = world && typeof world === "object" ? world : {};

  const dim = String(w.dimension || "?");
  const day = w.isDay === false || w.isNight === true ? "night" : "day";
  const health = statBucket(w.health);
  const food = statBucket(w.food);
  const inv = inventoryBits(w.inventory);
  const blocks = blockBits(w.blocks || w.blockKinds);
  const node = String(current || "");

  return `${dim}|${day}|h${health}|f${food}|${inv}|${blocks}|${node}`;
}

/** 从磁盘读进来的条目做一次结构校验，坏数据直接丢 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const tool = String(raw.tool || "");
  if (!tool) return null;
  const args = raw.args && typeof raw.args === "object" ? raw.args : {};
  const runs = Math.max(0, Number(raw.runs) || 0);
  const ok = Math.max(0, Math.min(runs, Number(raw.ok) || 0));

  return {
    tool,
    args,
    kind: raw.kind === "skill" ? "skill" : "action",
    name: typeof raw.name === "string" ? raw.name : null,
    runs,
    ok,
    failStreak: Math.max(0, Number(raw.failStreak) || 0),
    /** 最近一次「真的执行了」的时间：TTL 与最短间隔都看它 */
    lastAt: Math.max(0, Number(raw.lastAt) || 0),
    /** 最近一次「被命中查询」的时间：只用于 LRU 淘汰 */
    lastUsedAt: Math.max(0, Number(raw.lastUsedAt) || Number(raw.lastAt) || 0),
    avgMs: Math.max(0, Number(raw.avgMs) || 0),
  };
}

class Muscle {
  /**
   * @param {object} opts
   * @param {string} opts.file  持久化文件路径（<dataDir>/muscle.json）
   * @param {(msg:string)=>void} [opts.log]
   * @param {object} [opts.config] 覆盖 DEFAULTS
   */
  constructor(opts = {}) {
    this.file = opts.file || null;
    this.log = opts.log || (() => {});

    const cfg = opts.config || {};
    this.ttlMs = Number(cfg.ttlMs) || DEFAULTS.ttlMs;
    this.minRuns = Number(cfg.minRuns) || DEFAULTS.minRuns;
    this.minRate = Number(cfg.minRate) || DEFAULTS.minRate;
    this.maxEntries = Number(cfg.maxEntries) || DEFAULTS.maxEntries;
    this.maxFailStreak = Number(cfg.maxFailStreak) || DEFAULTS.maxFailStreak;
    this.minIntervalMs = cfg.minIntervalMs != null ? Number(cfg.minIntervalMs) : DEFAULTS.minIntervalMs;
    this.saveDebounceMs =
      cfg.saveDebounceMs != null ? Number(cfg.saveDebounceMs) : DEFAULTS.saveDebounceMs;

    /** @type {Map<string, object>} */
    this.entries = new Map();
    this.saveTimer = null;
    this.stats = { recall: 0, hit: 0, learn: 0, invalidated: 0 };

    this.load();
  }

  /* ------------------------------ 持久化 ------------------------------ */

  load() {
    if (!this.file) return;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (e) {
      if (e && e.code !== "ENOENT") this.log(`[muscle] 读取失败，按空库处理：${e.message}`);
      return;
    }

    const items = raw && raw.entries && typeof raw.entries === "object" ? raw.entries : {};
    for (const [key, value] of Object.entries(items)) {
      const entry = normalizeEntry(value);
      if (entry) this.entries.set(key, entry);
    }
    this.#trim();
  }

  /** 防抖写盘；进程退出前调用 flush() 可以强制落盘 */
  scheduleSave() {
    if (!this.file) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, this.saveDebounceMs);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  flush() {
    if (!this.file) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    const entries = {};
    for (const [key, entry] of this.entries) entries[key] = entry;

    const payload = {
      version: 1,
      updatedAt: Date.now(),
      entries,
    };

    try {
      const dir = path.dirname(this.file);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // 写盘失败只是丢掉这次记忆，不能让主流程炸掉
      this.log(`[muscle] 写盘失败：${e.message}`);
    }
  }

  /** 超出上限时按「最近用过」淘汰最旧的 */
  #trim() {
    if (this.entries.size <= this.maxEntries) return;
    const sorted = [...this.entries.entries()].sort(
      (a, b) => (a[1].lastUsedAt || a[1].lastAt) - (b[1].lastUsedAt || b[1].lastAt),
    );
    const remove = sorted.length - this.maxEntries;
    for (let i = 0; i < remove; i++) this.entries.delete(sorted[i][0]);
  }

  /* ------------------------------ 读写记忆 ------------------------------ */

  /**
   * 记住一次选择。
   *
   * @param {object} opts
   * @param {object} opts.world   世界状态快照
   * @param {string} [opts.current] 当前节点
   * @param {string} opts.tool
   * @param {object} [opts.args]
   * @param {boolean} opts.ok
   * @param {number} [opts.ms]
   * @returns {object|null} 更新后的条目
   */
  remember(opts = {}) {
    const key = fingerprint(opts.world, opts.current);
    const tool = String(opts.tool || "");
    if (!tool) return null;

    const args = opts.args && typeof opts.args === "object" ? opts.args : {};
    let entry = this.entries.get(key);

    // 同一局面下换了动作：旧记忆作废，从这一次重新学。
    // 不保留旧统计，否则「上次选错了」这件事会被平均掉。
    if (!entry || entry.tool !== tool || JSON.stringify(entry.args) !== JSON.stringify(args)) {
      entry = {
        tool,
        args,
        kind: "action",
        name: null,
        runs: 0,
        ok: 0,
        failStreak: 0,
        lastAt: 0,
        lastUsedAt: 0,
        avgMs: 0,
      };
    }

    entry.runs += 1;
    if (opts.ok) {
      entry.ok += 1;
      entry.failStreak = 0;
    } else {
      entry.failStreak += 1;
    }

    const ms = Number(opts.ms);
    if (Number.isFinite(ms) && ms >= 0) {
      entry.avgMs = entry.avgMs ? Math.round(entry.avgMs * 0.7 + ms * 0.3) : ms;
    }
    const now = Date.now();
    entry.lastAt = now;
    entry.lastUsedAt = now;

    // 连续失败到线：这条记忆不再可信，直接扔掉
    if (entry.failStreak >= this.maxFailStreak) {
      this.entries.delete(key);
      this.stats.invalidated += 1;
      this.scheduleSave();
      return null;
    }

    this.entries.set(key, entry);
    this.stats.learn += 1;
    this.#trim();
    this.scheduleSave();
    return { key, ...entry };
  }

  /**
   * 查记忆。
   *
   * @param {object} opts
   * @param {object} opts.world
   * @param {string} [opts.current]
   * @param {number} [opts.now]
   * @returns {{key:string, tool:string, args:object, kind:string, name:string|null, rate:number, runs:number}|null}
   */
  recall(opts = {}) {
    this.stats.recall += 1;

    const key = fingerprint(opts.world, opts.current);
    const entry = this.entries.get(key);
    if (!entry) return null;

    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    if (entry.runs < this.minRuns) return null;
    if (now - entry.lastAt > this.ttlMs) {
      // 过期条目留着占位没有意义，删掉让新数据进来
      this.entries.delete(key);
      this.scheduleSave();
      return null;
    }

    // 刚做过就别连着做。没有这条，一次成功会让同一个动作每 tick 重放一次。
    if (this.minIntervalMs > 0 && now - entry.lastAt < this.minIntervalMs) return null;

    const rate = entry.runs ? entry.ok / entry.runs : 0;
    if (rate < this.minRate) return null;

    this.stats.hit += 1;
    // 只刷新「被用过」的时间，不动 lastAt ——
    // lastAt 是「上次真的执行」，TTL 和最短间隔都靠它，不能被查询本身推后。
    entry.lastUsedAt = now;
    this.scheduleSave();

    return {
      key,
      tool: entry.tool,
      args: { ...entry.args },
      kind: entry.kind,
      name: entry.name,
      rate,
      runs: entry.runs,
      avgMs: entry.avgMs,
    };
  }

  /**
   * 把一条动作记忆升级成技能记忆。
   * 之后命中就直接跑技能，不用再逐步执行。
   */
  promote(key, skillName) {
    const entry = this.entries.get(key);
    if (!entry || !skillName) return false;
    entry.kind = "skill";
    entry.name = String(skillName);
    this.scheduleSave();
    return true;
  }

  forget(key) {
    const removed = this.entries.delete(key);
    if (removed) this.scheduleSave();
    return removed;
  }

  /** 给状态接口/调试用 */
  snapshot() {
    return {
      file: this.file,
      size: this.entries.size,
      stats: { ...this.stats },
      config: {
        ttlMs: this.ttlMs,
        minRuns: this.minRuns,
        minRate: this.minRate,
        minIntervalMs: this.minIntervalMs,
        maxEntries: this.maxEntries,
      },
    };
  }
}

module.exports = {
  Muscle,
  fingerprint,
  groupInventory,
  inventoryBits,
  blockBits,
  bucket,
  statBucket,
  DEFAULTS,
  ITEM_GROUPS,
};
