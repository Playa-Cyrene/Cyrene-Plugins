"use strict";

/**
 * cyrene-craft —— 把昔涟接入 Minecraft。
 *
 * 结构：
 *   index.cjs           宿主侧入口：工具注册 / IPC / 弹窗 / 提示词 Provider
 *   src/bridge.cjs      子进程管理（行协议、超时、崩溃重启）
 *   src/bot-runtime.cjs 机器人子进程（mineflayer 封装）
 *   src/channel.cjs     游戏聊天渠道 + 唤醒
 *   src/prompt.cjs      动态状态注入
 *   src/accounts.cjs    账户库（密码走 secrets）
 *   src/memory.cjs      记忆树 .cyrene-craft/
 *   src/share-server.cjs 文件分享（127.0.0.1）
 *   src/png.cjs         纯 JS PNG 编码
 *   src/lan.cjs         局域网广播监听
 *   src/runtime-resolve.cjs mineflayer 运行时解析
 *
 * ⚠️ 已知的 API 差异（写在这里免得后来人踩坑）：
 *   Cyrene 的 tool `execute(args)` **拿不到会话上下文**（没有 DSH 的 exec.agent），
 *   所以做不到「每个对话一个独立机器人」。本插件是全局单实例，
 *   多会话共用同一个游戏角色。这在 COMPAT.md 里有完整说明。
 */

const path = require("node:path");
const fs = require("node:fs");

const { BotBridge } = require("./src/bridge.cjs");
const { resolveRuntime, installRuntime, describe: describeRuntime } = require("./src/runtime-resolve.cjs");
const { AccountStore } = require("./src/accounts.cjs");
const { MemoryStore, ROOT_DIR_NAME } = require("./src/memory.cjs");
const { ShareServer, DEFAULT_PORT } = require("./src/share-server.cjs");
const { MinecraftChannelAdapter } = require("./src/channel.cjs");
const { createPromptProvider } = require("./src/prompt.cjs");
const { Canvas } = require("./src/png.cjs");
const { listenLanBroadcast } = require("./src/lan.cjs");
const { TraceLogger } = require("./src/trace.cjs");
const { SkillStore } = require("./src/skill-store.cjs");
const { SkillRunner } = require("./src/skill-runner.cjs");
const { judgeOutcome } = require("./src/brain-loop.cjs");
const { AutoPlayDriver } = require("./src/autoplay.cjs");
const { GoalTracker } = require("./src/goal.cjs");
const goalStore = require("./src/goal-store.cjs");
const goalGraphLib = require("./src/goal-graph.cjs");
const goalSink = require("./src/goal-sink.cjs");
const goalView = require("./src/goal-view.cjs");
const goalOutline = require("./src/goal-outline.cjs");
const { Muscle } = require("./src/muscle.cjs");
const { RouteMemory } = require("./src/route-memory.cjs");
const { compileEpisode, suggestName } = require("./src/skill-compiler.cjs");
const reflex = require("./src/reflex.cjs");
const tradition = require("./src/tradition.cjs");
const { buildGraph } = require("./src/skill-graph.cjs");
const { analyzeStore, formatReport } = require("./src/skill-insight.cjs");
const { TrainingPanelServer, DEFAULT_PORT: DEFAULT_PANEL_PORT } = require("./src/panel-server.cjs");

const PLUGIN_ID = "cyrene-craft";
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
})();

/** 设置存储键 */
const KEY_SETTINGS = "settings";
const KEY_LAST_SERVER = "lastServer";

/** 默认设置 */
const DEFAULT_SETTINGS = {
  /** 唤醒总开关（默认关，因为每次唤醒都是一轮 LLM 调用） */
  wakeEnabled: false,
  /** 全局唤醒冷却 */
  wakeCooldownMs: 90_000,
  /** 低血阈值 */
  lowHealthThreshold: 6,
  /** 点名关键词 */
  mentions: ["昔涟", "cyrene", "小昔", "希琳"],
  /** 是否响应所有游戏聊天（默认只响应点名） */
  respondToAll: false,
  /**
   * 反射层（肌肉记忆）总开关。
   * 默认关：先观察匹配与命中，确认不会误触发之后再开。
   */
  reflexEnabled: false,
  /** 反射自动执行门槛：匹配分 × 成功率 × 样本系数 */
  reflexMinConfidence: 0.72,
  /** 文件分享端口 */
  sharePort: DEFAULT_PORT,
  /** 默认角色名 */
  defaultUsername: "Cyrene",
  /** 是否把游戏状态注入提示词 */
  injectGameState: true,
  /** 训练面板端口 */
  panelPort: DEFAULT_PANEL_PORT,
  /** 插件加载后是否自动开训练面板 */
  panelAutoStart: true,

  /**
   * 自主驱动：连接成功后，不等模型调用，自己按 tick 走下一步。
   * 默认关：先手动 once 看几次行为，确认不添乱再开。
   */
  autoplayEnabled: false,
  /** 每 tick 间隔（毫秒），一次只走一步 */
  autoplayTickMs: 1200,
  /** 单次进服最多自主运行多久，到点自停 */
  autoplayMaxRuntimeMs: 30 * 60 * 1000,
  /** 血量低于此值让位给本能层 */
  autoplayMinHealth: 8,
  /** 饥饿低于此值让位给本能层 */
  autoplayMinFood: 6,
  /** 玩家说话后暂停这么久，让反射层/模型先处理 */
  autoplayYieldMs: 8000,
  /** 附近这么多格内有玩家就不动手，0 表示不限制 */
  autoplayNearPlayerPause: 0,
  /** 连续这么多个 tick 无事可做就收工 */
  autoplayIdleTicks: 60,
  /** 写图节流：一分钟最多记多少条自主轨迹 */
  autoplayMaxTracePerMin: 40,
  /** 连续成功多少步后尝试编译成技能 */
  autoplayCompileAfter: 3,

  /** 肌肉记忆：多久没被重新验证就作废 */
  muscleTtlMs: 10 * 60 * 1000,
  /** 至少跑过几次才允许直出 */
  muscleMinRuns: 3,
  /** 直出所需成功率 */
  muscleMinRate: 0.85,
  /** 同一动作两次直出之间的最短间隔 */
  muscleMinIntervalMs: 3000,

  /** 地形读取半径 */
  terrainRadius: 16,
  /** 地形指纹降采样格数 */
  terrainCells: 9,
  /** 路线命中所需的地形相似度 */
  routeMatchThreshold: 0.85,
  /** 路线库上限 */
  routeMaxEntries: 300,
  /** 路线有效期（90 天） */
  routeTtlMs: 90 * 24 * 60 * 60 * 1000,
  /** 负记忆有效期（30 分钟） */
  routeBlockedTtlMs: 30 * 60 * 1000,
  /** 路线自动挖挡路方块 */
  allowAutoDig: true,
  /** 路线自动垫高 / 搭桥 */
  allowAutoPlace: true,
};

/** 运行时错误里最容易遇到的几种，翻译成人话 */
function friendlyRuntimeError(e) {
  const msg = String(e && e.message ? e.message : e);
  if (/ECONNREFUSED/i.test(msg)) return `${msg}\n（端口没有服务在监听：确认服务器已开、端口对）`;
  if (/ENOTFOUND/i.test(msg)) return `${msg}\n（域名解析失败：检查地址拼写）`;
  if (/ETIMEDOUT|timeout/i.test(msg)) return `${msg}\n（连接超时：可能是防火墙或地址不通）`;
  if (/Unsupported version/i.test(msg)) return `${msg}\n（服务器版本不被当前 mineflayer 支持）`;
  return msg;
}

const plugin = {
  async register(ctx) {
    /* ---------------------------- 基础路径 ---------------------------- */

    // plugin-data 目录：宿主的 storage 只存 JSON，运行时与文件得自己找地方
    const dataDir = resolveDataDir();
    fs.mkdirSync(dataDir, { recursive: true });

    // Cyrene 的 userData 根：…/Cyrene（plugins/ 与 plugin-data/ 的父目录）
    // 注意不能写 path.dirname(dataDir)，那是 …/Cyrene/plugin-data
    const userDataDir = path.dirname(path.dirname(dataDir));
    const log = (msg) => {
      try {
        ctx.log(`[${PLUGIN_ID}] ${msg}`);
      } catch {
        /* 日志失败不能影响主流程 */
      }
    };

    log(`v${PLUGIN_VERSION} 启用，数据目录 ${dataDir}`);

    /* ---------------------------- 设置 ---------------------------- */

    const readSettings = () => {
      const stored = ctx.storage.get(KEY_SETTINGS);
      if (!stored || typeof stored !== "object") return { ...DEFAULT_SETTINGS };
      return { ...DEFAULT_SETTINGS, ...stored };
    };

    let settings = readSettings();

    const writeSettings = (patch) => {
      settings = { ...settings, ...patch };
      ctx.storage.set(KEY_SETTINGS, settings);
      return settings;
    };

    /* ---------------------------- 运行时 ---------------------------- */

    let runtime = resolveRuntime({ dataDir, userDataDir });
    if (runtime.ok) {
      log(`mineflayer ${runtime.version || "?"} 来自 ${runtime.label}`);
    } else {
      log("未找到现成运行时，首次连接时会尝试自动安装");
    }

    const ensureRuntime = async () => {
      if (runtime.ok) return runtime;
      log("开始自动安装 mineflayer 运行时（可能需要几分钟）…");
      const installed = await installRuntime({ dataDir });
      if (installed.ok) {
        runtime = installed;
        log(`运行时安装完成：${installed.label} ${installed.version || ""}`);
        return installed;
      }
      throw new Error(installed.reason || "无法准备 mineflayer 运行时");
    };

    /* ---------------------------- 桥接与资源 ---------------------------- */

    const bridge = new BotBridge({
      runtimeEntry: path.join(__dirname, "src", "bot-runtime.cjs"),
      nodeModulesDir: runtime.ok ? runtime.dir : null,
      dataDir,
      log,
      onEvent: () => {
        /* 事件已经通过 bridge 的订阅者分发，这里留空 */
      },
    });

    // 运行时可能是后来才装上的：连接前把路径补给它
    const syncRuntimePath = () => {
      if (runtime.ok) bridge.nodeModulesDir = runtime.dir;
    };

    const accounts = new AccountStore({ dataDir, log });

    /* ---------------------------- 轨迹录制（L0 表层） ---------------------------- */

    const trace = new TraceLogger({
      dir: path.join(dataDir, "traces"),
      log,
      enabled: true,
    });

    /**
     * 当前工具调用的来源。
     * 技能执行期间临时设为 "skill"，让技能自己产生的轨迹不参与技能编译，
     * 否则「用技能跑一次」会被当成新轨迹再编译一次，越滚越乱。
     */
    let traceOrigin = "llm";

    /** 在 origin="skill" 下执行一段逻辑，结束后恢复 */
    const withSkillOrigin = async (fn) => {
      const prev = traceOrigin;
      traceOrigin = "skill";
      try {
        return await fn();
      } finally {
        traceOrigin = prev;
      }
    };

    /** 记忆树根：优先用会话工作区，退化到数据目录 */
    let memoryRoot = path.join(dataDir, ROOT_DIR_NAME);
    let memory = new MemoryStore({ rootDir: memoryRoot, log });

    /* ---------------------------- 技能库（L1 里层） ---------------------------- */

    // 技能跟着记忆树走：记忆树绑定到工作区后，技能目录也跟着换。
    // 放在 memoryRoot 声明之后，rebind 才能拿到正确的根。
    let skillStore = new SkillStore({ rootDir: path.join(memoryRoot, "skills"), log });

    /**
     * 路线记忆：地形指纹 + 目标 → 接近路线。
     * 和技能库一样跟着记忆树走，工作区换了要重建。
     */
    const makeRouteMemory = () =>
      new RouteMemory({
        file: path.join(memoryRoot, "routes.json"),
        log,
        config: {
          matchThreshold: settings.routeMatchThreshold,
          maxEntries: settings.routeMaxEntries,
          ttlMs: settings.routeTtlMs,
          blockedTtlMs: settings.routeBlockedTtlMs,
        },
      });

    let routeMemory = makeRouteMemory();

    const skillRunner = new SkillRunner({
      store: skillStore,
      request: (cmd, args, kind) => bridge.request(cmd, args, kind),
      log,
    });

    /* ---------------------------- 自主驱动与肌肉记忆 ---------------------------- */

    /**
     * 肌肉记忆：世界状态 → 下一个动作。
     * 存 dataDir/muscle.json，跨会话保留；阈值来自设置，改完重启插件生效。
     */
    const muscle = new Muscle({
      file: path.join(dataDir, "muscle.json"),
      log,
      config: {
        ttlMs: settings.muscleTtlMs,
        minRuns: settings.muscleMinRuns,
        minRate: settings.muscleMinRate,
        minIntervalMs: settings.muscleMinIntervalMs,
      },
    });

    /**
     * 目标图：外部导入的攻略路线。
     *
     * 跟着记忆树走，图文件落 <记忆树>/goals/*.json，进度落 goals/progress.json。
     * 记忆树换根时要整份重读，否则会继续用旧工作区的路线。
     */
    const goalGraphs = { list: [], done: new Map() };

    const reloadGoalGraphs = () => {
      const loaded = goalStore.loadGraphs(memoryRoot);
      const progress = goalStore.loadProgress(memoryRoot);

      goalGraphs.list = loaded.graphs;
      goalGraphs.done = new Map(
        Object.entries(progress).map(([name, list]) => [name, new Set(list)]),
      );

      goalTracker.graphs = goalGraphs.list;
      goalTracker.graphDone = goalGraphs.done;

      if (loaded.errors.length) {
        for (const err of loaded.errors) {
          log(`[goal] ${err.file} 读取失败：${err.errors.join("；")}`);
        }
      }

      return loaded;
    };

    /**
     * 目标图预览：只读已落盘的进度，不跑 tracker。
     * 离线时也能回答「刷新之后会落到哪个节点」。
     */
    const goalPreviewLines = () => {
      const lines = [];
      for (const graph of goalGraphs.list) {
        const done = goalGraphs.done.get(graph.name) || new Set();
        const p = goalGraphLib.progressOf(graph, done);
        const next = goalGraphLib.nextNode(graph, done);
        lines.push(
          next
            ? `目标图：${graph.name} ${p.done}/${p.total}｜下一个：${next.title}（${next.id}）`
            : `目标图：${graph.name} ${p.done}/${p.total}｜已完成`,
        );
      }
      return lines;
    };

    /**
     * 面板目标推送：面板创建后接管；创建前是空操作。
     * 用 let 而不是 const，是因为面板在目标层之后才构造。
     */
    let notifyGoals = () => {};

    /**
     * 预览目标图：大纲 / JSON 两条路径都只做校验与整理，不写盘。
     * 返回给面板的形状固定为 { ok, mode, graph, errors, stats }。
     */
    const previewGoalInput = (input = {}) => {
      const body = input && typeof input === "object" ? input : {};

      if (typeof body.outline === "string" && body.outline.trim()) {
        const parsed = goalOutline.parseOutline(body.outline);
        return {
          ok: parsed.ok,
          mode: "outline",
          graph: parsed.graph,
          errors: parsed.errors,
          stats: {
            nodes: parsed.stats.nodes,
            depth: parsed.stats.depth,
            overwrite: parsed.ok
              ? goalGraphs.list.some((g) => g.name === parsed.graph.name)
              : false,
          },
        };
      }

      if (body.graph !== undefined && body.graph !== null && body.graph !== "") {
        const parsed = goalGraphLib.parseGraph(body.graph);
        let depth = 0;
        if (parsed.ok) {
          for (const d of goalGraphLib.depthsOf(parsed.graph).values()) {
            depth = Math.max(depth, d);
          }
          depth += 1;
        }
        return {
          ok: parsed.ok,
          mode: "json",
          graph: parsed.graph,
          errors: parsed.errors,
          stats: {
            nodes: parsed.graph ? parsed.graph.nodes.length : 0,
            depth,
            overwrite: parsed.ok
              ? goalGraphs.list.some((g) => g.name === parsed.graph.name)
              : false,
          },
        };
      }

      return {
        ok: false,
        mode: null,
        graph: null,
        errors: ["需要 outline（大纲文本）或 graph（目标图 JSON）"],
        stats: { nodes: 0, depth: 0, overwrite: false },
      };
    };

    /** 导入目标图：先复用预览校验，再落盘、重读、推面板 */
    const importGoalInput = (input = {}) => {
      const preview = previewGoalInput(input);
      if (!preview.ok) {
        return {
          ok: false,
          name: null,
          nodes: 0,
          file: "",
          overwritten: false,
          errors: preview.errors,
        };
      }

      const imported = goalStore.importGraph(memoryRoot, preview.graph);
      if (!imported.ok) {
        return {
          ok: false,
          name: null,
          nodes: 0,
          file: "",
          overwritten: false,
          errors: imported.errors,
        };
      }

      reloadGoalGraphs();
      notifyGoals();

      return {
        ok: true,
        name: imported.graph.name,
        nodes: imported.graph.nodes.length,
        file: imported.file,
        overwritten: Boolean(preview.stats.overwrite),
        errors: [],
      };
    };

    /**
     * 目标层：从世界状态差生成可追踪的目标。
     *
     * 只作为 autoplay 候选排序的偏置，不参与类脑决策的能量计算。
     * 内存态，连接断开不重置 —— 一次挂机里积累的目标不会因为掉线丢掉。
     */
    const goalTracker = new GoalTracker({
      graphs: [],
      onNodeDone: (graphName, nodeId) => {
        goalStore.markNodeDone(memoryRoot, graphName, nodeId);
        log(`[goal] 节点完成：${graphName} / ${nodeId}`);

        // 沉淀链路：节点完成即编译技能。
        // 挂在这里而不是 autoplay 主循环，手动补进度、面板改进度一样能触发。
        // 失败只记日志：编译是加分项，不该影响进度落盘。
        const sunk = goalSink.precipitateNode({
          graphs: goalTracker.graphs,
          graphName,
          nodeId,
          trace,
          store: skillStore,
        });
        if (sunk.ok || (sunk.reason !== "exists" && sunk.reason !== "checkpoint-off")) {
          log(`[goal] ${goalSink.formatSink(sunk)}`);
        }
      },
    });

    reloadGoalGraphs();

    /**
     * 自主驱动：连接成功后不等模型，自己按 tick 走下一步。
     * skillStore 用 getter：记忆树换根时会被重建，不能一直读旧目录。
     */
    const autoplay = new AutoPlayDriver({
      bridge,
      trace,
      getMuscle: () => muscle,
      getRouteMemory: () => routeMemory,
      getGoal: () => goalTracker,
      getSettings: () => settings,
      getSkillStore: () => skillStore,
      skillRunner,
      log,
      onStep: (step) => {
        // 成功太吵，只记失败，方便排查「她为什么卡住了」
        if (!step.ok) log(`[autoplay] ${step.tool} 失败：${step.error || "未知原因"}`);
      },
    });

    /** 记忆树换根时重建技能库，避免技能写到旧目录 */
    const rebindSkillStore = () => {
      skillStore = new SkillStore({ rootDir: path.join(memoryRoot, "skills"), log });
      skillRunner.store = skillStore;
      routeMemory = makeRouteMemory();
    };

    const tryBindWorkspace = (conversationId) => {
      try {
        if (!ctx.deps || !ctx.deps.workspace) return;
        const binding = ctx.deps.workspace.getBinding(conversationId);
        const root = binding && (binding.path || binding.rootPath || binding.workspacePath);
        if (root && typeof root === "string") {
          memoryRoot = path.join(root, ROOT_DIR_NAME);
          memory = new MemoryStore({ rootDir: memoryRoot, log });
          rebindSkillStore();
          reloadGoalGraphs();
          log(`记忆树绑定到工作区：${memoryRoot}`);
        }
      } catch (e) {
        log(`工作区绑定失败，记忆树使用数据目录：${e.message}`);
      }
    };

    const share = new ShareServer({
      rootDir: path.join(dataDir, ROOT_DIR_NAME, "share"),
      port: settings.sharePort,
      log,
    });

    /* ---------------------------- 训练面板 ---------------------------- */

    // 面板要读轨迹和技能库，所以放在技能库之后建。
    // 它自带写操作（导入/删除），只监听 127.0.0.1 并校验 Origin。
    const panel = new TrainingPanelServer({
      port: settings.panelPort,
      webDir: path.join(__dirname, "web"),
      trace,
      store: skillStore,
      getSnapshot: () => ({
        status: bridge.status(),
        memoryRoot,
        skillsDir: skillStore.rootDir,
      }),
      // 目标驾驶舱：大目标 / 小目标 / 节点树 / 步骤归因
      getGoalView: () =>
        goalView.buildGoalView({
          graphs: goalGraphs.list,
          graphDone: goalGraphs.done,
          snapshot: goalTracker.snapshot(),
        }),
      previewGoalGraph: previewGoalInput,
      importGoalGraph: importGoalInput,
      log,
    });

    // 面板起来之后接管目标推送：
    // 目标层每次 refresh / noteStep 都推一份，导入目标图时强制立刻推。
    notifyGoals = () => panel.broadcastGoals(true);
    goalTracker.onChange = () => panel.broadcastGoals();

    /* ---------------------------- 渠道 ---------------------------- */

    const channel = new MinecraftChannelAdapter({
      bridge,
      getSettings: () => settings,
      // 用 getter：记忆树换根时 skillStore 会被重建，反射层不能一直读旧目录
      getSkillStore: () => skillStore,
      skillRunner,
      trace,
      log,
    });

    try {
      ctx.registerChannelAdapter(channel);
      log("游戏聊天渠道已注册");
    } catch (e) {
      log(`渠道注册失败（不影响工具）：${e.message}`);
    }

    /* ---------------------------- 自主驱动接线 ---------------------------- */

    // 连接成功 → 自动起；断开 → 自动停；游戏聊天 → 让路。
    // onChat 支持多个订阅者，channel 的反射层不受影响。
    bridge.onStateChange((state) => {
      if (state === "connected") {
        if (settings.autoplayEnabled === true) autoplay.start("连接成功");
        return;
      }
      autoplay.stop(`连接状态 ${state}`);
    });

    bridge.onChat(() => autoplay.noteChat());

    // 插件热重载时可能已经连着，补一次判断
    if (bridge.status().state === "connected" && settings.autoplayEnabled === true) {
      autoplay.start("插件加载时已连接");
    }

    /* ---------------------------- 提示词 Provider ---------------------------- */

    /** 未读事件摘要：没被唤醒时也让模型知道「刚才发生过什么」 */
    const unread = [];
    bridge.onEvent((event, data) => {
      if (event === "chat" && data && data.player) {
        unread.push(`游戏聊天 <${data.player}> ${String(data.message || "").slice(0, 100)}`);
      } else if (event === "death") {
        unread.push("你在游戏里死了");
      } else if (event === "error" && data && data.message) {
        unread.push(`游戏内错误：${String(data.message).slice(0, 100)}`);
      }
      if (unread.length > 12) unread.splice(0, unread.length - 12);
    });

    if (settings.injectGameState) {
      ctx.registerPromptProvider(
        createPromptProvider({
          // 把自主驱动状态一起塞进去：模型要知道「她自己刚才动过」
          getSnapshot: () => ({
            ...bridge.status(),
            autoplay: autoplay.snapshot(),
            routes: routeMemory.snapshot(),
          }),
          getSettings: () => settings,
          getWakeHint: () => {
            if (!unread.length) return "";
            const lines = unread.slice(-6);
            unread.length = 0;
            return `【游戏内最近发生】\n${lines.map((l) => `- ${l}`).join("\n")}`;
          },
          // 技能索引：硬上限 200 字，技能库为空时不注入，不占上下文
          getSkillIndex: () => {
            try {
              return skillStore.index(200);
            } catch {
              return "";
            }
          },
        }),
      );
      log("游戏状态提示词 Provider 已注册");
    }

    /* ---------------------------- 工具构造器 ---------------------------- */

    /** 记录所有注册过的工具 id，供 capabilities 自检 */
    const registeredTools = [];

    /* ---------------------------- 流派巩固 ---------------------------- */

    /** 上一次巩固时间，用于 10 分钟冷却 */
    let lastConsolidateAt = 0;
    /** 新增轨迹计数，累计 50 条触发一次 */
    let traceSinceConsolidate = 0;
    /** 最近一次工具活动时间，用于空闲判定 */
    let lastActivityAt = Date.now();
    /** 巩固进行中，防止重入 */
    let consolidating = false;

    /**
     * 把巩固计划落盘。
     * 只归档，不删除：archived + 原因 + 时间，随时可以 restore。
     */
    const applyConsolidatePlan = (plan, nowIso) => {
      // 1. 竞争排名：写弱计数，归档被淘汰的
      for (const group of plan.groups) {
        for (const entry of group.entries) {
          const skill = skillStore.get(entry.name);
          if (!skill) continue;

          skill.competition = { weakStreak: entry.weakStreak, lastEvalAt: nowIso };

          if (entry.status === "archived") {
            skill.archived = true;
            skill.archivedAt = skill.archivedAt || nowIso;
            skill.archivedReason = skill.archivedReason || "流派竞争淘汰";
          }

          try {
            skillStore.save(entry.name, skill);
          } catch (e) {
            log(`[tradition] 写回 ${entry.name} 失败：${e.message}`);
          }
        }
      }

      // 2. 合并：胜者拿累加后的统计，败者归档
      for (const merge of plan.merges) {
        const keep = skillStore.get(merge.keep);
        if (keep) {
          keep.stats = merge.stats;
          try {
            skillStore.save(merge.keep, keep);
          } catch (e) {
            log(`[tradition] 写回 ${merge.keep} 失败：${e.message}`);
          }
        }

        const drop = skillStore.get(merge.drop);
        if (drop) {
          drop.archived = true;
          drop.archivedAt = nowIso;
          drop.archivedReason = merge.archivedReason;
          try {
            skillStore.save(merge.drop, drop);
          } catch (e) {
            log(`[tradition] 归档 ${merge.drop} 失败：${e.message}`);
          }
        }
      }

      // 3. 超过上限的尾部
      for (const name of plan.archiveSkills) {
        const skill = skillStore.get(name);
        if (!skill || skill.archived === true) continue;

        skill.archived = true;
        skill.archivedAt = nowIso;
        skill.archivedReason = "技能库超限";
        try {
          skillStore.save(name, skill);
        } catch (e) {
          log(`[tradition] 归档 ${name} 失败：${e.message}`);
        }
      }
    };

    /**
     * 执行一次巩固。
     *
     * 默认 dry-run：只算清单、写日志，不改变技能库。
     * 传 apply: true 才真正归档。自动触发永远 dry-run——
     * 「数据自行竞争」可以先算出来，落盘这一步留给人确认。
     */
    const runConsolidate = (opts = {}) => {
      if (consolidating) return null;

      const now = Date.now();
      const auto = opts.auto === true;

      // 自动触发受冷却限制；手动调用不受限
      if (auto && now - lastConsolidateAt < 10 * 60 * 1000) return null;

      consolidating = true;
      try {
        const dryRun = opts.apply !== true;
        const skills = skillStore
          .listNames()
          .map((name) => skillStore.get(name))
          .filter(Boolean);

        const graph = buildGraph(trace.snapshot(), { now });
        const plan = tradition.consolidate({ skills, graph, now, dryRun });

        if (!dryRun) applyConsolidatePlan(plan, new Date(now).toISOString());

        lastConsolidateAt = now;
        traceSinceConsolidate = 0;
        log(`[tradition] ${plan.summary}${auto ? "（自动触发）" : ""}`);
        return plan;
      } catch (e) {
        log(`[tradition] 巩固失败：${e.message}`);
        return null;
      } finally {
        consolidating = false;
      }
    };

    /** 自动触发入口（轨迹累计 / 空闲）。冷却不够时静默跳过。 */
    const maybeAutoConsolidate = () => {
      if (Date.now() - lastConsolidateAt < 10 * 60 * 1000) return;
      runConsolidate({ auto: true, apply: false });
    };

    const requireConnected = () => {
      const status = bridge.status();
      if (status.state !== "connected") {
        throw new Error("机器人还没连进服务器。先调用 cyrene-craft_connect");
      }
      return status;
    };

    /**
     * 包装工具执行：计时 + 轨迹录制。
     *
     * 录制是旁路，任何异常都不能影响工具本身的返回。
     * 用 origin 标记来源：技能执行期间会把 state.traceOrigin 设为 "skill"，
     * 这样技能自己产生的轨迹不会再被编译成新技能（避免自我循环）。
     */
    const recordTrace = (toolId, args, startedAt, ok, error) => {
      if (!trace.enabled) return;
      try {
        const shortId = toolId.startsWith(`${PLUGIN_ID}_`) ? toolId.slice(PLUGIN_ID.length + 1) : toolId;
        trace.record({
          tool: shortId,
          args,
          ok,
          ms: Date.now() - startedAt,
          origin: traceOrigin,
          error,
        });
      } catch (e) {
        log(`轨迹录制失败（不影响工具）：${e.message}`);
      }

      // 自动巩固：新增轨迹累计 50 条触发一次。
      // 只做 dry-run，结果进日志；真正归档由手动 consolidate apply 决定。
      traceSinceConsolidate += 1;
      if (traceSinceConsolidate >= 50) {
        traceSinceConsolidate = 0;
        void maybeAutoConsolidate();
      }
    };

    const tool = (spec) => {
      if (!String(spec.id).startsWith(`${PLUGIN_ID}_`)) {
        throw new Error(`工具 id 必须以 ${PLUGIN_ID}_ 开头：${spec.id}`);
      }
      registeredTools.push(spec.id);

      const originalExecute = spec.execute;

      ctx.registerTool({
        enabled: true,
        risk: "safe",
        effectKind: "read",
        ...spec,
        async execute(args) {
          const startedAt = Date.now();
          // 有工具在跑就不算空闲，自动巩固不该在这时候插一脚
          lastActivityAt = startedAt;
          try {
            const result = await originalExecute.call(this, args);
            // 跑完了 ≠ 做成了：collect 找不到目标时返回 ok:true + complete:false。
            // 只看有没有抛错的话，这种零收益会被记成成功，教训编译器永远看不见它。
            const verdict = judgeOutcome(result);
            recordTrace(spec.id, args, startedAt, verdict.ok, verdict.ok ? undefined : verdict.error);
            return result;
          } catch (e) {
            const message = e && e.message ? e.message : String(e);
            recordTrace(spec.id, args, startedAt, false, message);
            throw e;
          }
        },
      });
    };

    /** 通用执行包装：统一错误翻译 + 超时兜底 */
    const run = async (fn, kind = "default") => {
      try {
        return await fn();
      } catch (e) {
        throw new Error(friendlyRuntimeError(e));
      }
    };

    /* ============================ 33 个工具 ============================ */

    /* ---- 1. status ---- */
    tool({
      id: `${PLUGIN_ID}_status`,
      name: "查看游戏状态",
      description:
        "查看昔涟在 Minecraft 里的当前状态：是否在线、服务器地址、坐标、血量、饥饿值、背包、在线玩家、正在做什么、最近的游戏聊天。" +
        "用户问「你在游戏里怎么样」「在哪」「有什么东西」时用。不需要参数。",
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        const s = bridge.status();
        if (s.state !== "connected") {
          // 离线也把目标图进度带上：刷新后会落到哪个节点，这里就能看见。
          return [
            `未连接服务器${s.lastError ? `（最近错误：${s.lastError}）` : ""}。`,
            ...goalPreviewLines(),
          ].join("\n");
        }

        const lines = [];
        lines.push(`连接状态：已连接 ${s.host}:${s.port}`);
        if (s.username) lines.push(`游戏角色：${s.username}`);
        if (s.position) {
          lines.push(
            `坐标：(${Math.round(s.position.x)}, ${Math.round(s.position.y)}, ${Math.round(s.position.z)})`,
          );
        }
        lines.push(`生命值：${s.health ?? "?"}/20，饥饿值：${s.food ?? "?"}/20`);
        if (s.dimension) lines.push(`维度：${s.dimension}`);

        const items = Array.isArray(s.inventory) ? s.inventory : [];
        if (items.length) {
          const merged = new Map();
          for (const it of items) merged.set(it.name, (merged.get(it.name) || 0) + (it.count || 1));
          lines.push(`背包：${[...merged].map(([n, c]) => `${n}×${c}`).join("、")}`);
        } else {
          lines.push("背包：空");
        }

        const others = (Array.isArray(s.players) ? s.players : []).filter((p) => p && !p.isSelf);
        if (others.length) lines.push(`在线玩家：${others.map((p) => p.username).join("、")}`);

        if (s.currentTask) lines.push(`正在做：${s.currentTask}`);

        const recent = (Array.isArray(s.recentChat) ? s.recentChat : []).slice(-5);
        if (recent.length) {
          lines.push("最近聊天：");
          for (const c of recent) lines.push(`  ${c.player ? c.player : "系统"}: ${c.message}`);
        }

        return lines.join("\n");
      },
    });

    /* ---- 2. lan ---- */
    tool({
      id: `${PLUGIN_ID}_lan`,
      name: "搜索局域网服务器",
      description:
        "在局域网里搜索开了「对局域网开放」的 Minecraft 服务器（只监听广播，不扫端口、不发探测包）。" +
        "不知道对方地址时用。收到就拿到地址+端口+MOTD。听不到时直接问对方地址更快。",
      risk: "network",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          seconds: { type: "number", description: "听多久，默认 3 秒，上限 15 秒" },
        },
        required: [],
      },
      async execute(args) {
        const seconds = Math.max(1, Math.min(Number(args.seconds) || 3, 15));
        const found = await listenLanBroadcast({ seconds });
        if (!found.length) {
          return (
            `听了 ${seconds} 秒，没有听到局域网公告。\n` +
            "可能原因：对方没开「对局域网开放」、服务器关了 enable-lan-visibility、" +
            "或这个网络挡了多播（部分 WiFi / VPN / 容器）。直接问对方地址更省时间。"
          );
        }
        return (
          `找到 ${found.length} 个：\n` +
          found.map((f) => `- ${f.host}:${f.port}${f.motd ? `  「${f.motd}」` : ""}`).join("\n") +
          "\n用 cyrene-craft_connect 连进去。"
        );
      },
    });

    /* ---- 3. ping ---- */
    tool({
      id: `${PLUGIN_ID}_ping`,
      name: "探测服务器",
      description:
        "已知服务器地址时，先探一下通不通：拿到版本、协议号、MOTD、在线人数、延迟。" +
        "不登录、不进服，探完立刻断开。连不上时会说明原因（端口没开/域名错/超时）。",
      risk: "network",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          address: { type: "string", description: "地址，如 example.com 或 example.com:25566" },
          timeoutMs: { type: "number", description: "超时毫秒，默认 5000，上限 30000" },
        },
        required: ["address"],
      },
      async execute(args) {
        const address = String(args.address || "").trim();
        if (!address) throw new Error("address 不能为空");

        // 地址拆成 host + port
        let host = address;
        let port = 25565;
        const colon = address.lastIndexOf(":");
        if (colon > 0 && address.indexOf("]") === -1) {
          const maybePort = Number(address.slice(colon + 1));
          if (Number.isFinite(maybePort) && maybePort > 0) {
            host = address.slice(0, colon);
            port = maybePort;
          }
        }

        // 借子进程的 ping 实现（那边已经处理了 Minecraft 协议细节）
        await ensureRuntime();
        syncRuntimePath();
        if (!bridge.isRunning()) await bridge.start();
        const result = await bridge.request("ping", { host, port, timeoutMs: args.timeoutMs }, "query");

        if (!result.ok) return `探测 ${host}:${port} 失败：${result.error}`;

        return [
          `${host}:${port} 在线`,
          `版本：${result.version || "?"}（协议 ${result.protocol ?? "?"}）`,
          result.motd ? `介绍：${result.motd}` : null,
          result.players ? `人数：${result.players.online}/${result.players.max}` : null,
          `延迟：${result.latencyMs} ms`,
        ]
          .filter(Boolean)
          .join("\n");
      },
    });

    /* ---- 4. connect ---- */
    tool({
      id: `${PLUGIN_ID}_connect`,
      name: "进入 Minecraft 服务器",
      description:
        "把昔涟的游戏身体连进 Minecraft 服务器（Java 版，离线模式）。连上后她就成了游戏里的一个角色。" +
        "address 填 host[:port]，端口默认 25565。username 是游戏角色名，默认用设置里的名字。",
      risk: "network",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          address: { type: "string", description: "服务器地址，如 localhost / 192.168.1.10 / mc.example.com:25566" },
          username: { type: "string", description: "游戏角色名（≤16 字符），不填用设置里的默认名" },
          version: { type: "string", description: "（可选）强制指定协议版本，如 1.21.1；通常留空自动探测" },
        },
        required: ["address"],
      },
      async execute(args) {
        const address = String(args.address || "").trim();
        if (!address) throw new Error("address 不能为空");

        let host = address;
        let port = 25565;
        const colon = address.lastIndexOf(":");
        if (colon > 0 && address.indexOf("]") === -1) {
          const maybePort = Number(address.slice(colon + 1));
          if (Number.isFinite(maybePort) && maybePort > 0) {
            host = address.slice(0, colon);
            port = maybePort;
          }
        }

        const username = String(args.username || settings.defaultUsername || "Cyrene").trim();
        if (username.length > 16) throw new Error("游戏角色名不能超过 16 个字符");

        await ensureRuntime();
        syncRuntimePath();

        const data = await run(
          () => bridge.connect({ host, port, username, version: args.version || null }),
          "connect",
        );

        // 记住这次连的服务器，下次打开设置窗口自动回填
        ctx.storage.set(KEY_LAST_SERVER, { host, port, username, at: new Date().toISOString() });

        // 记忆树：尽量按会话工作区落盘
        tryBindWorkspace(args.conversationId || "default");
        try {
          memory.ensure();
        } catch (e) {
          log(`记忆树初始化失败：${e.message}`);
        }

        if (settings.wakeEnabled && !channel.onMessage) {
          log("唤醒已开启，但宿主还没有把渠道接到调度器——唤醒可能不会生效");
        }

        return (
          `已进入服务器 ${host}:${port}，角色名 ${username}。\n` +
          (data && data.position
            ? `坐标 (${Math.round(data.position.x)}, ${Math.round(data.position.y)}, ${Math.round(data.position.z)})，` +
              `血量 ${data.health}/20`
            : "正在加载区块…")
        );
      },
    });

    /* ---- 5. accounts ---- */
    tool({
      id: `${PLUGIN_ID}_accounts`,
      name: "管理游戏账户",
      description:
        "查看 / 搜索 / 添加 / 删除 Minecraft 游戏账户。**永远拿不到密码**，只返回名字、类型、常用服务器。" +
        "action：list（默认，全部列出）、search（给 query）、add（给 name，可选 server）、remove（给 id）。",
      risk: "safe",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "list / search / add / remove" },
          query: { type: "string", description: "search 时搜什么" },
          id: { type: "string", description: "remove 时删哪个" },
          name: { type: "string", description: "add 时的游戏角色名" },
          server: { type: "string", description: "add 时的常用服务器地址（可选）" },
        },
        required: [],
      },
      async execute(args) {
        const action = String(args.action || "list").toLowerCase();

        if (action === "add") {
          const record = accounts.upsert({ name: args.name, server: args.server, type: "offline" });
          return `已添加账户：${record.name}（id ${record.id}）`;
        }

        if (action === "remove") {
          const ok = args.id ? accounts.remove(String(args.id)) : false;
          return ok ? `已删除账户 ${args.id}` : `没找到账户 ${args.id || "(未提供 id)"}`;
        }

        const list = action === "search" ? accounts.search(args.query) : accounts.list();
        if (!list.length) {
          return action === "search" ? `没有匹配「${args.query}」的账户` : "还没有任何游戏账户。用 connect 时给个 username 就会自动创建。";
        }

        return (
          `共 ${list.length} 个账户：\n` +
          list
            .map(
              (a) =>
                `- ${a.name}（id ${a.id}，${a.type === "yggdrasil" ? "皮肤站" : "离线"}）` +
                (a.server ? ` 常用 ${a.server.host}:${a.server.port}` : "") +
                (a.lastUsedAt ? ` 上次 ${a.lastUsedAt.slice(0, 10)}` : ""),
            )
            .join("\n")
        );
      },
    });

    /* ---- 6. stop ---- */
    tool({
      id: `${PLUGIN_ID}_stop`,
      name: "停止当前动作",
      description:
        "立刻停下昔涟正在做的动作（移动、寻路、挖掘、采集、攻击、建造）。不会断开服务器连接。" +
        "用户说「停下」「别挖了」「回来」时用。",
      risk: "safe",
      effectKind: "write",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        if (!bridge.isRunning()) return "机器人没在运行，不需要停。";
        await bridge.request("stop", {}, "default").catch(() => {});
        return "已停下当前动作。";
      },
    });

    /* ---- 7. disconnect ---- */
    tool({
      id: `${PLUGIN_ID}_disconnect`,
      name: "离开服务器",
      description: "让昔涟退出当前 Minecraft 服务器，并关闭机器人进程。",
      risk: "safe",
      effectKind: "write",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        await bridge.disconnect();
        return "已离开服务器。";
      },
    });

    /* ---- 8. say ---- */
    tool({
      id: `${PLUGIN_ID}_say`,
      name: "在游戏里说话",
      description:
        "让昔涟在 Minecraft 聊天栏说一句话。单条最长 256 字符，超了会被截断。" +
        "注意：这是直接在游戏里发言，所有在线玩家都能看到。",
      risk: "safe",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", description: "要说的内容" } },
        required: ["message"],
      },
      async execute(args) {
        requireConnected();
        const message = String(args.message || "").trim();
        if (!message) throw new Error("message 不能为空");
        const data = await run(() => bridge.request("say", { message }, "default"));
        return `已在游戏里说：${data.message}`;
      },
    });

    /* ---- 9. watch ---- */
    tool({
      id: `${PLUGIN_ID}_watch`,
      name: "设置唤醒规则",
      description:
        "配置昔涟在游戏里被叫醒的规则：是否开启唤醒、点名关键词、全局冷却、是否响应所有聊天。" +
        "唤醒每触发一次就是一轮完整对话，所以默认关闭。",
      risk: "safe",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", description: "是否开启唤醒" },
          mentions: { type: "array", items: { type: "string" }, description: "点名关键词列表" },
          cooldownMs: { type: "number", description: "全局冷却毫秒，默认 90000" },
          respondToAll: { type: "boolean", description: "是否响应所有游戏聊天（默认只响应点名）" },
        },
        required: [],
      },
      async execute(args) {
        const patch = {};
        if (typeof args.enabled === "boolean") patch.wakeEnabled = args.enabled;
        if (Array.isArray(args.mentions)) patch.mentions = args.mentions.map(String);
        if (Number.isFinite(Number(args.cooldownMs))) patch.wakeCooldownMs = Number(args.cooldownMs);
        if (typeof args.respondToAll === "boolean") patch.respondToAll = args.respondToAll;

        if (!Object.keys(patch).length) {
          return [
            `唤醒：${settings.wakeEnabled ? "开" : "关"}`,
            `点名关键词：${settings.mentions.join(" / ")}`,
            `全局冷却：${Math.round(settings.wakeCooldownMs / 1000)} 秒`,
            `响应所有聊天：${settings.respondToAll ? "是" : "否"}`,
          ].join("\n");
        }

        writeSettings(patch);
        return "唤醒规则已更新：\n" + JSON.stringify(patch, null, 2);
      },
    });

    /* ---- 10. config ---- */
    tool({
      id: `${PLUGIN_ID}_config`,
      name: "插件设置",
      description:
        "查看或修改 cyrene-craft 的设置：唤醒开关、低血阈值、文件分享端口、默认角色名、是否注入游戏状态。",
      risk: "safe",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          wakeEnabled: { type: "boolean" },
          lowHealthThreshold: { type: "number" },
          sharePort: { type: "number" },
          defaultUsername: { type: "string" },
          injectGameState: { type: "boolean" },
        },
        required: [],
      },
      async execute(args) {
        const patch = {};
        for (const key of ["wakeEnabled", "injectGameState"]) {
          if (typeof args[key] === "boolean") patch[key] = args[key];
        }
        for (const key of ["lowHealthThreshold", "sharePort"]) {
          if (Number.isFinite(Number(args[key]))) patch[key] = Number(args[key]);
        }
        if (typeof args.defaultUsername === "string" && args.defaultUsername.trim()) {
          patch.defaultUsername = args.defaultUsername.trim();
        }

        if (!Object.keys(patch).length) {
          return "当前设置：\n" + JSON.stringify(settings, null, 2);
        }

        writeSettings(patch);
        return "设置已更新：\n" + JSON.stringify(settings, null, 2);
      },
    });

    /* ---- 11. capabilities ---- */
    tool({
      id: `${PLUGIN_ID}_capabilities`,
      name: "能力自检",
      description: "查看 cyrene-craft 的完整能力清单与运行时状态：版本、mineflayer 状态、工具数、渠道/提示词/分享是否就绪。排查问题时先跑这个。",
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        const rt = runtime.ok ? runtime : { ok: false, reason: "未就绪" };
        const lines = [
          `cyrene-craft v${PLUGIN_VERSION}`,
          `运行时：${rt.ok ? `mineflayer ${runtime.version || "?"}（${runtime.label}）` : `未就绪 — ${rt.reason}`}`,
          `机器人进程：${bridge.isRunning() ? "运行中" : "未启动"}`,
          `连接状态：${bridge.status().state}`,
          `已注册工具：${registeredTools.length} 个`,
          `渠道适配器：minecraft-cyrene ${channel.onMessage ? "已接线" : "未接线（宿主未接管）"}`,
          `提示词注入：${settings.injectGameState ? "开" : "关"}`,
          `唤醒：${settings.wakeEnabled ? "开" : "关"}`,
          `记忆树：${memory.rootDir}`,
          `文件分享：${share.running ? share.baseUrl() : "未启动"}`,
          `账户数：${accounts.list().length}`,
          `数据目录：${dataDir}`,
        ];
        return lines.join("\n");
      },
    });

    /* ---- 12. sessions ---- */
    tool({
      id: `${PLUGIN_ID}_sessions`,
      name: "实例信息",
      description:
        "查看机器人实例信息。注意：Cyrene 插件拿不到会话上下文，所以本插件是**全局单实例**，" +
        "所有对话共用同一个游戏角色——这个工具会如实说明这一点。",
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        const s = bridge.status();
        return [
          "实例模式：全局单实例（Cyrene 插件 API 不提供按会话隔离的能力）",
          `当前连接：${s.state === "connected" ? `${s.host}:${s.port}（${s.username}）` : "未连接"}`,
          `进程：${bridge.isRunning() ? "运行中" : "未启动"}`,
          `重启计数：${s.restartCount}`,
          "想换角色或换服务器：先 disconnect，再用 connect 指定新的 address / username。",
        ].join("\n");
      },
    });

    /* ---- 13. events ---- */
    tool({
      id: `${PLUGIN_ID}_events`,
      name: "读取游戏事件",
      description:
        "取走最近发生的游戏事件：聊天、系统消息、受伤、死亡、错误。取过一次就清空，不重复返回。" +
        "想知道「刚才游戏里发生了什么」时用。",
      risk: "safe",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "最多取多少条，默认 20" },
          kind: { type: "string", description: "只看某类：chat / system / hurt / death / error / state" },
        },
        required: [],
      },
      async execute(args) {
        const limit = Math.max(1, Math.min(Number(args.limit) || 20, 100));
        const kind = args.kind ? String(args.kind) : null;
        const picked = bridge.takeEvents(limit, kind ? (e) => e.event === kind : null);

        if (!picked.length) return kind ? `没有新的 ${kind} 事件。` : "没有新事件。";

        return picked
          .map((e) => {
            const time = new Date(e.at).toTimeString().slice(0, 8);
            const d = e.data || {};
            let text = "";
            if (e.event === "chat") text = `<${d.player}> ${d.message}`;
            else if (e.event === "system") text = d.message;
            else if (e.event === "hurt") text = `受伤：${d.from} → ${d.to}`;
            else if (e.event === "death") text = "死亡";
            else if (e.event === "error") text = `错误：${d.message}`;
            else if (e.event === "state") text = `连接状态：${d.state}${d.reason ? `（${d.reason}）` : ""}`;
            else text = JSON.stringify(d).slice(0, 200);
            return `${time} [${e.event}] ${text}`;
          })
          .join("\n");
      },
    });

    /* ---- 14. context ---- */
    tool({
      id: `${PLUGIN_ID}_context`,
      name: "查看周围环境",
      description:
        "快速看昔涟身边的环境：坐标、血量、脚下是什么方块、光照、手上拿的什么、维度、时间。比 map 轻量。",
      risk: "safe",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          survival: { type: "boolean", description: "是否包含生存信息（脚下方块/光照/手持），默认 true" },
        },
        required: [],
      },
      async execute(args) {
        requireConnected();
        const data = await run(() => bridge.request("context", { survival: args.survival !== false }, "query"));
        return JSON.stringify(data, null, 2);
      },
    });

    /* ---- 15. players ---- */
    tool({
      id: `${PLUGIN_ID}_players`,
      name: "查看在线玩家",
      description: "列出服务器上所有在线玩家：名字、是否是自己、延迟、坐标（能看到的话）。",
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        requireConnected();
        const data = await run(() => bridge.request("players", {}, "query"));
        if (!data.count) return "没有别的玩家在线。";
        return data.players
          .map((p) => {
            const pos = p.position
              ? ` @(${Math.round(p.position.x)}, ${Math.round(p.position.y)}, ${Math.round(p.position.z)})`
              : "";
            return `- ${p.username}${p.isSelf ? "（你自己）" : ""}${pos}${p.ping != null ? `  延迟 ${p.ping}ms` : ""}`;
          })
          .join("\n");
      },
    });

    /* ---- 16. scan ---- */
    tool({
      id: `${PLUGIN_ID}_scan`,
      name: "搜索附近方块",
      description:
        "在附近搜指定方块并列出坐标，按距离排序。找树、找矿、找工作台、找水都靠它。" +
        "block 填方块 id，如 oak_log / iron_ore / crafting_table / water。",
      risk: "safe",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          block: { type: "string", description: "方块 id，如 oak_log / iron_ore" },
          radius: { type: "number", description: "搜索半径（格），默认 32，上限 128" },
          limit: { type: "number", description: "最多返回几个，默认 20" },
        },
        required: ["block"],
      },
      async execute(args) {
        requireConnected();
        const data = await run(() => bridge.request("scan", args, "query"));
        if (!data.count) return `半径 ${data.radius} 格内没有找到 ${data.block}。`;
        return (
          `半径 ${data.radius} 格内找到 ${data.count} 个 ${data.block}：\n` +
          data.blocks.map((b) => `- (${b.x}, ${b.y}, ${b.z})  距离 ${b.distance}`).join("\n")
        );
      },
    });

    /* ---- 17. map ---- */
    tool({
      id: `${PLUGIN_ID}_map`,
      name: "俯视地图",
      description:
        "画一张昔涟脚下的俯视字符地图：`.`空气 `#`石头矿石 `+`泥土沙 `T`树干 `*`树叶 `~`水 `^`其它。" +
        "了解地形、找方向时用。y 不填就用脚下方块高度。",
      risk: "safe",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          radius: { type: "number", description: "半径（格），默认 16，上限 48" },
          y: { type: "number", description: "看哪一层，不填用脚下这一层" },
        },
        required: [],
      },
      async execute(args) {
        requireConnected();
        const data = await run(() => bridge.request("map", args, "query"));
        const legend = Object.entries(data.legend)
          .map(([k, v]) => `${k}=${v}`)
          .join("  ");
        return [
          `层 y=${data.layer}，中心 (${data.origin.x}, ${data.origin.z})，半径 ${data.radius}`,
          legend,
          "",
          ...data.grid,
        ].join("\n");
      },
    });

    /* ---- 18. height ---- */
    tool({
      id: `${PLUGIN_ID}_height`,
      name: "高度图",
      description: "看周围地表高度分布（数字矩阵），判断哪里是山、哪里是谷、哪里是坑。",
      risk: "safe",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: { radius: { type: "number", description: "半径（格），默认 12，上限 32" } },
        required: [],
      },
      async execute(args) {
        requireConnected();
        const data = await run(() => bridge.request("height", args, "query"));
        const rows = data.heights.map((row) => row.map((h) => (h === null ? "  ." : String(h).padStart(3))).join(""));
        return [
          `半径 ${data.radius}，高度范围 ${data.minY ?? "?"} ~ ${data.maxY ?? "?"}`,
          "(数字是最高非空气方块的 y；. 表示没探测到)",
          "",
          ...rows,
        ].join("\n");
      },
    });

    /* ---- 19. entities ---- */
    tool({
      id: `${PLUGIN_ID}_entities`,
      name: "查看附近实体",
      description:
        "列出附近的生物、玩家、掉落物、其它实体：名字、类型、距离、坐标、血量。判断有没有危险、有没有东西可捡时用。",
      risk: "safe",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          radius: { type: "number", description: "半径（格），默认 16，上限 64" },
          kind: { type: "string", description: "只看某类：player / mob / object / all" },
        },
        required: [],
      },
      async execute(args) {
        requireConnected();
        const data = await run(() => bridge.request("entities", args, "query"));
        if (!data.count) return `半径 ${data.radius} 格内没有实体。`;
        return data.entities
          .map(
            (e) =>
              `- ${e.name}（${e.type}）距离 ${e.distance}` +
              (e.health != null ? ` 血量 ${Math.round(e.health)}` : "") +
              ` @(${Math.round(e.position.x)}, ${Math.round(e.position.y)}, ${Math.round(e.position.z)})`,
          )
          .join("\n");
      },
    });

    /* ---- 20. inventory ---- */
    tool({
      id: `${PLUGIN_ID}_inventory`,
      name: "查看背包",
      description: "列出昔涟背包里的所有物品：名字、数量、格子、剩余空格、手上拿的什么。",
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        requireConnected();
        const data = await run(() => bridge.request("inventory", {}, "query"));
        if (!data.items.length) return "背包是空的。";
        const lines = data.items.map((it) => `- ${it.name} ×${it.count}（格子 ${it.slot}）`);
        if (data.held) lines.push(`手上：${data.held.name} ×${data.held.count}`);
        if (data.emptySlots != null) lines.push(`空格：${data.emptySlots}`);
        return lines.join("\n");
      },
    });

    /* ---- 21. move ---- */
    tool({
      id: `${PLUGIN_ID}_move`,
      name: "移动到坐标或玩家",
      description:
        "让昔涟走过去。给 x/y/z 走到坐标，或给 player 走到玩家身边。有自动寻路时会绕障碍、爬台阶、过水。" +
        "长距离移动会等很久（最多 120 秒）。",
      risk: "safe",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          z: { type: "number" },
          player: { type: "string", description: "走到这个玩家身边（与坐标二选一）" },
        },
        required: [],
      },
      async execute(args) {
        requireConnected();
        if (!args.player && (args.x === undefined || args.y === undefined || args.z === undefined)) {
          throw new Error("需要给 x/y/z 坐标，或者给 player");
        }
        const data = await run(() => bridge.request("move", args, "move"));
        return data.position
          ? `到了：(${Math.round(data.position.x)}, ${Math.round(data.position.y)}, ${Math.round(data.position.z)})`
          : "移动完成。";
      },
    });

    /* ---- 22. act ---- */
    tool({
      id: `${PLUGIN_ID}_act`,
      name: "做个小动作",
      description:
        "让昔涟做一个具体动作。action 可选：eat（吃东西）、equip（拿东西到手上，给 item）、" +
        "sleep（睡觉）、wake（起床）、use（用手上的东西）、drop（丢东西，给 item/count）、jump、sneak（潜行，给 on）。",
      risk: "safe",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "eat / equip / sleep / wake / use / drop / jump / sneak" },
          item: { type: "string", description: "equip 或 drop 时给物品 id" },
          count: { type: "number", description: "drop 丢几个" },
          on: { type: "boolean", description: "sneak 开关" },
          destination: { type: "string", description: "equip 装备到哪：hand / head / torso / legs / feet" },
        },
        required: ["action"],
      },
      async execute(args) {
        requireConnected();
        const data = await run(() => bridge.request("act", args, "default"));
        return `完成：${JSON.stringify(data)}`;
      },
    });

    /* ---- 23. give ---- */
    tool({
      id: `${PLUGIN_ID}_give`,
      name: "给玩家东西",
      description: "走到指定玩家身边，把背包里的物品丢给他。给 item 和 player，count 可选。",
      risk: "safe",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          item: { type: "string", description: "物品 id" },
          player: { type: "string", description: "玩家名" },
          count: { type: "number", description: "给几个，默认 1" },
        },
        required: ["item", "player"],
      },
      async execute(args) {
        requireConnected();
        const data = await run(() => bridge.request("give", args, "move"));
        return `已给 ${data.player} ${data.item} ×${data.count}。`;
      },
    });

    /* ---- 24. sequence ---- */
    tool({
      id: `${PLUGIN_ID}_sequence`,
      name: "连续做几件事",
      description:
        "按顺序执行一串动作，适合「先挖三个木头再做工作台」这种。steps 是数组，" +
        "每项形如 { cmd: 'collect', args: {block:'oak_log', count:3}, wait: 500 }。" +
        "cmd 可用的就是本插件其它工具去掉前缀后的名字。\n" +
        "collect 的 args 支持：radius（搜索半径）、maxDistance（目标超过这么远就放弃）、" +
        "travelMs（单次寻路超时）、maxStalls（连续几次没进展就收工）、timeoutMs（整体时限）。" +
        "设 maxDistance 可以避免为了一个很远的方块绕半天路。",
      risk: "safe",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                cmd: { type: "string" },
                args: { type: "object" },
                wait: { type: "number", description: "这一步做完后等几毫秒" },
                stopOnError: { type: "boolean", description: "失败是否中止后面所有步骤，默认 true" },
              },
              required: ["cmd"],
            },
          },
        },
        required: ["steps"],
      },
      async execute(args) {
        requireConnected();
        const data = await run(() => bridge.request("sequence", args, "sequence"));
        const text =
          `共 ${data.total} 步，成功 ${data.done}，失败 ${data.failed}：\n` +
          data.results
            .map((r) => (r.ok ? `✔ ${r.cmd}` : `✘ ${r.cmd}：${r.error}`))
            .join("\n");
        // 有步骤没做成就是失败：抛出去，包装器才会把失败写进轨迹。
        // 否则跑完的 sequence 永远记成功，教训编译器看不见任何零收益。
        if (data.failed > 0) throw new Error(text);
        return text;
      },
    });

    /* ---- 25. build ---- */
    tool({
      id: `${PLUGIN_ID}_build`,
      name: "建造结构",
      description:
        "用背包里的方块盖一个结构。shape：box（空心房间）/ wall（墙）/ floor（地板）/ pillar（柱子）。" +
        "以脚下或指定坐标为起点，size 是边长。会逐格放，大工程会很久。",
      risk: "safe",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          block: { type: "string", description: "用哪种方块，如 oak_planks" },
          shape: { type: "string", description: "box / wall / floor / pillar" },
          size: { type: "number", description: "边长，默认 3" },
          height: { type: "number", description: "高度（wall/box/pillar 用）" },
          x: { type: "number", description: "起点 x（不填用脚下）" },
          y: { type: "number", description: "起点 y" },
          z: { type: "number", description: "起点 z" },
        },
        required: ["block"],
      },
      async execute(args) {
        requireConnected();
        const data = await run(() => bridge.request("build", args, "build"));
        return `建造完成：${data.shape}，放了 ${data.placed} 格，失败 ${data.failed} 格。`;
      },
    });

    /* ---- 26. dig ---- */
    tool({
      id: `${PLUGIN_ID}_dig`,
      name: "挖掉一个方块",
      description: "挖掉指定坐标的方块。基岩、屏障、命令方块这类挖不动的会被拒绝。",
      risk: "safe",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          z: { type: "number" },
        },
        required: ["x", "y", "z"],
      },
      async execute(args) {
        requireConnected();
        const data = await run(() => bridge.request("dig", args, "dig"));
        return `挖掉了 ${data.block} @(${data.position.x}, ${data.position.y}, ${data.position.z})。`;
      },
    });

    /* ---- 27. command ---- */
    tool({
      id: `${PLUGIN_ID}_command`,
      name: "执行服务器指令",
      description:
        "在游戏里执行一条服务器指令。默认只放行白名单（/list /seed /time query /weather query /help /me /msg /tell）。" +
        "要执行其它指令必须显式传 allowAll=true，并且由你向用户确认过。",
      risk: "input-control",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "完整指令，含前导 /" },
          allowAll: { type: "boolean", description: "是否绕过白名单（默认 false）" },
        },
        required: ["command"],
      },
      async execute(args) {
        requireConnected();
        const data = await run(() => bridge.request("command", args, "default"));
        return `已执行：${data.command}`;
      },
    });

    /* ---- 28. rules ---- */
    tool({
      id: `${PLUGIN_ID}_rules`,
      name: "查看行事准则",
      description: "读记忆树里的 RULES.md（昔涟在游戏里给自己定的规矩）。想知道「该怎么玩」时看一眼。",
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        return memory.readRules();
      },
    });

    /* ---- 29. image ---- */
    tool({
      id: `${PLUGIN_ID}_image`,
      name: "画一张地图图",
      description:
        "把当前地形渲染成一张 PNG 图片存到记忆树的 share 目录，返回绝对路径（分享开启时还返回 http 地址）。" +
        "kind：map（俯视地形）/ height（高度热力图）。",
      risk: "fs-write",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", description: "map / height，默认 map" },
          radius: { type: "number", description: "半径（格），默认 24，上限 32" },
        },
        required: [],
      },
      async execute(args) {
        requireConnected();
        const kind = String(args.kind || "map");
        const radius = Math.max(4, Math.min(Number(args.radius) || 24, 32));
        const scale = 6; // 每格几个像素

        const side = radius * 2 + 1;
        const canvas = new Canvas(side * scale, side * scale);

        if (kind === "height") {
          const data = await run(() => bridge.request("height", { radius }, "query"));
          const min = data.minY ?? 0;
          const max = data.maxY ?? (min + 1);
          const span = Math.max(1, max - min);
          for (let z = 0; z < side; z++) {
            for (let x = 0; x < side; x++) {
              const h = data.heights[z] ? data.heights[z][x] : null;
              if (h === null || h === undefined) {
                canvas.fillRect(x * scale, z * scale, scale, scale, 20, 20, 24);
                continue;
              }
              const t = (h - min) / span;
              // 低=蓝，中=绿，高=白
              const r = Math.round(t < 0.5 ? 40 + t * 2 * 80 : 120 + (t - 0.5) * 2 * 135);
              const g = Math.round(t < 0.5 ? 90 + t * 2 * 140 : 230);
              const b = Math.round(t < 0.5 ? 200 - t * 2 * 120 : 230);
              canvas.fillRect(x * scale, z * scale, scale, scale, r, g, b);
            }
          }
        } else {
          const mc = await run(() => bridge.request("map", { radius }, "query"));
          const palette = {
            ".": [30, 34, 40],
            "#": [110, 110, 116],
            "+": [150, 120, 80],
            T: [110, 80, 50],
            "*": [70, 130, 70],
            "~": [60, 110, 190],
            "^": [140, 140, 150],
            "@": [240, 120, 180],
          };
          for (let z = 0; z < side; z++) {
            const row = mc.grid[z] || "";
            for (let x = 0; x < side; x++) {
              const ch = row[x] || ".";
              const c = palette[ch] || palette["^"];
              canvas.fillRect(x * scale, z * scale, scale, scale, c[0], c[1], c[2]);
            }
          }
        }

        // 标记中心（自己所在位置）
        const center = radius * scale;
        canvas.fillRect(center - 2, center - 2, 5, 5, 255, 80, 160);

        const buffer = canvas.toPng();
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const relPath = `share/${kind}-${stamp}.png`;
        memory.write(relPath, ""); // 先确保目录存在
        const abs = path.join(memory.rootDir, relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buffer);

        const lines = [`已生成 ${kind} 图（${canvas.width}×${canvas.height}）`, `绝对路径：${abs}`];
        if (share.running) {
          const url = share.urlFor(abs);
          if (url) lines.push(`在线地址：${url}`);
        } else {
          lines.push("（文件分享未启动，只有本地路径）");
        }
        return lines.join("\n");
      },
    });

    /* ---- 30. express ---- */
    tool({
      id: `${PLUGIN_ID}_express`,
      name: "文件分享",
      description:
        "管理文件分享服务（只监听 127.0.0.1）。action：start（启动，可选 port）/ stop / status。" +
        "启动后 share 目录里的文件可以直接用 http 地址给用户看。",
      risk: "fs-write",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "start / stop / status" },
          port: { type: "number", description: "start 时的端口，默认 16050" },
        },
        required: ["action"],
      },
      async execute(args) {
        const action = String(args.action || "status").toLowerCase();

        if (action === "start") {
          if (Number.isFinite(Number(args.port))) {
            share.port = Number(args.port);
            writeSettings({ sharePort: Number(args.port) });
          }
          const result = await share.start();
          if (!result.ok) return `启动失败：${result.error}`;
          return `文件分享已启动：${result.url}\n根目录：${share.rootDir}`;
        }

        if (action === "stop") {
          await share.stop();
          return "文件分享已停止。";
        }

        return share.running ? `运行中：${share.baseUrl()}\n根目录：${share.rootDir}` : "未启动。";
      },
    });

    /* ---- 31. fs ---- */
    tool({
      id: `${PLUGIN_ID}_fs`,
      name: "记忆树文件操作",
      description:
        "在记忆树（.cyrene-craft/）里读写文件。action：list（给 path）/ read（给 path）/ write（给 path+content）/" +
        "append（给 path+content）/ remove（给 path）。只能操作记忆树内部，路径必须是相对路径。",
      risk: "fs-write",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "list / read / write / append / remove" },
          path: { type: "string", description: "相对记忆树根目录的路径" },
          content: { type: "string", description: "write / append 的内容" },
        },
        required: ["action"],
      },
      async execute(args) {
        const action = String(args.action || "list").toLowerCase();
        const rel = String(args.path || "");

        if (action === "list") {
          const entries = memory.list(rel);
          if (!entries.length) return `目录 ${rel || "."} 是空的。`;
          return entries.map((e) => `${e.type === "dir" ? "📁" : "📄"} ${e.name}${e.size != null ? `（${e.size} 字节）` : ""}`).join("\n");
        }

        if (action === "read") {
          const data = memory.read(rel);
          return `${data.path}（${data.size} 字节${data.truncated ? "，已截断" : ""}）：\n${data.content}`;
        }

        if (action === "write") {
          const data = memory.write(rel, args.content ?? "");
          return `已写入 ${data.path}（${data.bytes} 字节）`;
        }

        if (action === "append") {
          const data = memory.append(rel, args.content ?? "");
          return `已追加到 ${data.path}（现在 ${data.size} 字节）`;
        }

        if (action === "remove") {
          memory.remove(rel);
          return `已删除 ${rel}`;
        }

        throw new Error(`不认识的 action：${action}`);
      },
    });

    /* ---- 32. admin ---- */
    tool({
      id: `${PLUGIN_ID}_admin`,
      name: "插件诊断信息",
      description: "查看插件的数据目录、记忆树位置、账户库位置、分享端口、设置原文。排查找不到文件时用。",
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        return JSON.stringify(
          {
            version: PLUGIN_VERSION,
            dataDir,
            memoryRoot: memory.rootDir,
            accountsFile: accounts.file,
            share: { running: share.running, url: share.baseUrl(), root: share.rootDir },
            settings,
            runtime: runtime.ok
              ? { ok: true, source: runtime.source, version: runtime.version, dir: runtime.dir }
              : { ok: false, reason: runtime.reason },
          },
          null,
          2,
        );
      },
    });

    /* ---- 33. diag ---- */
    tool({
      id: `${PLUGIN_ID}_diag`,
      name: "运行时诊断",
      description:
        "深入诊断 mineflayer 运行时：尝试了哪些目录、哪个可用、版本多少、进程状态。连接失败时先跑这个。",
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        const report = describeRuntime({ dataDir, userDataDir });
        const s = bridge.status();
        return JSON.stringify(
          {
            runtime: report,
            bridge: {
              running: bridge.isRunning(),
              state: s.state,
              host: s.host,
              port: s.port,
              username: s.username,
              lastError: s.lastError,
              restartCount: s.restartCount,
            },
            tools: registeredTools.length,
          },
          null,
          2,
        );
      },
    });

    /* ---- 34. instincts ---- */
    tool({
      id: `${PLUGIN_ID}_instincts`,
      name: "本能反射设置",
      description:
        "查看或调整昔涟的**本能反射层**。这一层在她不接指令的时候也在跑：" +
        "血量低且有怪就逃、饿了自动吃东西、闲着时捡掉落物、太黑插火把、头顶悬沙闪避、溺水往上游、窒息挖开。" +
        "不传参数就返回当前状态；传参数则调整开关与阈值。" +
        "用户说「你别乱跑」「关掉自动行为」「饿了记得吃东西」时用。",
      risk: "safe",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", description: "总开关。关掉后她只会站着等你下指令" },
          lowHealth: { type: "number", description: "血量低于多少开始逃跑（1-19，默认 12）" },
          hungryFood: { type: "number", description: "饥饿低于多少自动进食（1-19，默认 14）" },
          tickMs: { type: "number", description: "多久检查一次（毫秒，200-5000，默认 800）" },
        },
        required: [],
      },
      async execute(args) {
        if (!bridge.isRunning()) {
          return "机器人没在运行，本能层也没在工作。先 connect 进去再说。";
        }
        const data = await run(() => bridge.request("instincts", args, "default"));
        const lines = [
          `本能层：${data.running ? "运行中" : "已关闭"}`,
          `检查间隔：${data.tickMs} ms`,
          `逃命血线：${data.lowHealth}/20`,
          `进食饿线：${data.hungryFood}/20`,
        ];
        if (data.lastAction) lines.push(`最近一次本能动作：${data.lastAction}`);
        return lines.join("\n");
      },
    });

    /* ---- 35. skill（技能库 / 自训练迭代） ---- */
    tool({
      id: `${PLUGIN_ID}_skill`,
      name: "技能库",
      description:
        "把跑通过的多步操作固化成可复用技能，下次一次调用完成，不用再一步步来。\n" +
        "action：\n" +
        "  list —— 列出所有技能与成功率\n" +
        "  get —— 看某个技能的步骤\n" +
        "  compile —— 从最近一段成功的操作轨迹编译成技能（不填 name 则自动起名）\n" +
        "  save —— 手动保存/覆盖一个技能\n" +
        "  run —— 执行技能，可传 params 覆盖参数\n" +
        "  stats —— 看统计：跑了多少次、成功率、耗时分布\n" +
        "  insight —— L2 归因分析：健康度、失败原因归类、可执行的优化提案（传 name 只看一个）\n" +
        "  brain —— 类脑决策：从轨迹图算出「下一步该做什么」，只建议不执行\n" +
        "  auto —— 执行环：算出下一步就真的去做，连跑几步，带停止条件（会真的动）\n" +
        "  reflex —— 审计反射层：每个技能的触发词、信心上限、能不能自动执行\n" +
        "  reflexTest —— 传 text 做匹配试跑，只打印结果不执行（dry-run）\n" +
        "  rank —— 流派排名：按目标分组，看谁是主程、谁该退役\n" +
        "  consolidate —— 空闲巩固：竞争、合并、剪枝（默认 dry-run，apply=true 才落盘）\n" +
        "  restore —— 恢复一个已归档的技能\n" +
        "  forget —— 删除技能\n" +
        "  trace —— 看最近的轨迹（调试用）\n" +
        "  goals —— 目标图：看已导入的攻略路线与进度（op=list / import / remove）\n" +
        "  import-goals —— 导入一份目标图 JSON（args.json 或 args.file）\n" +
        "  selfcheck —— 自检自修复：目标对账、清理失效黑名单、沉淀失败经验（apply=true 才落盘）\n" +
        "  lessons —— 看最近沉淀的经验与对账补完成的目标",
      risk: "safe",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "list / get / compile / save / run / stats / insight / brain / auto / reflex / reflexTest / rank / consolidate / restore / forget / trace / goals / import-goals / selfcheck / lessons" },
          name: { type: "string", description: "技能名（字母数字下划线短横线）；goals remove 时是图名" },
          json: { type: "string", description: "import-goals：目标图 JSON 字符串" },
          file: { type: "string", description: "import-goals：目标图 JSON 文件路径" },
          op: { type: "string", description: "goals：list（默认）/ import / remove" },
          params: { type: "object", description: "run 时的参数覆盖，如 { count: 16 }" },
          steps: { type: "array", description: "save 时的步骤数组" },
          description: { type: "string", description: "compile/save 时的技能说明" },
          text: { type: "string", description: "reflexTest：要试匹配的一句话" },
          profile: { type: "string", description: "rank/consolidate：评分档位 balanced（默认）/ speedrun / safe" },
          apply: { type: "boolean", description: "consolidate：true 才真正归档，默认只 dry-run" },
          count: { type: "number", description: "trace 时看最近多少条轨迹，默认 40" },
          current: { type: "string", description: "brain/auto：当前所处动作节点，不给则从最后一条轨迹推" },
          inventory: { type: "object", description: "brain/auto：背包快照 { item: count }，用于前置条件门禁" },
          blocks: { type: "object", description: "brain/auto：附近可及方块 { block: count }" },
          health: { type: "number", description: "brain/auto：当前血量" },
          oxygen: { type: "number", description: "brain/auto：当前氧气值" },
          connected: { type: "boolean", description: "brain/auto：是否已连接服务器" },
          targetHardness: { type: "number", description: "brain/auto：目标方块硬度，>0.5 视为需要镐" },
          limit: { type: "number", description: "brain/auto：返回几个候选，默认 4" },
          decay: { type: "number", description: "brain/auto：能量扩散每跳衰减，默认 0.55" },
          maxHops: { type: "number", description: "brain/auto：最多扩散几跳，默认 3" },
          maxSteps: { type: "number", description: "auto：最多连跑几步，默认 8" },
          maxFailures: { type: "number", description: "auto：连续失败几次放弃，默认 2" },
          stallSteps: { type: "number", description: "auto：连续几步分数不涨就停，默认 3" },
          minSuccessRate: { type: "number", description: "auto：成功率低于此值就跳过，默认 0.45" },
          minSamples: { type: "number", description: "auto：跑过多少次后成功率才有否决权，默认 5" },
        },
        required: ["action"],
      },
      async execute(args) {
        const action = String(args.action || "list").toLowerCase();

        /* ---- list ---- */
        if (action === "list") {
          const names = skillStore.listNames();
          if (!names.length) {
            return "技能库还是空的。先跑一次完整任务，再用 skill { action: \"compile\" } 把那段轨迹编成技能。";
          }
          const lines = [`共有 ${names.length} 个技能：`];
          for (const name of names) {
            const skill = skillStore.get(name);
            if (!skill) continue;
            const rate = skillStore.successRate(skill);
            const rateText = rate === null ? "未运行" : `${Math.round(rate * 100)}%（${skill.stats.success}/${skill.stats.runs}）`;
            lines.push(`- ${name}：${skill.description || "（无说明）"}｜L${skill.level}｜${rateText}`);
          }
          return lines.join("\n");
        }

        /* ---- reflex（审计，不执行） ---- */
        if (action === "reflex") {
          const names = skillStore.listNames();
          if (!names.length) {
            return "技能库是空的，反射层没有可匹配的技能。先 compile 或 save 一条。";
          }

          const minConfidence = Number(settings.reflexMinConfidence) || reflex.DEFAULT_MIN_CONFIDENCE;
          const lines = [
            `反射层：${settings.reflexEnabled ? "开" : "关"}｜自动执行门槛 ${minConfidence}`,
            `共 ${names.length} 个技能：`,
          ];

          for (const name of names) {
            const skill = skillStore.get(name);
            if (!skill) continue;

            // score=1 表示「假设这句话完美命中」，算的是这个技能的信心上限
            const ceiling = reflex.confidence({ skill, score: 1 });
            const allowed = reflex.isAutoAllowed(skill);
            const words = skill.triggers.words.length ? skill.triggers.words.join("、") : "（无）";
            const regexText = skill.triggers.regex.length ? `；正则 ${skill.triggers.regex.length} 条` : "";
            const archived = skill.archived === true ? "｜已归档" : "";

            lines.push(
              `- ${name}：信心上限 ${ceiling.toFixed(2)}｜${allowed ? "可自动" : "禁自动"}${archived}` +
                `｜触发词 ${words}${regexText}`,
            );
          }

          return lines.join("\n");
        }

        /* ---- reflexTest（dry-run，只匹配不执行） ---- */
        if (action === "reflextest") {
          const text = String(args.text || "").trim();
          if (!text) throw new Error("reflexTest 需要 text");

          const skills = skillStore
            .listNames()
            .map((name) => skillStore.get(name))
            .filter(Boolean);
          if (!skills.length) return "技能库是空的，没有可试匹配的技能。";

          const status = bridge.status();
          const ctx = {
            connected: status.state === "connected",
            health: status.health,
            food: status.food,
          };

          const candidates = reflex.match(text, skills, ctx);
          if (!candidates.length) {
            return `「${text}」没有命中任何技能。`;
          }

          const minConfidence = Number(settings.reflexMinConfidence) || reflex.DEFAULT_MIN_CONFIDENCE;
          const lines = [`「${text}」的匹配结果（dry-run，不执行）：`];

          for (const c of candidates) {
            const conf = reflex.confidence(c);
            const allowed = reflex.isAutoAllowed(c.skill);
            const reasons = [
              ...c.reason.words.map((w) => `词:${w}`),
              ...c.reason.regex.map((r) => `正则:${r}`),
            ].join(" ");

            lines.push(
              `- ${c.skill.name}：匹配 ${c.score.toFixed(2)}｜信心 ${conf.toFixed(2)}` +
                `｜${allowed ? "可自动" : "禁自动"}｜${reasons}`,
            );
          }

          const best = reflex.pick(candidates, { minConfidence });
          lines.push(
            best
              ? `→ 会执行 ${best.skill.name}（信心 ${best.confidence}）`
              : `→ 未达门槛 ${minConfidence}，交给模型处理`,
          );

          return lines.join("\n");
        }

        /* ---- rank（流派排名） ---- */
        if (action === "rank") {
          const skills = skillStore
            .listNames()
            .map((name) => skillStore.get(name))
            .filter(Boolean);
          if (!skills.length) return "技能库是空的，没有可排名的技能。";

          const profile = tradition.PROFILES[args.profile] ? args.profile : tradition.DEFAULT_PROFILE;
          const groups = tradition.groupByGoal(skills);
          const ranking = tradition.rank(groups, { profile });

          if (!ranking.groups.length) return "没有可参与竞争的非归档技能。";

          const lines = [`流派排名（profile: ${profile}）：`];
          for (const group of ranking.groups) {
            lines.push(`【${group.goal}】主流程：${group.primary || "暂无（整组都还没样本）"}`);

            const base = group.entries[0] && group.entries[0].score > 0 ? group.entries[0].score : 1;
            for (const entry of group.entries) {
              const mark =
                entry.status === "primary"
                  ? "★"
                  : entry.status === "backup"
                    ? "○"
                    : entry.status === "candidate"
                      ? "·"
                      : "×";
              const relative = Math.round((entry.score / base) * 100);
              lines.push(`  ${mark} ${entry.name}｜${entry.status}｜相对 ${relative}%｜弱计数 ${entry.weakStreak}`);
            }
          }

          return lines.join("\n");
        }

        /* ---- consolidate（空闲巩固） ---- */
        if (action === "consolidate") {
          const plan = runConsolidate({ apply: args.apply === true });
          if (!plan) return "巩固没有执行（正在执行中，或者刚巩固过还在冷却期）。";

          const lines = [plan.summary];

          if (plan.merges.length) {
            lines.push("合并：");
            for (const merge of plan.merges) {
              lines.push(`  ${merge.drop} → 并入 ${merge.keep}（累计 ${merge.stats.runs} 次）`);
            }
          }

          if (plan.archiveSkills.length) {
            lines.push(`归档清单：${plan.archiveSkills.join("、")}`);
          }

          const graphTotal = plan.graph.dropNodes.length + plan.graph.dropEdges.length;
          if (graphTotal) {
            lines.push(`图清理：节点 ${plan.graph.dropNodes.length} 个、边 ${plan.graph.dropEdges.length} 条`);
          }

          lines.push(
            plan.dryRun
              ? "这是 dry-run，没有改动技能库。确认后传 apply: true 再跑一次。"
              : "已落盘：被淘汰的技能标记为 archived，可用 restore 恢复。",
          );

          return lines.join("\n");
        }

        /* ---- restore（恢复归档） ---- */
        if (action === "restore") {
          const name = String(args.name || "").trim();
          if (!name) throw new Error("restore 需要 name");

          const skill = skillStore.get(name);
          if (!skill) throw new Error(`技能不存在：${name}`);
          if (skill.archived !== true) return `技能 ${name} 没有被归档，不需要恢复。`;

          const saved = skillStore.save(name, { ...skill, ...tradition.restorePatch() });
          return `已恢复技能 ${saved.name}，重新参与流派竞争。`;
        }

        /* ---- get ---- */
        if (action === "get") {
          const name = String(args.name || "").trim();
          if (!name) throw new Error("get 需要 name");
          const skill = skillStore.get(name);
          if (!skill) throw new Error(`技能不存在：${name}`);
          return JSON.stringify(skill, null, 2);
        }

        /* ---- trace ---- */
        if (action === "trace") {
          const count = Math.max(1, Math.min(Number(args.count) || 40, 200));
          const rows = trace.snapshot().slice(-count);
          if (!rows.length) return "还没有任何轨迹记录。跑几个工具之后再看。";
          const lines = [`最近 ${rows.length} 条轨迹：`];
          for (const r of rows) {
            const mark = r.ok ? "✔" : "✘";
            const argsText = r.args ? JSON.stringify(r.args).slice(0, 80) : "";
            lines.push(`${mark} ${r.tool} ${argsText}（${r.ms}ms，${r.origin}）`);
          }
          return lines.join("\n");
        }

        /* ---- compile ---- */
        if (action === "compile") {
          const episode = trace.latestCompilableEpisode(2);
          if (!episode) {
            return (
              "找不到可编译的轨迹段。需要满足：\n" +
              "- 至少 2 步\n" +
              "- 全部成功\n" +
              "- 由你发起（不是技能自己跑出来的）\n" +
              "- 相邻操作间隔不超过 15 秒\n\n" +
              "先完整跑一次任务，再调用 compile。"
            );
          }

          const name = String(args.name || "").trim() || suggestName(episode, {});
          if (!name) {
            return "这段轨迹里没有能固化的动作，不硬编成技能。";
          }

          const compiled = compileEpisode(episode, { description: args.description });
          if (!compiled) {
            return "这段轨迹只包含查询类操作，没有可复用的动作步骤，不编成技能。";
          }

          const saved = skillStore.save(name, compiled);
          const stepText = saved.steps.map((s) => s.cmd).join(" → ");
          return (
            `已从 ${episode.length} 条轨迹编译出技能 ${name}：\n` +
            `步骤：${stepText}\n` +
            `参数：${Object.keys(saved.params).join("、") || "无"}\n` +
            `下次用 skill { action: "run", name: "${name}" } 一次完成。`
          );
        }

        /* ---- save ---- */
        if (action === "save") {
          const name = String(args.name || "").trim();
          if (!name) throw new Error("save 需要 name");
          if (!Array.isArray(args.steps) || !args.steps.length) {
            throw new Error("save 需要 steps 数组，每项形如 { cmd, args }");
          }
          const saved = skillStore.save(name, {
            description: args.description || "",
            steps: args.steps,
          });
          return `已保存技能 ${saved.name}，共 ${saved.steps.length} 步。`;
        }

        /* ---- run ---- */
        if (action === "run") {
          const name = String(args.name || "").trim();
          if (!name) throw new Error("run 需要 name");
          requireConnected();

          // 技能执行期间标记 origin=skill，避免自己产生的轨迹被再次编译
          const result = await withSkillOrigin(() =>
            skillRunner.run(name, args.params && typeof args.params === "object" ? args.params : {}),
          );
          return skillRunner.format(result);
        }

        /* ---- stats ---- */
        if (action === "stats") {
          const name = String(args.name || "").trim();
          if (!name) throw new Error("stats 需要 name");
          const skill = skillStore.get(name);
          if (!skill) throw new Error(`技能不存在：${name}`);

          const s = skill.stats;
          const rate = skillStore.successRate(skill);
          const durations = s.durations || [];
          const lines = [
            `技能 ${name}（L${skill.level}）`,
            `运行次数：${s.runs}　成功 ${s.success}　失败 ${s.fail}`,
            `成功率：${rate === null ? "还没跑过" : `${Math.round(rate * 100)}%`}`,
          ];
          if (durations.length) {
            const sorted = [...durations].sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];
            lines.push(`耗时中位数：${(median / 1000).toFixed(1)} 秒（最近 ${durations.length} 次）`);
          }
          if (s.lastRunAt) lines.push(`最后运行：${s.lastRunAt}`);
          return lines.join("\n");
        }

        /* ---- insight（L2 归因分析） ---- */
        if (action === "insight") {
          const only = String(args.name || "").trim();

          // 只看一个技能：直接给它一份单技能报告
          if (only) {
            const skill = skillStore.get(only);
            if (!skill) throw new Error(`技能不存在：${only}`);

            const { analyzeSkill, proposeForSkill } = require("./src/skill-insight.cjs");
            const a = analyzeSkill(skill);
            const props = proposeForSkill(a, skill);

            const lines = [
              `技能 ${a.name}（L${a.level}，${a.steps} 步）`,
              `运行 ${a.runs} 次，成功 ${a.success}，失败 ${a.fail}`,
              `成功率：${a.successRate === null ? "还没跑过" : `${Math.round(a.successRate * 100)}%`}　健康度：${a.health}`,
            ];
            if (a.medianMs !== null) lines.push(`耗时中位数：${(a.medianMs / 1000).toFixed(1)} 秒（${a.samples} 个样本）`);
            if (a.trend) {
              const dir = { slower: "变慢", faster: "变快", stable: "基本稳定" }[a.trend.direction] || a.trend.direction;
              lines.push(
                `耗时趋势：${dir}（早期 ${(a.trend.earlyMedianMs / 1000).toFixed(1)}s → 近期 ${(a.trend.lateMedianMs / 1000).toFixed(1)}s，×${a.trend.ratio}）`,
              );
            }
            // 长尾单独一行：中位数说「稳定」不代表没有偶发灾难
            if (a.tail) {
              const t = a.tail;
              lines.push(
                `耗时长尾：p90 ${(t.p90Ms / 1000).toFixed(1)}s，最慢 ${(t.worstMs / 1000).toFixed(1)}s，` +
                  `超 ${(t.slowThresholdMs / 1000).toFixed(0)}s 的有 ${t.slowRuns} 次` +
                  `${t.flagged ? "（存在长尾）" : "（无明显长尾）"}`,
              );
            }
            if (a.causes.length) {
              lines.push("失败原因归因：");
              for (const c of a.causes) {
                lines.push(`- ${c.label}（${c.count} 次${c.steps.length ? `，第 ${c.steps.map((n) => n + 1).join("/")} 步` : ""}）`);
                if (c.samples[0]) lines.push(`    例：${c.samples[0]}`);
              }
            } else {
              lines.push("失败原因归因：暂无失败记录");
            }
            if (props.length) {
              lines.push("");
              lines.push("优化提案：");
              for (const p of props) lines.push(`- [${p.severity}] ${p.title}\n    ${p.detail}`);
            }
            return lines.join("\n");
          }

          // 全库分析
          const result = analyzeStore(skillStore, { top: Number(args.count) || 0 });
          return formatReport(result, { maxProposals: Number(args.count) || 8 });
        }

        /* ---- forget ---- */
        if (action === "forget") {
          const name = String(args.name || "").trim();
          if (!name) throw new Error("forget 需要 name");
          const r = skillStore.remove(name);
          return r.removed ? `已删除技能 ${name}。` : `技能 ${name} 本来就不存在。`;
        }

        /* ---- brain（类脑决策：从轨迹图算下一步） ---- */
        if (action === "brain") {
          const { buildGraph, nextAction, formatSuggestion, diffuse } = require("./src/skill-graph.cjs");

          // 图从已有轨迹建，跑得越多越准
          const rows = trace.snapshot();
          if (!rows.length) {
            return "还没有轨迹，先在真实世界里跑几次动作，图才有边可算。";
          }

          const graph = buildGraph(rows, { now: Date.now() });

          // 当前所处节点：调用方可以显式给，也可以从最后一条动作推
          const explicit = String(args.current || "").trim();
          let current = explicit;
          if (!current) {
            const lastAction = [...rows].reverse().find((r) => r && r.tool && r.origin !== "skill");
            if (lastAction) {
              const { nodeIdOf } = require("./src/skill-graph.cjs");
              current = nodeIdOf(lastAction.tool, lastAction.args);
            }
          }

          // 世界状态：调用方给多少算多少，缺的字段门禁就不判
          const worldCtx = {
            current,
            inventory: args.inventory || null,
            blocks: args.blocks || null,
            health: args.health,
            food: args.food,
            oxygen: args.oxygen,
            connected: args.connected,
            targetHardness: args.targetHardness,
            visited: new Set(),
          };

          const result = nextAction(graph, worldCtx, {
            limit: Number(args.limit) || 4,
            decay: args.decay,
            maxHops: args.maxHops,
          });

          const head = `图：${graph.nodes.size} 节点 / ${graph.edges.size} 边 / ${graph.episodes} 段经历`;
          const lines = [head];

          if (result.pick) {
            lines.push("", formatSuggestion(result));
            lines.push("", "候选：");
            result.candidates.forEach((c, i) => {
              const argText = Object.entries(c.args || {})
                .filter(([k, v]) => v != null && !["radius", "x", "y", "z"].includes(k))
                .slice(0, 3)
                .map(([k, v]) => `${k}=${v}`)
                .join(" ");
              const rate = Math.round(c.successRate * 100);
              lines.push(
                `  ${i + 1}. ${c.tool}${argText ? ` (${argText})` : ""}  ` +
                  `能量 ${c.energy.toFixed(3)}｜跑过 ${c.runs} 次｜成功 ${rate}%` +
                  (c.via ? `｜接在 ${c.via.split(":")[0]} 之后` : "")
              );
            });
          } else {
            lines.push("", result.note || "没有可推荐的下一步。");
          }

          return lines.join("\n");
        }

        /* ---- auto（执行环：算出下一步就真的去做） ---- */
        if (action === "auto") {
          // 手动执行环优先：先让自主驱动停下，避免两个流程同时操纵角色。
          // 不自动恢复 —— 手动接管之后，该不该继续跑由下一次明确指令决定。
          if (autoplay.running) {
            autoplay.stop("auto 工具接管");
            log("[autoplay] 因手动 auto 暂停；要继续自主跑请 skill autoplay start");
          }

          const status = bridge.status();
          if (status.state !== "connected") {
            throw new Error("机器人还没连进服务器，执行环没法动。先调用 cyrene-craft_connect");
          }

          const { buildGraph, nextAction, nodeIdOf } = require("./src/skill-graph.cjs");
          const { runLoop, formatRun, judgeOutcome } = require("./src/brain-loop.cjs");

          const rows = trace.snapshot();
          if (!rows.length) {
            return "还没有轨迹，图里没有边可算，执行环无从起步。先在真实世界里跑几次动作。";
          }

          const graph = buildGraph(rows, { now: Date.now() });

          // 起点：显式给优先，否则从最后一条真实动作推。
          // autopilot 的失败记录不算「当前所处节点」—— 那件事没做成，
          // 世界状态还停在原处，拿它当起点会从错误的位置扩散。
          let startNode = String(args.current || "").trim();
          if (!startNode) {
            const lastAction = [...rows]
              .reverse()
              .find((r) => r && r.tool && r.origin !== "skill" && r.origin !== "autopilot");
            if (lastAction) startNode = nodeIdOf(lastAction.tool, lastAction.args);
          }

          const snapStatus = () => bridge.status();

          /** 世界状态：每一步都重新取，别拿开跑时的快照跑完全程 */
          const getWorld = async () => {
            const s = snapStatus();

            // 背包从实时快照读，转成 { item: count }
            const inventory = {};
            for (const it of Array.isArray(s.inventory) ? s.inventory : []) {
              const name = it && it.name;
              if (!name) continue;
              inventory[name] = (inventory[name] || 0) + (Number(it.count) || 1);
            }

            return {
              connected: s.state === "connected",
              health: s.health,
              food: s.food,
              oxygen: s.oxygen,
              inventory,
              // 附近可及方块：门禁要判 collect 找得到目标才放行。
              // 这里不让执行环自己做全图扫描 —— 那是 read 工具该干的活，
              // 而 block 列表为空时门禁会跳过这条判断（见 gate 里 blocks 的用法）。
              blocks: args.blocks || null,
            };
          };

          /**
           * 真正执行：走 bridge，不走工具包装。
           *
           * 失败要写进轨迹，成功不写。
           *
           * 道理在于方向：成功是图本来就会推荐的动作，再记一次只会把它推得更高，
           * 形成自我强化；失败是图不知道的事 —— 它以为这里挖得到，实际挖不到。
           * 不记，下次还会推荐同一个动作，撞同一堵墙。
           *
           * 用 origin: "autopilot" 标记来源，跟模型发起的动作区分开。
           * buildGraph 只排除 origin === "skill"，autopilot 会正常进图。
           *
           * 另外「跑完了」和「做成了」不是一回事：collect 找不到目标时
           * 仍然返回 ok:true，只用 complete:false 表示没达成目标。
           */
          const execute = async (tool, toolArgs) => {
            const startedAt = Date.now();
            let verdict;
            let data = null;

            try {
              data = await bridge.request(tool, toolArgs, tool);
              verdict = judgeOutcome(data);
            } catch (e) {
              verdict = { ok: false, error: e && e.message ? e.message : String(e) };
            }

            if (!verdict.ok) {
              try {
                trace.record({
                  tool,
                  args: toolArgs,
                  ok: false,
                  ms: Date.now() - startedAt,
                  origin: "autopilot",
                  error: verdict.error,
                });
              } catch (e) {
                log(`[autopilot] 失败轨迹记录失败（不影响执行）：${e.message}`);
              }
            }

            return verdict.ok
              ? { ok: true, data }
              : { ok: false, error: verdict.error, data };
          };

          const result = await runLoop({
            graph,
            current: startNode,
            visited: [],
            nextAction,
            getWorld,
            execute,
            isConnected: () => snapStatus().state === "connected",
            opts: {
              maxSteps: Number(args.maxSteps) || undefined,
              maxFailures: Number(args.maxFailures) || undefined,
              stallSteps: Number(args.stallSteps) || undefined,
              candidates: Number(args.limit) || undefined,
              minSuccessRate:
                args.minSuccessRate != null ? Number(args.minSuccessRate) : undefined,
              minSamples: Number(args.minSamples) || undefined,
            },
          });

          const head = `图：${graph.nodes.size} 节点 / ${graph.edges.size} 边`;
          const tail = result.finalCurrent ? `\n现在停在：${result.finalCurrent}` : "";
          return `${head}\n${formatRun(result)}${tail}`;
        }

        /* ---- selfcheck（自检自修复：目标对账 + 经验沉淀） ---- */
        if (action === "selfcheck") {
          const apply = args.apply === true;
          const report = await autoplay.selfCheck({ apply });
          const lines = [
            `自检：${report.ok ? "完成" : "跳过"}${report.reason ? `（${report.reason}）` : ""}`,
            `已修复：${report.repaired.length} 项目标${apply ? "" : "（dry-run，未落盘）"}`,
          ];
          for (const item of report.repaired) {
            lines.push(
              `- ${item.graphName || ""} / ${item.graphNodeId || item.target}：${item.reason}`,
            );
          }
          if (report.findings.length) {
            lines.push("发现：");
            for (const item of report.findings) {
              lines.push(`- ${item.kind}${item.name ? `：${item.name}` : ""}`);
            }
          }
          if (report.needsModel) {
            lines.push("需要模型介入：当前目标连续尝试但没有进展。");
          }
          return lines.join("\n");
        }

        /* ---- lessons（最近沉淀的经验） ---- */
        if (action === "lessons") {
          const snap = autoplay.snapshot();
          const lessons = Array.isArray(snap.lessons) ? snap.lessons : [];
          const repairs = Array.isArray(snap.repairs) ? snap.repairs : [];
          const lines = [`最近经验：${lessons.length} 条｜对账补完成：${repairs.length} 条`];
          for (const item of lessons) {
            lines.push(
              `- ${item.name}：${item.block || "?"} + ${item.tool || "?"}（${item.saved ? "已保存" : item.reason || "未保存"}）`,
            );
          }
          for (const item of repairs) {
            lines.push(
              `- 对账：${item.graphNodeId || item.target || "?"}（${item.reason || "inventory"}）`,
            );
          }
          return lines.join("\n");
        }

        /* ---- autoplay（自主驱动：进服即跑，不依赖模型） ---- */
        if (action === "autoplay") {
          const op = String(args.op || args.sub || "status").toLowerCase();

          if (op === "start") {
            writeSettings({ autoplayEnabled: true });
            const snap = autoplay.start("手动开启");
            return `自主驱动已开启。\n${JSON.stringify(snap, null, 2)}`;
          }

          if (op === "stop") {
            writeSettings({ autoplayEnabled: false });
            const snap = autoplay.stop("手动关闭");
            return `自主驱动已关闭。\n${JSON.stringify(snap, null, 2)}`;
          }

          if (op === "once") {
            const r = await autoplay.once();
            return `手动一步：${r && r.ok ? "成功" : "未执行"}\n${JSON.stringify(r, null, 2)}`;
          }

          return JSON.stringify(
            { autoplay: autoplay.snapshot(), muscle: muscle.snapshot() },
            null,
            2,
          );
        }

        /* ---- goals（目标图：外部攻略导入） ---- */
        if (action === "goals" || action === "import-goals") {
          const op =
            action === "import-goals"
              ? "import"
              : String(args.op || args.sub || "list").toLowerCase();

          if (op === "list" || op === "status") {
            const loaded = reloadGoalGraphs();
            const lines = [`目标图：${loaded.graphs.length} 份`];

            for (const g of loaded.graphs) {
              const done = goalGraphs.done.get(g.name) || new Set();
              const p = goalGraphLib.progressOf(g, done);
              const next = goalGraphLib.nextNode(g, done);

              lines.push(
                `- ${g.name}（${p.done}/${p.total}，${p.percent}%）` +
                  (next ? `｜下一个：${next.title}` : "｜已完成"),
              );
            }

            if (loaded.errors.length) {
              lines.push("读取失败的：");
              for (const e of loaded.errors) {
                lines.push(`  ${e.file}：${e.errors.join("；")}`);
              }
            }

            if (!loaded.graphs.length) {
              lines.push(
                `还没有导入。把目标图 JSON 放进 ${goalStore.dirOf(memoryRoot)}，` +
                  "或用 skill { action: \"import-goals\", file: \"...\" } 导入。",
              );
            }

            return lines.join("\n");
          }

          if (op === "import") {
            const raw = args.json || args.data;
            const file = args.file ? path.resolve(String(args.file)) : null;

            let input = raw;
            if (!input && file) {
              try {
                input = fs.readFileSync(file, "utf8");
              } catch (e) {
                throw new Error(`读不到 ${file}：${e.message}`);
              }
            }
            if (!input) {
              throw new Error("需要 args.json（JSON 字符串）或 args.file（文件路径）");
            }

            const imported = goalStore.importGraph(memoryRoot, input);
            if (!imported.ok) {
              throw new Error(`导入失败：${imported.errors.join("；")}`);
            }

            reloadGoalGraphs();
            notifyGoals();
            const done = goalGraphs.done.get(imported.graph.name) || new Set();
            const p = goalGraphLib.progressOf(imported.graph, done);

            return (
              `已导入「${imported.graph.name}」：${imported.graph.nodes.length} 个节点，` +
              `当前进度 ${p.done}/${p.total}。\n文件：${imported.file}`
            );
          }

          if (op === "remove") {
            const name = String(args.name || "").trim();
            if (!name) throw new Error("需要 args.name（图名）");

            const removed = goalStore.removeGraph(memoryRoot, name);
            if (!removed.ok) throw new Error(`删除失败：${removed.errors.join("；")}`);

            reloadGoalGraphs();
            notifyGoals();
            return `已删除目标图：${name}`;
          }

          throw new Error("未知 op。可用：list / import / remove");
        }

        /* ---- routes（路线库：地形指纹 → 接近路线） ---- */
        if (action === "routes") {
          const op = String(args.op || args.sub || "list").toLowerCase();

          if (op === "get") {
            const key = String(args.name || args.id || "").trim();
            const list = routeMemory.list();
            const found = list.find((r) => r.id === key || r.goal === key);
            return found ? JSON.stringify(found, null, 2) : "没有找到这条路线。";
          }

          if (op === "export") {
            return JSON.stringify(
              { snapshot: routeMemory.snapshot(), routes: routeMemory.list() },
              null,
              2,
            );
          }

          if (op === "rank") {
            const list = routeMemory.list();
            if (!list.length) return "路线库是空的。";
            return list
              .slice(0, 20)
              .map((r) => {
                const rate = r.runs ? Math.round((r.ok / r.runs) * 100) : 0;
                return `${r.goal}｜${r.id}｜跑过 ${r.runs} 次｜成功 ${rate}%｜${r.steps.length} 步`;
              })
              .join("\n");
          }

          if (op === "clear-blocked" || op === "unblock" || op === "clear") {
            const removed = routeMemory.clearBlocked({
              goal: args.name || args.goal || "",
              terrainKey: args.terrainKey || "",
            });
            return `已清除 ${removed} 条负记忆。`;
          }

          const snap = routeMemory.snapshot();
          const list = routeMemory.list().slice(0, 20);
          const lines = [
            `路线：${snap.routes} 条｜负记忆：${snap.blocked} 条｜命中 ${snap.stats.hit}/${snap.stats.recall}`,
          ];
          if (!list.length) {
            lines.push("还没有积累路线。collect 失败并换接近面成功之后会写进来。");
          }
          for (const r of list) {
            const rate = r.runs ? Math.round((r.ok / r.runs) * 100) : 0;
            lines.push(`- ${r.goal}（${r.steps.length} 步，成功 ${rate}%，跑过 ${r.runs} 次）`);
          }
          return lines.join("\n");
        }

        throw new Error(
          `未知 action：${action}。可用：list / get / compile / save / run / stats / insight / brain / auto / autoplay / routes / selfcheck / lessons / forget / trace`,
        );
      },
    });

    /* ============================ IPC ============================ */
    /** 给设置窗口用的完整快照 */
    const snapshot = () => ({
      version: PLUGIN_VERSION,
      status: bridge.status(),
      settings,
      runtime: runtime.ok
        ? { ok: true, version: runtime.version, source: runtime.source, label: runtime.label }
        : { ok: false, reason: runtime.reason },
      accounts: accounts.list(),
      lastServer: ctx.storage.get(KEY_LAST_SERVER) || null,
      share: { running: share.running, url: share.baseUrl(), port: share.port },
      panel: {
        running: panel.running,
        url: panel.baseUrl,
        port: panel.port,
        clients: panel.clients.size,
        error: panel.error,
      },
      memoryRoot: memory.rootDir,
      skillsDir: skillStore.rootDir,
      traceDir: trace.dir,
      autoplay: autoplay.snapshot(),
      muscle: muscle.snapshot(),
      routes: routeMemory.snapshot(),
      toolCount: registeredTools.length,
    });

    ctx.registerIpc("snapshot", () => snapshot());

    ctx.registerIpc("settings", async (payload) => {
      const patch = payload && typeof payload === "object" ? payload : {};
      writeSettings(patch);
      return settings;
    });

    ctx.registerIpc("connect", async (payload) => {
      const p = payload || {};
      const address = String(p.address || "").trim();
      if (!address) throw new Error("服务器地址不能为空");

      let host = address;
      let port = 25565;
      const colon = address.lastIndexOf(":");
      if (colon > 0) {
        const maybePort = Number(address.slice(colon + 1));
        if (Number.isFinite(maybePort) && maybePort > 0) {
          host = address.slice(0, colon);
          port = maybePort;
        }
      }

      const username = String(p.username || settings.defaultUsername || "Cyrene").trim();
      await ensureRuntime();
      syncRuntimePath();
      await bridge.connect({ host, port, username });
      ctx.storage.set(KEY_LAST_SERVER, { host, port, username, at: new Date().toISOString() });
      return bridge.status();
    });

    ctx.registerIpc("disconnect", async () => bridge.disconnect());

    ctx.registerIpc("accounts", async (payload) => {
      const p = payload || {};
      if (p.action === "add") {
        accounts.upsert({ name: p.name, server: p.server, type: "offline" });
      } else if (p.action === "remove" && p.id) {
        accounts.remove(String(p.id));
      }
      return accounts.list();
    });

    ctx.registerIpc("share", async (payload) => {
      const p = payload || {};
      if (p.action === "start") {
        if (Number.isFinite(Number(p.port))) share.port = Number(p.port);
        const result = await share.start();
        return { ...result, root: share.rootDir };
      }
      if (p.action === "stop") {
        await share.stop();
        return { ok: true };
      }
      return { ok: share.running, url: share.baseUrl(), port: share.port, root: share.rootDir };
    });

    /* ---------------------------- 训练面板 IPC ---------------------------- */

    ctx.registerIpc("panel", async (payload) => {
      const p = payload || {};

      if (p.action === "start") {
        if (Number.isFinite(Number(p.port))) {
          panel.port = Number(p.port);
          writeSettings({ panelPort: Number(p.port) });
        }
        const result = await panel.start();
        return { ...result, url: panel.baseUrl };
      }

      if (p.action === "stop") {
        await panel.stop();
        return { ok: true };
      }

      return {
        ok: panel.running,
        url: panel.baseUrl,
        port: panel.port,
        clients: panel.clients.size,
        error: panel.error,
      };
    });

    /* ============================ 清理 ============================ */

    // 空闲 5 分钟检查：每分钟看一次，满足条件就做一次 dry-run 巩固。
    // unref 让定时器不阻止进程退出；cleanup 里也会清掉。
    const idleTimer = setInterval(() => {
      if (Date.now() - lastActivityAt >= 5 * 60 * 1000) {
        maybeAutoConsolidate();
      }
    }, 60 * 1000);
    if (typeof idleTimer.unref === "function") idleTimer.unref();

    let disposed = false;

    const cleanup = async () => {
      if (disposed) return;
      disposed = true;
      log("正在清理…");
      try {
        clearInterval(idleTimer);
      } catch {
        /* ignore */
      }
      try {
        autoplay.stop("插件卸载");
      } catch {
        /* ignore */
      }
      try {
        // 把没落盘的肌肉记忆和路线写下去，下次进服还能用
        muscle.flush();
        routeMemory.flush();
      } catch {
        /* ignore */
      }
      try {
        await channel.stop();
      } catch {
        /* ignore */
      }
      try {
        await share.stop();
      } catch {
        /* ignore */
      }
      try {
        await panel.stop();
      } catch {
        /* ignore */
      }
      try {
        await bridge.stop();
      } catch {
        /* ignore */
      }
    };

    ctx.onDispose(() => {
      // onDispose 的 5 秒上限可能不够等子进程，所以主要靠 unregister；
      // 这里做个兜底，能等多少等多少
      void cleanup();
    });

    // unregister 由宿主的停止流程调用；必须可重复调用
    plugin.__cleanup = cleanup;

    // 训练面板默认随插件加载启动，用户可以直接点开看。
    // 失败不影响插件本体（端口被占用之类）。
    if (settings.panelAutoStart) {
      void panel.start().then((r) => {
        if (!r.ok) log(`训练面板没起来：${r.error}（可以用 IPC panel start 重试或换端口）`);
      });
    }

    log(`已注册 ${registeredTools.length} 个工具、渠道、提示词 Provider 与 IPC`);
  },

  /** 停用/刷新/退出时调用；必须可重复调用不崩 */
  async unregister() {
    const fn = plugin.__cleanup;
    plugin.__cleanup = null;
    if (typeof fn === "function") {
      try {
        await fn();
      } catch {
        /* 清理失败不能让卸载流程挂住 */
      }
    }
  },

  /** 打开设置窗口 */
  async open() {
    let BrowserWindow;
    let ipcMain;
    try {
      ({ BrowserWindow, ipcMain } = require("electron"));
    } catch {
      return;
    }

    if (plugin.__win && !plugin.__win.isDestroyed()) {
      plugin.__win.focus();
      return;
    }

    const win = new BrowserWindow({
      width: 760,
      height: 720,
      minWidth: 520,
      minHeight: 480,
      frame: false,
      autoHideMenuBar: true,
      backgroundColor: "#1a1620",
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });

    plugin.__win = win;

    const onMin = () => win && !win.isDestroyed() && win.minimize();
    const onClose = () => win && !win.isDestroyed() && win.close();

    ipcMain.on(`plugin:${PLUGIN_ID}:win-minimize`, onMin);
    ipcMain.on(`plugin:${PLUGIN_ID}:win-close`, onClose);

    win.on("closed", () => {
      plugin.__win = null;
      ipcMain.removeListener(`plugin:${PLUGIN_ID}:win-minimize`, onMin);
      ipcMain.removeListener(`plugin:${PLUGIN_ID}:win-close`, onClose);
    });

    await win.loadFile(path.join(__dirname, "ui.html"));
  },
};

/**
 * 找 plugin-data 目录。
 *
 * Cyrene 的插件数据一般在 `%APPDATA%/Cyrene/plugin-data/<id>/`。
 * 宿主没有把路径直接给插件，所以从已知位置推断；
 * 推断失败就退到系统的 appdata 目录，至少能落盘。
 */
function resolveDataDir() {
  const base =
    process.env.CYRENE_USER_DATA ||
    process.env.APPDATA ||
    process.env.XDG_CONFIG_HOME ||
    process.env.HOME ||
    process.cwd();

  // process.env.APPDATA 在 Windows 上就是 Roaming
  const candidates = [
    path.join(base, "Cyrene", "plugin-data", PLUGIN_ID),
    path.join(base, "plugin-data", PLUGIN_ID),
  ];

  for (const dir of candidates) {
    // 只要父目录存在就用它；不存在的会由调用方 mkdir
    const parent = path.dirname(dir);
    if (fs.existsSync(parent)) return dir;
  }

  return candidates[0];
}

module.exports = plugin;
