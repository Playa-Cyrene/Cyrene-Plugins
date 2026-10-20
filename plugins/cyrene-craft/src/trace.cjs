"use strict";

/**
 * 轨迹录制（L0 表层）
 *
 * 职责只有一个：把每次工具调用的「做了什么、成没成、花了多久」忠实落盘，
 * 供上层编译器从真实成功轨迹里生成技能。
 *
 * 设计纪律（很重要）：
 *   - 录制是旁路。任何写盘失败都只 log，绝不抛给调用方——工具该成功就成功。
 *   - 写盘不 await，不让磁盘 IO 拖慢工具响应。
 *   - 技能执行产生的轨迹带 origin="skill"，不参与技能编译，避免自我循环。
 *   - 一次工具调用 = 一条记录。多步采集内部的 dig 不单独成条（那是运行时内部行为）。
 *
 * 文件布局：
 *   traces/current.jsonl          当前正在写的文件
 *   traces/archive-<ts>.jsonl     滚动归档（最多 5 个）
 */

const fs = require("node:fs");
const path = require("node:path");

/** 单文件上限：超过就滚动，避免无限增长 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** 最多保留几个归档 */
const MAX_ARCHIVES = 5;

/** episode 切分阈值：相邻两条记录间隔超过这个时间就断开 */
const EPISODE_GAP_MS = 15_000;

/** 参数截断长度：避免把整包 base64 之类的东西写进轨迹 */
const MAX_ARG_TEXT = 500;

/**
 * sequence 的嵌套深度预算。
 *
 * 轨迹是给编译器读的，堆叠的 sequence 会把真正的动作埋在 args.steps.steps 里，
 * 编译器既看不出动作，还会把嵌套结构当成参数原样复制进技能。
 * 所以先摊平：一层 sequence 展开成它实际的步骤序列。
 */
const MAX_SEQUENCE_DEPTH = 3;

/**
 * 把一次调用展开成「实际动作」列表。
 *
 * sequence 只是一层包装，真正的动作在 steps 里。如果照原样记录，
 * 编译器只能看到一条名叫 sequence 的记录、参数是一坨嵌套结构，
 * 编出来的技能既不认识动作，也会把 [deep] 这种占位符复刻进去。
 *
 * 展开为空时退回原记录，宁可记原始信息，也不要凭空丢一条轨迹。
 */
function flattenCall(tool, args, depth = 0) {
  const steps = args && Array.isArray(args.steps) ? args.steps : null;
  if (tool !== "sequence" || !steps) return [{ tool, args }];
  if (depth >= MAX_SEQUENCE_DEPTH) return [];

  const out = [];
  for (const st of steps) {
    if (!st || typeof st.cmd !== "string") continue;
    const childArgs = st.args && typeof st.args === "object" ? st.args : {};
    out.push(...flattenCall(st.cmd, childArgs, depth + 1));
  }
  return out;
}

/**
 * 把参数压成可存储的形式。
 * 只保留可读的结构信息，超长字符串截断，base64/二进制类直接省略。
 */
function shrinkArgs(args) {
  if (args == null) return null;
  if (typeof args !== "object") return String(args).slice(0, MAX_ARG_TEXT);

  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (value == null) continue;

    if (typeof value === "string") {
      // 明显是二进制块的东西不记内容，只记长度
      if (value.length > MAX_ARG_TEXT) {
        out[key] = `[${value.length} chars]`;
      } else {
        out[key] = value;
      }
      continue;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }

    if (Array.isArray(value)) {
      // steps 这类数组保留结构，但深度有限
      out[key] = value.length > 20 ? `[${value.length} items]` : value.map((v) => shrinkValue(v, 1));
      continue;
    }

    out[key] = shrinkValue(value, 1);
  }
  return out;
}

/** 递归压缩值，限制深度，防止恶意/异常深的结构写爆文件 */
function shrinkValue(value, depth) {
  if (depth > 2) return "[deep]";
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > MAX_ARG_TEXT ? `[${value.length} chars]` : value;
  if (Array.isArray(value)) return value.length > 20 ? `[${value.length} items]` : value.map((v) => shrinkValue(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = shrinkValue(v, depth + 1);
    return out;
  }
  return "[?]";
}

/**
 * 诊断摘要：只保留排查需要的结构，不把工具完整返回写进轨迹。
 * 目前用于 collect 的接近路线（strategy / tried / approachReason）。
 */
function shrinkDetail(detail) {
  if (!detail || typeof detail !== "object") return null;

  const out = {};
  if (detail.terrainKey) out.terrainKey = String(detail.terrainKey).slice(0, 80);
  if (detail.strategy) out.strategy = String(detail.strategy).slice(0, 24);

  const reason = detail.approachReason || detail.reason;
  if (reason) out.reason = String(reason).slice(0, 200);

  if (detail.approach && typeof detail.approach === "object") {
    const { x, y, z } = detail.approach;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      out.approach = { x, y, z };
    }
  }

  if (Array.isArray(detail.tried) && detail.tried.length) {
    out.tried = detail.tried.slice(0, 8).map((item) => {
      const row = { kind: String((item && item.kind) || "?") };
      if (item && Number.isFinite(item.dist)) row.dist = item.dist;
      if (item && item.error) row.error = String(item.error).slice(0, 100);
      return row;
    });
  }

  return Object.keys(out).length ? out : null;
}

class TraceLogger {
  /**
   * @param {object} opts
   * @param {string} opts.dir      轨迹目录（<dataDir>/traces）
   * @param {(msg:string)=>void} opts.log
   * @param {boolean} opts.enabled 总开关，关闭后 record() 直接返回
   */
  constructor(opts) {
    this.dir = path.resolve(opts.dir);
    this.log = opts.log || (() => {});
    this.enabled = opts.enabled !== false;

    /** 单文件上限，允许测试或特殊部署时调小 */
    this.maxFileBytes = Math.max(1024, Number(opts.maxFileBytes) || MAX_FILE_BYTES);

    /** 内存里保留最近若干条，供 compile 取「最近一段」时免读盘 */
    this.recent = [];
    this.recentLimit = 400;

    /** 订阅者：Web 前端实时推送用 */
    this.listeners = new Set();

    /** 当前文件已写字节数，用于判断滚动 */
    this.currentBytes = 0;

    /** 待写队列，串行落盘 */
    this.queue = [];
    this.flushing = false;

    this.ensureDir();

    // 从磁盘恢复最近的轨迹到内存。
    //
    // 不恢复的话插件一重启就失忆：类脑决策图是从 recent 建的，
    // 内存一空图就归零，边权是长期统计出来的东西，每次重启重新攒
    // 等于永远学不会。实跑时就是这样 —— 重启后图只剩 4 节点 3 边，
    // 边权 count=1 被 MIN_EDGE_SUPPORT 判为 0，扩散失效只能走一步。
    //
    // enabled=false 时不恢复：那是「完全不记录」的语义，
    // 连历史都不该往内存里装。
    if (this.enabled) this.restoreRecent();
  }

  /**
   * 从 current.jsonl 尾部读一段填进 recent。
   *
   * 只读尾部而不是整文件：轨迹文件上限 8MB，全量解析没必要，
   * recentLimit 只有 400 条。读 512KB 足够覆盖这个量级。
   */
  restoreRecent() {
    try {
      if (!fs.existsSync(this.currentFile)) return;

      const size = fs.statSync(this.currentFile).size;
      if (!size) return;

      const maxBytes = 512 * 1024;
      const start = Math.max(0, size - maxBytes);
      const length = size - start;

      const fd = fs.openSync(this.currentFile, "r");
      let text = "";
      try {
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, start);
        text = buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }

      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      // 从文件中间开始读时，第一行多半是半条，丢掉
      if (start > 0 && lines.length) lines.shift();

      const rows = [];
      for (const line of lines) {
        try {
          rows.push(JSON.parse(line));
        } catch {
          /* 半行或损坏行跳过，不影响其余 */
        }
      }

      this.recent = rows.slice(-this.recentLimit);
      this.log(`[trace] 已从磁盘恢复 ${this.recent.length} 条轨迹到内存`);
    } catch (e) {
      this.log(`[trace] 恢复内存缓冲失败（不影响主流程）：${e.message}`);
    }
  }

  ensureDir() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (e) {
      this.log(`[trace] 建目录失败（不影响主流程）：${e.message}`);
    }
  }

  get currentFile() {
    return path.join(this.dir, "current.jsonl");
  }

  /** 读当前文件大小，初始化 currentBytes */
  syncSize() {
    try {
      this.currentBytes = fs.statSync(this.currentFile).size;
    } catch {
      this.currentBytes = 0;
    }
  }

  /**
   * 记录一次工具调用。
   * 永远不抛错、永远不阻塞调用方。
   *
   * @param {object} entry
   * @param {string} entry.tool   工具 id（不含插件前缀也可）
   * @param {object} entry.args   入参
   * @param {boolean} entry.ok    是否成功
   * @param {number} entry.ms     耗时毫秒
   * @param {string} entry.origin "llm"（默认）或 "skill"
   * @param {string} entry.error  失败原因（可选）
   */
  record(entry) {
    if (!this.enabled) return;

    try {
      const tool = String(entry.tool || "unknown");
      // origin 分五档：
      //   llm       模型发起的动作（正常学习来源）
      //   skill     技能自己跑的（不进图，避免自我强化）
      //   autopilot 执行环自己跑的（只有失败会被记，用来纠正错误的推荐）
      //   reflex    肌肉记忆自己跑的（不进图，但成功失败都要留证据）
      //   autoplay  自主驱动真实跑出来的动作（进图，但边权要打折）
      const origin =
        entry.origin === "skill"
          ? "skill"
          : entry.origin === "autopilot"
            ? "autopilot"
            : entry.origin === "reflex"
              ? "reflex"
              : entry.origin === "autoplay"
                ? "autoplay"
                : "llm";
      const ms = Math.max(0, Math.round(Number(entry.ms) || 0));
      const ok = Boolean(entry.ok);

      // sequence 展开成实际动作；一步 sequence 里放多个动作时，
      // 每条动作各自成一条轨迹，编译器才看得见真正发生了什么。
      const flat = flattenCall(tool, entry.args);
      const expanded = flat.length ? flat : [{ tool, args: entry.args }];

      // 耗时只在单动作时可用，多动作无法分摊，就不编数字
      const perMs = expanded.length === 1 ? ms : 0;

      for (const item of expanded) {
        const row = {
          ts: Date.now(),
          tool: String(item.tool || "unknown"),
          args: shrinkArgs(item.args),
          ok,
          ms: perMs,
          origin,
        };
        if (entry.error) row.error = String(entry.error).slice(0, 300);
        const detail = shrinkDetail(entry.detail);
        if (detail) row.detail = detail;
        this.#push(row);
      }
    } catch (e) {
      this.log(`[trace] 记录失败（不影响主流程）：${e.message}`);
    }
  }

  /** 落一条已组装好的记录：内存缓冲 + 订阅者 + 写盘队列 */
  #push(row) {
    this.recent.push(row);
    if (this.recent.length > this.recentLimit) {
      this.recent.splice(0, this.recent.length - this.recentLimit);
    }

    // 推给 Web 前端；订阅者异常不能影响录制
    for (const fn of this.listeners) {
      try {
        fn(row);
      } catch {
        /* 单个订阅者出错不影响别人 */
      }
    }

    this.queue.push(JSON.stringify(row) + "\n");
    this.#flush();
  }

  /**
   * 订阅新记录。返回取消订阅的函数。
   * @param {(row:object)=>void} fn
   */
  subscribe(fn) {
    if (typeof fn !== "function") return () => {};
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 当前订阅者数量 */
  get subscriberCount() {
    return this.listeners.size;
  }

  /** 串行落盘，不 await */
  #flush() {
    if (this.flushing) return;
    this.flushing = true;

    // 用 setImmediate 把写盘推到当前事件循环之后，避免和工具返回抢时序
    setImmediate(() => {
      try {
        while (this.queue.length) {
          const chunk = this.queue.shift();
          const bytes = Buffer.byteLength(chunk, "utf8");

          if (this.currentBytes + bytes > this.maxFileBytes) {
            this.#roll();
          }

          fs.appendFileSync(this.currentFile, chunk, "utf8");
          this.currentBytes += bytes;
        }
      } catch (e) {
        this.log(`[trace] 写盘失败（不影响主流程）：${e.message}`);
        this.queue.length = 0;
      } finally {
        this.flushing = false;
        // 写入过程中可能又进了新记录
        if (this.queue.length) this.#flush();
      }
    });
  }

  /** 把当前文件挪成归档，并清理超量的旧归档 */
  #roll() {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const target = path.join(this.dir, `archive-${stamp}.jsonl`);
      fs.renameSync(this.currentFile, target);
      this.currentBytes = 0;
      this.#pruneArchives();
    } catch (e) {
      this.log(`[trace] 归档失败，继续写当前文件：${e.message}`);
    }
  }

  /** 只保留最新 MAX_ARCHIVES 个归档 */
  #pruneArchives() {
    try {
      const files = fs
        .readdirSync(this.dir)
        .filter((f) => f.startsWith("archive-") && f.endsWith(".jsonl"))
        .sort();

      while (files.length > MAX_ARCHIVES) {
        const oldest = files.shift();
        try {
          fs.unlinkSync(path.join(this.dir, oldest));
        } catch {
          /* 删不掉就算了，下次再试 */
        }
      }
    } catch (e) {
      this.log(`[trace] 清理归档失败：${e.message}`);
    }
  }

  /**
   * 从内存里的最近记录切出 episode。
   * 相邻两条记录间隔 < EPISODE_GAP_MS 视为同一段连续操作。
   *
   * @param {number} count 往回取几条记录（默认 40）
   * @returns {Array<Array<object>>} episode 列表，最新的在后
   */
  episodes(count = 40) {
    const rows = this.recent.slice(-Math.max(1, Math.min(count, this.recent.length)));
    const out = [];
    let cur = [];

    for (const row of rows) {
      if (!cur.length) {
        cur = [row];
        continue;
      }
      const gap = row.ts - cur[cur.length - 1].ts;
      if (gap > EPISODE_GAP_MS) {
        out.push(cur);
        cur = [row];
      } else {
        cur.push(row);
      }
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /**
   * 取最近一段「成功的、LLM 发起的」episode，供编译器使用。
   * 如果最近一段全是 skill 发起或全失败，继续往前找。
   *
   * @param {number} minSteps 至少几步才算一段可用轨迹
   */
  latestCompilableEpisode(minSteps = 1) {
    const list = this.episodes(120);
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const ep = list[i];
      if (ep.length < minSteps) continue;
      // skill / reflex 都是「已经沉淀过的执行」，再喂回编译器会自我强化。
      if (ep.some((r) => r.origin === "skill" || r.origin === "reflex")) continue;
      if (!ep.every((r) => r.ok)) continue;
      return ep;
    }
    return null;
  }

  /** 内存里的最近记录副本（调试/测试用） */
  snapshot() {
    return this.recent.slice();
  }

  /** 清空内存缓存（不影响磁盘） */
  clearRecent() {
    this.recent.length = 0;
  }
}

module.exports = {
  TraceLogger,
  EPISODE_GAP_MS,
  MAX_FILE_BYTES,
  MAX_ARCHIVES,
};
