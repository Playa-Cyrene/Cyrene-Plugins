"use strict";

/**
 * 路线记忆（RouteMemory）—— 把「怎么走到目标旁边」存下来，下次直接用。
 *
 * ── 它补的是哪一段 ────────────────────────────────────────────────
 * terrain 能回答「该站到哪」，但那是一次性的计算。
 * 同一片地形、同一种目标反复出现时，没必要每次都重新算一遍。
 *
 * 这一层记的是「相对目标方块的偏移路线」：
 *   目标在 (10, 136, -11)，上次站到它东边一格、垫高两格才挖到，
 *   下次换一棵树在 (30, 140, -20)，同样的偏移照样成立。
 *
 * ── 两条纪律 ──────────────────────────────────────────────────────
 * 1. **存相对偏移，不存绝对坐标。**
 *    绝对坐标换个目标就废了。相对目标的位置才是可迁移的经验。
 *
 * 2. **负记忆和正记忆一样重要。**
 *    「这片地形 + 这个目标走不过去」也值得记。没有它，角色会
 *    在同一个悬崖边反复尝试，每次都花十几秒。
 *
 * ── 持久化 ────────────────────────────────────────────────────────
 * <memoryTree>/routes.json，临时文件 + 改名，500ms 防抖。
 * 容量上限、90 天 TTL、负记忆 30 分钟过期。
 */

const fs = require("node:fs");
const path = require("node:path");
const { similarity } = require("./terrain.cjs");

const DEFAULTS = {
  /** 路线有效期：三个月。再久，世界可能已经被改造过 */
  ttlMs: 90 * 24 * 60 * 60 * 1000,
  /** 负记忆有效期：30 分钟。只挡「刚才走不通」，不永久封路 */
  blockedTtlMs: 30 * 60 * 1000,
  /** 地形相似度命中门槛 */
  matchThreshold: 0.85,
  /** 路线条数上限 */
  maxEntries: 300,
  /** 负记忆条数上限 */
  maxBlocked: 200,
  /** 连续失败几次删除路线 */
  maxFailStreak: 2,
  /** 直出前至少跑过几次 */
  minRuns: 2,
  /** 直出所需成功率 */
  minRate: 0.6,
  /** 写盘防抖 */
  saveDebounceMs: 500,
  /** 同一条路线两次复用之间的最短间隔，避免每 tick 重放 */
  minIntervalMs: 2000,
};

function nowMs() {
  return Date.now();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * 绝对坐标步骤 → 相对目标方块的偏移。
 * 只处理带 x/y/z 的动作；jump / pillar 这类没有坐标的原样保留。
 */
function relativizeSteps(steps, targetPos) {
  if (!Array.isArray(steps) || !targetPos) return [];
  return steps.map((step) => {
    const args = { ...(step && step.args ? step.args : {}) };
    if (Number.isFinite(args.x)) args.dx = args.x - targetPos.x;
    if (Number.isFinite(args.y)) args.dy = args.y - targetPos.y;
    if (Number.isFinite(args.z)) args.dz = args.z - targetPos.z;
    delete args.x;
    delete args.y;
    delete args.z;
    return { action: String((step && step.action) || "move"), args };
  });
}

/** 相对偏移步骤 → 当前目标下的绝对坐标 */
function absolutizeSteps(steps, targetPos) {
  if (!Array.isArray(steps) || !targetPos) return [];
  return steps.map((step) => {
    const args = { ...(step && step.args ? step.args : {}) };
    if (Number.isFinite(args.dx)) args.x = targetPos.x + args.dx;
    if (Number.isFinite(args.dy)) args.y = targetPos.y + args.dy;
    if (Number.isFinite(args.dz)) args.z = targetPos.z + args.dz;
    delete args.dx;
    delete args.dy;
    delete args.dz;
    return { action: String((step && step.action) || "move"), args };
  });
}

/** 把磁盘上的条目整理成可信结构，坏数据直接丢 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const terrainKey = String(raw.terrainKey || "");
  const goal = String(raw.goal || "");
  if (!terrainKey || !goal) return null;

  const off = raw.approachOffset;
  const approachOffset =
    off && Number.isFinite(off.x) && Number.isFinite(off.y) && Number.isFinite(off.z)
      ? { x: off.x, y: off.y, z: off.z }
      : null;

  const steps = Array.isArray(raw.steps)
    ? raw.steps
        .filter((s) => s && typeof s.action === "string")
        .slice(0, 12)
        .map((s) => ({ action: s.action, args: s.args && typeof s.args === "object" ? s.args : {} }))
    : [];

  const runs = Math.max(0, Number(raw.runs) || 0);
  const ok = clamp(Number(raw.ok) || 0, 0, runs);

  return {
    id: String(raw.id || `${goal}@${terrainKey.slice(0, 16)}`),
    terrainKey,
    goal,
    approachOffset,
    steps,
    runs,
    ok,
    failStreak: Math.max(0, Number(raw.failStreak) || 0),
    avgMs: Math.max(0, Number(raw.avgMs) || 0),
    lastAt: Math.max(0, Number(raw.lastAt) || 0),
    lastUsedAt: Math.max(0, Number(raw.lastUsedAt) || Number(raw.lastAt) || 0),
  };
}

class RouteMemory {
  /**
   * @param {object} opts
   * @param {string} opts.file 持久化路径（<memoryTree>/routes.json）
   * @param {(msg:string)=>void} [opts.log]
   * @param {object} [opts.config] 覆盖 DEFAULTS
   */
  constructor(opts = {}) {
    this.file = opts.file || null;
    this.log = opts.log || (() => {});

    const cfg = opts.config || {};
    this.ttlMs = Number(cfg.ttlMs) || DEFAULTS.ttlMs;
    this.blockedTtlMs = Number(cfg.blockedTtlMs) || DEFAULTS.blockedTtlMs;
    this.matchThreshold = Number(cfg.matchThreshold) || DEFAULTS.matchThreshold;
    this.maxEntries = Number(cfg.maxEntries) || DEFAULTS.maxEntries;
    this.maxBlocked = Number(cfg.maxBlocked) || DEFAULTS.maxBlocked;
    this.maxFailStreak = Number(cfg.maxFailStreak) || DEFAULTS.maxFailStreak;
    this.minRuns = Number(cfg.minRuns) || DEFAULTS.minRuns;
    this.minRate = Number(cfg.minRate) || DEFAULTS.minRate;
    this.minIntervalMs =
      cfg.minIntervalMs != null ? Number(cfg.minIntervalMs) : DEFAULTS.minIntervalMs;
    this.saveDebounceMs =
      cfg.saveDebounceMs != null ? Number(cfg.saveDebounceMs) : DEFAULTS.saveDebounceMs;

    /** @type {Map<string, object>} */
    this.routes = new Map();
    /** @type {Map<string, object>} */
    this.blocked = new Map();

    this.stats = { recall: 0, hit: 0, learned: 0, blockedHit: 0, invalidated: 0 };
    this.saveTimer = null;

    this.load();
  }

  /* ------------------------------ 持久化 ------------------------------ */

  load() {
    if (!this.file) return;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (e) {
      if (e && e.code !== "ENOENT") this.log(`[route] 读取失败，按空库处理：${e.message}`);
      return;
    }

    for (const item of Array.isArray(raw && raw.routes) ? raw.routes : []) {
      const entry = normalizeEntry(item);
      if (entry) this.routes.set(entry.id, entry);
    }
    for (const item of Array.isArray(raw && raw.blocked) ? raw.blocked : []) {
      const terrainKey = String(item && item.terrainKey ? item.terrainKey : "");
      const goal = String(item && item.goal ? item.goal : "");
      const until = Number(item && item.until) || 0;
      if (terrainKey && goal && until > nowMs()) {
        this.blocked.set(`${goal}@${terrainKey}`, { terrainKey, goal, until });
      }
    }

    this.#trim();
  }

  scheduleSave() {
    if (!this.file || this.saveTimer) return;
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

    const payload = {
      version: 1,
      updatedAt: nowMs(),
      routes: [...this.routes.values()],
      blocked: [...this.blocked.values()],
    };

    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log(`[route] 写盘失败：${e.message}`);
    }
  }

  #trim() {
    const now = nowMs();

    // 过期路线
    for (const [id, entry] of this.routes) {
      if (entry.lastAt && now - entry.lastAt > this.ttlMs) this.routes.delete(id);
    }
    // 过期负记忆
    for (const [id, item] of this.blocked) {
      if (item.until <= now) this.blocked.delete(id);
    }
    // 超限按最近使用淘汰
    if (this.routes.size > this.maxEntries) {
      const sorted = [...this.routes.entries()].sort(
        (a, b) => (a[1].lastUsedAt || a[1].lastAt) - (b[1].lastUsedAt || b[1].lastAt),
      );
      for (let i = 0; i < sorted.length - this.maxEntries; i++) {
        this.routes.delete(sorted[i][0]);
      }
    }
    if (this.blocked.size > this.maxBlocked) {
      const sorted = [...this.blocked.entries()].sort((a, b) => a[1].until - b[1].until);
      for (let i = 0; i < sorted.length - this.maxBlocked; i++) {
        this.blocked.delete(sorted[i][0]);
      }
    }
  }

  /* ------------------------------ 路线查询 ------------------------------ */

  /**
   * 找一条可复用的路线。
   *
   * @param {object} opts
   * @param {string} opts.terrainKey
   * @param {string} opts.goal 例如 "collect:oak_log"
   * @param {{x:number,y:number,z:number}} opts.targetPos
   * @param {number} [opts.now]
   * @returns {{entry:object, similarity:number, approach:object|null, steps:Array}|null}
   */
  recall(opts = {}) {
    this.stats.recall += 1;

    const terrainKey = String(opts.terrainKey || "");
    const goal = String(opts.goal || "");
    const targetPos = opts.targetPos;
    if (!terrainKey || !goal || !targetPos) return null;

    const now = Number.isFinite(opts.now) ? opts.now : nowMs();
    let best = null;
    let bestScore = 0;

    for (const entry of this.routes.values()) {
      if (entry.goal !== goal) continue;
      if (entry.runs < this.minRuns) continue;
      if (entry.runs && entry.ok / entry.runs < this.minRate) continue;
      if (entry.lastAt && now - entry.lastAt > this.ttlMs) continue;
      if (this.minIntervalMs > 0 && entry.lastAt && now - entry.lastAt < this.minIntervalMs) {
        continue;
      }

      const score = similarity(entry.terrainKey, terrainKey);
      if (score < this.matchThreshold) continue;
      if (score > bestScore) {
        best = entry;
        bestScore = score;
      }
    }

    if (!best) return null;

    this.stats.hit += 1;
    best.lastUsedAt = now;
    this.scheduleSave();

    return {
      entry: best,
      similarity: Math.round(bestScore * 1000) / 1000,
      approach: best.approachOffset
        ? {
            x: targetPos.x + best.approachOffset.x,
            y: targetPos.y + best.approachOffset.y,
            z: targetPos.z + best.approachOffset.z,
          }
        : null,
      steps: absolutizeSteps(best.steps, targetPos),
    };
  }

  /**
   * 记住一次路线结果。
   *
   * @param {object} opts
   * @param {string} opts.terrainKey
   * @param {string} opts.goal
   * @param {{x:number,y:number,z:number}} opts.targetPos
   * @param {{x:number,y:number,z:number}} [opts.approach]
   * @param {Array} opts.steps 绝对坐标步骤
   * @param {boolean} opts.ok
   * @param {number} [opts.ms]
   * @returns {object|null} 更新后的条目
   */
  remember(opts = {}) {
    const terrainKey = String(opts.terrainKey || "");
    const goal = String(opts.goal || "");
    const targetPos = opts.targetPos;
    if (!terrainKey || !goal || !targetPos) return null;

    // 同 goal + 高相似地形视为同一条路线；换个目标位置不用新建
    let entry = null;
    let entryId = null;
    for (const [id, item] of this.routes) {
      if (item.goal !== goal) continue;
      if (similarity(item.terrainKey, terrainKey) >= 0.95) {
        entry = item;
        entryId = id;
        break;
      }
    }

    if (!entry) {
      entryId = `route:${goal}@${terrainKey.slice(0, 18)}:${this.routes.size}`;
      entry = {
        id: entryId,
        terrainKey,
        goal,
        approachOffset: opts.approach
          ? {
              x: opts.approach.x - targetPos.x,
              y: opts.approach.y - targetPos.y,
              z: opts.approach.z - targetPos.z,
            }
          : null,
        steps: relativizeSteps(opts.steps, targetPos),
        runs: 0,
        ok: 0,
        failStreak: 0,
        avgMs: 0,
        lastAt: 0,
        lastUsedAt: 0,
      };
    } else if (opts.ok) {
      // 成功时更新为最新一次有效的相对路线
      entry.terrainKey = terrainKey;
      if (opts.approach) {
        entry.approachOffset = {
          x: opts.approach.x - targetPos.x,
          y: opts.approach.y - targetPos.y,
          z: opts.approach.z - targetPos.z,
        };
      }
      entry.steps = relativizeSteps(opts.steps, targetPos);
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
    const now = nowMs();
    entry.lastAt = now;
    entry.lastUsedAt = now;

    // 连续失败到线：这条路线不再可信
    if (entry.failStreak >= this.maxFailStreak) {
      this.routes.delete(entryId);
      this.stats.invalidated += 1;
      this.scheduleSave();
      return null;
    }

    this.routes.set(entryId, entry);
    this.stats.learned += 1;
    this.#trim();
    this.scheduleSave();
    return entry;
  }

  /* ------------------------------ 负记忆 ------------------------------ */

  /** 标记「这片地形 + 这个目标走不通」 */
  rememberBlocked(opts = {}) {
    const terrainKey = String(opts.terrainKey || "");
    const goal = String(opts.goal || "");
    if (!terrainKey || !goal) return false;

    const now = nowMs();
    const ttl = Number.isFinite(opts.ttlMs) ? opts.ttlMs : this.blockedTtlMs;
    const key = `${goal}@${terrainKey}`;
    this.blocked.set(key, { terrainKey, goal, until: now + ttl });
    this.#trim();
    this.scheduleSave();
    return true;
  }

  /** 这片地形 + 这个目标是不是刚被判定走不通 */
  isBlocked(opts = {}) {
    const terrainKey = String(opts.terrainKey || "");
    const goal = String(opts.goal || "");
    if (!terrainKey || !goal) return false;

    const now = Number.isFinite(opts.now) ? opts.now : nowMs();
    for (const [id, item] of this.blocked) {
      if (item.until <= now) {
        this.blocked.delete(id);
        continue;
      }
      if (item.goal !== goal) continue;
      if (similarity(item.terrainKey, terrainKey) >= this.matchThreshold) {
        this.stats.blockedHit += 1;
        return true;
      }
    }
    return false;
  }

  /**
   * 手动清除负记忆。
   *
   * 不传参数清全部；传 goal / terrainKey 只清匹配项。
   * 用途：地形被改造过、或者想立刻重试一次，不必等 30 分钟 TTL。
   *
   * @returns {number} 清掉的条数
   */
  clearBlocked(opts = {}) {
    const goal = String(opts.goal || "");
    const terrainKey = String(opts.terrainKey || "");

    let removed = 0;
    for (const [id, item] of [...this.blocked]) {
      if (goal && item.goal !== goal) continue;
      if (terrainKey && similarity(item.terrainKey, terrainKey) < this.matchThreshold) continue;
      this.blocked.delete(id);
      removed += 1;
    }

    if (removed) this.scheduleSave();
    return removed;
  }

  /* ------------------------------ 统计 ------------------------------ */

  snapshot() {
    return {
      file: this.file,
      routes: this.routes.size,
      blocked: this.blocked.size,
      stats: { ...this.stats },
      config: {
        ttlMs: this.ttlMs,
        blockedTtlMs: this.blockedTtlMs,
        matchThreshold: this.matchThreshold,
        maxEntries: this.maxEntries,
        minRuns: this.minRuns,
        minRate: this.minRate,
        minIntervalMs: this.minIntervalMs,
      },
    };
  }

  /** 只读列出路线，给 skill action=routes 用 */
  list() {
    return [...this.routes.values()]
      .slice()
      .sort((a, b) => (b.runs ? b.ok / b.runs : 0) - (a.runs ? a.ok / a.runs : 0));
  }
}

module.exports = {
  RouteMemory,
  relativizeSteps,
  absolutizeSteps,
  DEFAULTS,
};
