"use strict";

/**
 * 训练面板 Web 服务。
 *
 * 作用：把游戏里跑出来的训练数据实时摆到浏览器上，并且能管理技能库。
 *
 * 安全约束（这个服务带写操作，比文件分享要严）：
 *   1. 只监听 127.0.0.1
 *   2. 所有写操作校验 Origin，拒绝跨站提交
 *   3. 导入只接受 JSON，大小上限 4MB，结构重新规范化，不信任文件内容
 *   4. 路径一律走 SkillStore，不接受任何来自请求的文件路径
 *   5. 删除前必须带 confirmToken，防止误点
 *
 * 实时通道用 SSE（Server-Sent Events）：
 *   比 WebSocket 简单，单向推送够用，浏览器原生支持，断线自动重连。
 */

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

/** 默认端口，避开文件分享的 16050 */
const DEFAULT_PORT = 16051;

/** 导入文件大小上限 */
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

/** SSE 心跳间隔，防止代理/浏览器掐断空闲连接 */
const SSE_HEARTBEAT_MS = 25_000;

/** 目标视图推送节流：连续几步只推最后一份完整视图 */
const GOAL_BROADCAST_MS = 1000;

/** 允许的请求来源（只允许本机同源） */
function isLocalOrigin(origin, port) {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return (
      (u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
      Number(u.port) === Number(port)
    );
  } catch {
    return false;
  }
}

/**
 * 脑区划分：把工具语义映射到皮层分区。
 *
 * 这不是解剖学，是信息组织方式——让「它在想什么」能按功能分区着色，
 * 一眼看出此刻是运动区在放电，还是记忆区在回响。
 */
const REGIONS = [
  {
    id: "motor",
    name: "运动区",
    hint: "动手改变世界",
    color: "#FF5B8A",
    // 额叶运动皮层：移动、挖掘、建造、使用
    tools: ["move", "dig", "build", "act", "give", "command", "stop"],
  },
  {
    id: "sensory",
    name: "感觉区",
    hint: "看与听",
    color: "#5B9BFF",
    // 顶叶感觉皮层：状态、附近、背包
    tools: ["status", "context", "players", "entities", "scan", "map", "height", "inventory", "events"],
  },
  {
    id: "memory",
    name: "记忆区",
    hint: "记住与复用",
    color: "#9B6BFF",
    // 海马与颞叶：技能、轨迹、规则
    tools: ["skill", "rules", "fs"],
  },
  {
    id: "association",
    name: "联合区",
    hint: "组织与决策",
    color: "#FFB84D",
    // 前额叶联合区：采集规划、编队、连接
    tools: ["collect", "craft", "sequence", "connect", "disconnect"],
  },
  {
    id: "limbic",
    name: "边缘区",
    hint: "本能与情绪",
    color: "#4BB377",
    // 边缘系统：本能反射、配置、账户
    tools: ["instincts", "config", "accounts", "watch", "sessions", "capabilities"],
  },
];

/** 工具 → 脑区。查不到归到联合区，语义上最接近「还没分类的认知活动」 */
function regionOf(tool) {
  for (const r of REGIONS) {
    if (r.tools.includes(tool)) return r;
  }
  return REGIONS.find((r) => r.id === "association");
}

/**
 * 把建议翻译成一句人话，让面板上显示的不是裸工具名。
 * 「下一步：去砍橡木」比「collect(block=oak_log)」更像意图。
 */
function describeIntent(pick) {
  if (!pick) return "";
  const a = pick.args || {};
  const tool = pick.tool;

  const target = a.block || a.item || a.player || a.action || a.name || "";

  const MAP = {
    collect: (t) => `去采集 ${t || "资源"}`,
    craft: (t) => `合成 ${t || "物品"}`,
    build: (t) => `用 ${t || "方块"} 建造`,
    dig: () => "挖开面前的方块",
    move: (t) => (t ? `走向 ${t}` : "移动到目标位置"),
    act: (t) => `执行 ${t || "动作"}`,
    give: (t) => `把东西交给 ${t || "对方"}`,
    status: () => "看一眼自己的状态",
    context: () => "感知周围环境",
    scan: () => "搜索附近的方块",
    inventory: () => "清点背包",
    entities: () => "检查附近生物",
  };

  const fn = MAP[tool];
  if (fn) return fn(target);

  return target ? `执行 ${tool}（${target}）` : `执行 ${tool}`;
}

class TrainingPanelServer {
  /**
   * @param {object} opts
   * @param {number} opts.port
   * @param {string} opts.webDir           前端静态文件目录
   * @param {import("./trace.cjs").TraceLogger} opts.trace
   * @param {import("./skill-store.cjs").SkillStore} opts.store
   * @param {() => object} opts.getSnapshot 当前游戏/插件状态
   * @param {(msg:string)=>void} opts.log
   */
  constructor(opts) {
    // port 传 0 表示「让系统挑一个空闲端口」，供测试与临时实例使用。
    // 不能写成 `Number(opts.port) || DEFAULT_PORT`——0 是合法值但会被 || 吃掉。
    const rawPort = Number(opts.port);
    this.port = Number.isFinite(rawPort) && rawPort >= 0 ? rawPort : DEFAULT_PORT;
    this.webDir = path.resolve(opts.webDir);
    this.trace = opts.trace;
    this.store = opts.store;
    this.getSnapshot = opts.getSnapshot || (() => ({}));
    this.log = opts.log || (() => {});

    /**
     * 目标接口。面板只负责传输，视图组装与导入校验由上层注入：
     *   getGoalView()      -> { ok, current, bigGoals, smallGoals, stepLog }
     *   previewGoalGraph() -> { ok, mode, graph, errors, stats }
     *   importGoalGraph()  -> { ok, name, nodes, file, overwritten, errors }
     * 没接线时接口返回明确错误，不让前端拿到 404 猜半天。
     */
    this.getGoalView =
      typeof opts.getGoalView === "function" ? opts.getGoalView : null;
    this.previewGoalGraph =
      typeof opts.previewGoalGraph === "function" ? opts.previewGoalGraph : null;
    this.importGoalGraph =
      typeof opts.importGoalGraph === "function" ? opts.importGoalGraph : null;

    /** 上一次推送目标视图的时刻 / 等待中的节流定时器 */
    this.goalBroadcastAt = 0;
    this.goalTimer = null;

    this.server = null;
    this.actualPort = null;
    this.error = null;

    /** SSE 客户端集合 */
    this.clients = new Set();

    /** 取消订阅函数 */
    this.unsubscribe = null;
  }

  get running() {
    return Boolean(this.server && this.server.listening);
  }

  get baseUrl() {
    return this.actualPort ? `http://127.0.0.1:${this.actualPort}` : null;
  }

  async start() {
    if (this.running) return { ok: true, port: this.actualPort, url: this.baseUrl };

    if (!fs.existsSync(this.webDir)) {
      this.error = `前端目录不存在：${this.webDir}`;
      this.log(`[panel] ${this.error}`);
      return { ok: false, error: this.error };
    }

    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        try {
          this.#handle(req, res);
        } catch (e) {
          this.#json(res, 500, { ok: false, error: e.message });
        }
      });

      server.on("error", (e) => {
        this.error = e.code === "EADDRINUSE" ? `端口 ${this.port} 已被占用` : e.message;
        this.server = null;
        this.log(`[panel] 启动失败：${this.error}`);
        resolve({ ok: false, error: this.error });
      });

      server.listen(this.port, "127.0.0.1", () => {
        this.server = server;
        this.actualPort = server.address().port;
        this.error = null;

        // 订阅轨迹，有新记录就推给所有 SSE 客户端
        this.unsubscribe = this.trace.subscribe((row) => {
          this.broadcast("trace", row);
        });

        this.log(`[panel] 训练面板已启动：${this.baseUrl}`);
        resolve({ ok: true, port: this.actualPort, url: this.baseUrl });
      });
    });
  }

  async stop() {
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch {
        /* ignore */
      }
      this.unsubscribe = null;
    }

    // 主动断开所有 SSE 连接，否则 close 会一直等
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();

    if (this.goalTimer) {
      clearTimeout(this.goalTimer);
      this.goalTimer = null;
    }

    const server = this.server;
    this.server = null;
    this.actualPort = null;
    if (!server) return { ok: true };

    return new Promise((resolve) => {
      server.close(() => resolve({ ok: true }));
      setTimeout(() => {
        try {
          server.closeAllConnections?.();
        } catch {
          /* ignore */
        }
        resolve({ ok: true });
      }, 2000).unref?.();
    });
  }

  /** 给所有 SSE 客户端推一条事件 */
  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  /**
   * 推一份目标视图。
   *
   * 连续几步会连着触发，所以节流成一秒一份；被节流的那次记一个 trailing 定时器，
   * 保证最后一次状态一定会送到，不会被吞掉。
   */
  broadcastGoals(force = false) {
    if (!this.getGoalView) return;

    const now = Date.now();
    if (!force && now - this.goalBroadcastAt >= GOAL_BROADCAST_MS) {
      this.#sendGoals();
      return;
    }

    if (this.goalTimer) return;
    const wait = Math.max(0, GOAL_BROADCAST_MS - (now - this.goalBroadcastAt));
    this.goalTimer = setTimeout(() => {
      this.goalTimer = null;
      this.#sendGoals();
    }, wait);
    this.goalTimer.unref?.();
  }

  /** 立刻组装并推送；组装失败只记日志，不让面板接口停摆 */
  #sendGoals() {
    let view = null;
    try {
      view = this.getGoalView();
    } catch (e) {
      this.log(`[panel] 目标视图组装失败：${e.message}`);
      return;
    }
    if (!view || view.ok === false) return;

    this.goalBroadcastAt = Date.now();
    this.broadcast("goals", view);
  }

  /* ---------------------------- 路由 ---------------------------- */

  #handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.actualPort}`);
    const pathname = url.pathname;

    // SSE 长连接
    if (pathname === "/api/stream" && req.method === "GET") {
      this.#stream(req, res);
      return;
    }

    // 所有接口都不许跨站
    if (pathname.startsWith("/api/") && req.method !== "GET") {
      const origin = req.headers.origin;
      if (origin && !isLocalOrigin(origin, this.actualPort)) {
        this.#json(res, 403, { ok: false, error: "拒绝跨站请求" });
        return;
      }
    }

    if (pathname === "/api/overview" && req.method === "GET") {
      this.#json(res, 200, this.#overview());
      return;
    }

    if (pathname === "/api/traces" && req.method === "GET") {
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 100, 400));
      this.#json(res, 200, { ok: true, traces: this.trace.snapshot().slice(-limit) });
      return;
    }

    if (pathname === "/api/skills" && req.method === "GET") {
      this.#json(res, 200, { ok: true, skills: this.#skillList() });
      return;
    }

    if (pathname === "/api/brain" && req.method === "GET") {
      this.#json(res, 200, this.#brain(url));
      return;
    }

    /* ---- 目标驾驶舱 ---- */

    if (pathname === "/api/goals" && req.method === "GET") {
      if (!this.getGoalView) {
        this.#json(res, 200, { ok: false, error: "目标接口未接线" });
        return;
      }
      try {
        this.#json(res, 200, this.getGoalView());
      } catch (e) {
        this.#json(res, 500, { ok: false, error: `目标视图组装失败：${e.message}` });
      }
      return;
    }

    if (pathname === "/api/goals/preview" && req.method === "POST") {
      this.#goalPreview(req, res);
      return;
    }

    if (pathname === "/api/goals/import" && req.method === "POST") {
      this.#goalImport(req, res);
      return;
    }

    if (pathname === "/api/export" && req.method === "GET") {
      this.#exportBundle(url, res);
      return;
    }

    if (pathname === "/api/import" && req.method === "POST") {
      this.#importBundle(req, res, url);
      return;
    }

    if (pathname === "/api/delete" && req.method === "POST") {
      this.#deleteSkill(req, res);
      return;
    }

    if (pathname === "/api/delete-traces" && req.method === "POST") {
      this.#deleteTraces(req, res);
      return;
    }

    // 静态文件
    if (req.method === "GET" || req.method === "HEAD") {
      this.#static(pathname, req, res);
      return;
    }

    this.#json(res, 405, { ok: false, error: "Method Not Allowed" });
  }

  /* ---------------------------- 数据组装 ---------------------------- */

  #overview() {
    const skills = this.#skillList();
    const recent = this.trace.snapshot();

    // 按工具统计，让前端能看出「训练数据集中在哪些动作上」
    const byTool = new Map();
    for (const row of recent) {
      const key = row.tool;
      const prev = byTool.get(key) || { tool: key, count: 0, ok: 0, fail: 0, totalMs: 0 };
      prev.count += 1;
      if (row.ok) prev.ok += 1;
      else prev.fail += 1;
      prev.totalMs += Number(row.ms) || 0;
      byTool.set(key, prev);
    }

    const toolStats = [...byTool.values()]
      .map((t) => ({
        tool: t.tool,
        count: t.count,
        ok: t.ok,
        fail: t.fail,
        avgMs: t.count ? Math.round(t.totalMs / t.count) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    // 可编译的段落：成功、非 skill 发起、至少 2 步
    const episodes = this.trace.episodes(120);
    const compilable = episodes.filter(
      (ep) => ep.length >= 2 && ep.every((r) => r.ok) && !ep.some((r) => r.origin === "skill"),
    );

    const totalRuns = skills.reduce((s, k) => s + k.stats.runs, 0);
    const totalSuccess = skills.reduce((s, k) => s + k.stats.success, 0);

    return {
      ok: true,
      now: new Date().toISOString(),
      snapshot: this.getSnapshot(),
      stats: {
        traceCount: recent.length,
        skillCount: skills.length,
        totalRuns,
        totalSuccess,
        successRate: totalRuns ? totalSuccess / totalRuns : null,
        compilableEpisodes: compilable.length,
        sseClients: this.clients.size,
      },
      toolStats,
      skills,
      recentTraces: recent.slice(-40).reverse(),
    };
  }

  /**
   * 类脑决策快照：把 skill-graph 的图与建议整理成前端能直接画的形状。
   *
   * 前端要的是「大脑分区 + 意图 + 下一步」，所以这里做三件事：
   *   1. 把动作节点按脑区归类（运动 / 感觉 / 记忆 / 联合 / 边缘）
   *   2. 算出当前节点与能量扩散结果
   *   3. 给出下一步建议与候选，连门禁判定原因一起带上
   *
   * 图是纯算术，每次请求现建，不缓存——轨迹随时在变，缓存的图会骗人。
   */
  #brain(url) {
    const { buildGraph, nextAction, nodeIdOf, diffuse, globalScore } = require("./skill-graph.cjs");

    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 6, 20));
    const rows = this.trace.snapshot();

    if (!rows.length) {
      return {
        ok: true,
        empty: true,
        reason: "还没有轨迹，先在游戏里跑几次动作",
        regions: [],
        nodes: [],
        edges: [],
        intent: null,
        next: null,
        stats: { nodes: 0, edges: 0, episodes: 0 },
      };
    }

    const graph = buildGraph(rows, { now: Date.now() });

    // 当前节点：从最后一条真实动作推。这份快照本身就是「昔涟此刻在想什么」。
    // autopilot 的失败记录要排除：那件事没做成，世界没动，拿它当起点会从错位置扩散。
    const lastAction = [...rows]
      .reverse()
      .find((r) => r && r.tool && r.origin !== "skill" && r.origin !== "autopilot");
    const current = lastAction ? nodeIdOf(lastAction.tool, lastAction.args) : "";

    // 世界状态：面板拿不到完整背包，能拿多少拿多少
    const snap = this.getSnapshot() || {};
    const world = {
      current,
      connected: snap.status ? snap.status.connected !== false : undefined,
      health: snap.status && snap.status.health,
      oxygen: snap.status && snap.status.oxygen,
      inventory: snap.status && snap.status.inventory,
    };

    const result = nextAction(graph, world, { limit });
    let energy = current ? diffuse(graph, current) : new Map();

    // 当前节点没有出边时（刚做完链条最后一个动作），扩散结果为空。
    // 这时前端不该显示「所有脑区都是 0」——那看起来像坏了。
    // 退回全局评分，让脑区亮度反映「整个图里哪类动作最有分量」。
    const fallback = energy.size === 0;
    if (fallback) energy = globalScore(graph);

    // 按脑区归类：动作语义 → 皮层分区
    const regions = REGIONS.map((r) => ({ ...r, count: 0, energy: 0 }));

    const nodes = [];
    for (const [id, n] of graph.nodes) {
      const region = regionOf(n.tool);
      const e = energy.get(id);
      const rate = n.runs ? n.success / n.runs : 0;

      nodes.push({
        id,
        tool: n.tool,
        args: n.args,
        region: region.id,
        runs: n.runs,
        success: n.success,
        fail: n.fail,
        successRate: rate,
        avgMs: n.runs ? Math.round(n.totalMs / n.runs) : 0,
        energy: e ? e.energy : 0,
        hop: e ? e.hop : null,
        isCurrent: id === current,
      });

      const bucket = regions.find((r) => r.id === region.id);
      if (bucket) {
        bucket.count += 1;
        bucket.energy += e ? e.energy : 0;
      }
    }

    const edges = [...graph.edges.values()]
      .filter((e) => e.weight > 0)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 60)
      .map((e) => ({
        from: e.from,
        to: e.to,
        count: e.count,
        weight: Number(e.weight.toFixed(4)),
        successRate: e.count ? e.success / e.count : 0,
      }));

    return {
      ok: true,
      empty: false,
      now: new Date().toISOString(),
      current,
      currentTool: lastAction ? lastAction.tool : null,
      regions,
      nodes,
      edges,
      energy: nodes.map((n) => ({ id: n.id, energy: Number(n.energy.toFixed(4)), hop: n.hop })),
      energyMode: fallback ? "global" : "diffuse",
      intent: result.pick
        ? {
            text: describeIntent(result.pick),
            tool: result.pick.tool,
            args: result.pick.args,
            score: Number(result.pick.score.toFixed(4)),
            successRate: result.pick.successRate,
            runs: result.pick.runs,
          }
        : null,
      next: result.pick
        ? {
            tool: result.pick.tool,
            args: result.pick.args,
            hop: result.pick.hop,
            via: result.pick.via,
            score: Number(result.pick.score.toFixed(4)),
          }
        : null,
      candidates: result.candidates.map((c) => ({
        id: c.id,
        tool: c.tool,
        args: c.args,
        score: Number(c.score.toFixed(4)),
        energy: Number(c.energy.toFixed(4)),
        hop: c.hop,
        via: c.via,
        runs: c.runs,
        successRate: c.successRate,
        avgMs: c.avgMs,
        blocked: false,
      })),
      blocked: this.#blockedNodes(graph, world),
      note: result.note || "",
      stats: {
        nodes: graph.nodes.size,
        edges: graph.edges.size,
        episodes: graph.episodes,
        transitions: graph.transitions,
        traceCount: rows.length,
      },
    };
  }

  /** 门禁挡住的节点单独列出来：让用户知道「它想过但做不了」 */
  #blockedNodes(graph, world) {
    const { gate } = require("./skill-graph.cjs");
    const out = [];
    for (const [id, n] of graph.nodes) {
      const g = gate(n, world);
      if (!g.pass) out.push({ id, tool: n.tool, args: n.args, reason: g.reason });
      if (out.length >= 12) break;
    }
    return out;
  }

  #skillList() {    return this.store.listNames().map((name) => {
      const skill = this.store.get(name);
      if (!skill) return { name, broken: true };
      const rate = this.store.successRate(skill);
      const durations = skill.stats.durations || [];
      let medianMs = null;
      if (durations.length) {
        const sorted = [...durations].sort((a, b) => a - b);
        medianMs = sorted[Math.floor(sorted.length / 2)];
      }
      return {
        name: skill.name,
        description: skill.description,
        level: skill.level,
        steps: skill.steps,
        params: skill.params,
        preconditions: skill.preconditions,
        stats: { ...skill.stats, successRate: rate, medianMs },
        createdAt: skill.createdAt,
        updatedAt: skill.updatedAt,
      };
    });
  }

  /* ---------------------------- 导出 ---------------------------- */

  #exportBundle(url, res) {
    const namesParam = url.searchParams.get("names");
    const names = namesParam ? namesParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const withStats = url.searchParams.get("stats") !== "0";

    const bundle = this.store.exportBundle({ names, withStats });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const filename = `cyrene-skills-${stamp}.json`;

    const body = JSON.stringify(bundle, null, 2);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": Buffer.byteLength(body, "utf8"),
      "cache-control": "no-store",
    });
    res.end(body);
  }

  /* ---------------------------- 导入 ---------------------------- */

  #importBundle(req, res, url) {
    const onConflict = url.searchParams.get("onConflict") || "skip";
    const chunks = [];
    let size = 0;
    let aborted = false;

    req.on("data", (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_IMPORT_BYTES) {
        aborted = true;
        this.#json(res, 413, { ok: false, error: `文件超过 ${MAX_IMPORT_BYTES} 字节上限` });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return;
      let bundle;
      try {
        bundle = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (e) {
        this.#json(res, 400, { ok: false, error: `JSON 解析失败：${e.message}` });
        return;
      }

      try {
        const result = this.store.importBundle(bundle, { onConflict });
        this.log(
          `[panel] 导入技能：新增 ${result.added.length}，覆盖 ${result.overwritten.length}，` +
            `跳过 ${result.skipped.length}，改名 ${result.renamed.length}`,
        );
        this.broadcast("skills-changed", { reason: "import" });
        this.#json(res, 200, { ok: true, ...result });
      } catch (e) {
        this.#json(res, 500, { ok: false, error: e.message });
      }
    });

    req.on("error", () => {
      if (!aborted) this.#json(res, 400, { ok: false, error: "读取请求体失败" });
    });
  }

  /* ---------------------------- 目标导入 ---------------------------- */

  /** 预览：只校验与整理，不写盘 */
  #goalPreview(req, res) {
    this.#readJson(req, res, (body) => {
      if (!this.previewGoalGraph) {
        this.#json(res, 200, { ok: false, error: "目标接口未接线" });
        return;
      }

      let result;
      try {
        result = this.previewGoalGraph(body || {});
      } catch (e) {
        this.#json(res, 200, { ok: false, error: `预览失败：${e.message}` });
        return;
      }
      this.#json(res, 200, result);
    });
  }

  /** 导入：校验通过后才写盘，写完立刻推一份新视图 */
  #goalImport(req, res) {
    this.#readJson(req, res, (body) => {
      if (!this.importGoalGraph) {
        this.#json(res, 200, { ok: false, error: "目标接口未接线" });
        return;
      }

      let result;
      try {
        result = this.importGoalGraph(body || {});
      } catch (e) {
        this.#json(res, 200, { ok: false, error: `导入失败：${e.message}` });
        return;
      }

      if (result && result.ok) {
        this.log(
          `[panel] 导入目标图：${result.name}（${result.nodes} 节点` +
            `${result.overwritten ? "，覆盖同名图" : ""}）`,
        );
        this.broadcastGoals(true);
      }
      this.#json(res, 200, result);
    });
  }

  /* ---------------------------- 删除 ---------------------------- */

  #deleteSkill(req, res) {
    this.#readJson(req, res, (body) => {
      const name = String(body.name || "").trim();
      // 防止误点：必须带 confirmToken
      if (body.confirmToken !== `delete:${name}`) {
        this.#json(res, 400, { ok: false, error: "缺少确认标记" });
        return;
      }
      try {
        const r = this.store.remove(name);
        this.broadcast("skills-changed", { reason: "delete", name });
        this.#json(res, 200, { ok: true, ...r });
      } catch (e) {
        this.#json(res, 400, { ok: false, error: e.message });
      }
    });
  }

  #deleteTraces(req, res) {
    this.#readJson(req, res, (body) => {
      if (body.confirmToken !== "clear-traces") {
        this.#json(res, 400, { ok: false, error: "缺少确认标记" });
        return;
      }
      try {
        // 只清内存缓冲与磁盘当前文件，归档留着当历史
        this.trace.clearRecent();
        const file = path.join(this.trace.dir, "current.jsonl");
        if (fs.existsSync(file)) fs.unlinkSync(file);
        this.trace.currentBytes = 0;
        this.broadcast("traces-cleared", { at: new Date().toISOString() });
        this.#json(res, 200, { ok: true });
      } catch (e) {
        this.#json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  /** 读 JSON body，带大小限制 */
  #readJson(req, res, handler) {
    const chunks = [];
    let size = 0;
    let aborted = false;

    req.on("data", (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_IMPORT_BYTES) {
        aborted = true;
        this.#json(res, 413, { ok: false, error: "请求体过大" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return;
      let body;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        body = text ? JSON.parse(text) : {};
      } catch (e) {
        this.#json(res, 400, { ok: false, error: `JSON 解析失败：${e.message}` });
        return;
      }
      try {
        handler(body);
      } catch (e) {
        this.#json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  /* ---------------------------- SSE ---------------------------- */

  #stream(req, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    // 首包：先给一份完整快照，前端不用再多发一次请求
    res.write(`event: hello\ndata: ${JSON.stringify(this.#overview())}\n\n`);

    // 目标视图单独发一份：它有独立的事件名，前端可以直接复用同一个渲染入口
    if (this.getGoalView) {
      try {
        const goals = this.getGoalView();
        if (goals && goals.ok !== false) {
          res.write(`event: goals\ndata: ${JSON.stringify(goals)}\n\n`);
        }
      } catch {
        /* 目标视图坏了不影响轨迹推送 */
      }
    }

    this.clients.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(`event: ping\ndata: ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
        this.clients.delete(res);
      }
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    const cleanupClient = () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    };

    req.on("close", cleanupClient);
    req.on("error", cleanupClient);
  }

  /* ---------------------------- 静态文件 ---------------------------- */

  #static(pathname, req, res) {
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = path.resolve(this.webDir, rel);

    // 穿越检查
    const relCheck = path.relative(this.webDir, target);
    if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    if (stat.isDirectory()) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Directory listing disabled");
      return;
    }

    const ext = path.extname(target).toLowerCase();
    const MIME = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
      // 3D 脑模型：glTF 二进制
      ".glb": "model/gltf-binary",
      ".gltf": "model/gltf+json",
      ".wasm": "application/wasm",
    };

    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": stat.size,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      // 面板里会渲染用户导入的技能名，禁止它被别的页面 iframe
      "x-frame-options": "DENY",
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(target).pipe(res);
  }

  #json(res, code, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(code, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body, "utf8"),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  }
}

module.exports = { TrainingPanelServer, DEFAULT_PORT, MAX_IMPORT_BYTES, isLocalOrigin };
