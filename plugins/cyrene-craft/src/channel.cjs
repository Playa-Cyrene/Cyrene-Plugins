"use strict";

/**
 * 游戏聊天渠道适配器 + 唤醒队列。
 *
 * ── 为什么需要这个 ─────────────────────────────────────────────
 * whale-craft 用 DSH 的 job 结算 + followup 实现「看门狗」：游戏里有人叫它，
 * 它能主动打断当前对话去回应。Cyrene 没有这个 API。
 *
 * 但 Cyrene 的 channel adapter 有 `onMessage`——宿主调度器用来接收
 * 「一条来自外部渠道的新消息」的入口。所以只要在需要时自己构造一条入站消息
 * 交给 onMessage，宿主就会正常跑一轮 Agent，昔涟就被叫醒了。
 *
 * ── 代价与边界 ─────────────────────────────────────────────────
 * 这不是免费的：每唤醒一次就是一轮完整的 LLM 调用。
 * 所以这里做了三层约束：
 *   1. 默认只响应「点名」和「私聊」，不响应所有闲聊
 *   2. 全局冷却（默认 90 秒），同类事件另有独立阈值
 *   3. 唤醒总开关默认关闭，由用户在设置里打开
 *
 * 另外，唤醒消息会带明确来源标记（`source: "wake"`），
 * 提示词里也写清楚这是游戏内事件，不是用户本人发的。
 */

const GAME_CHAT_LINE_LIMIT = 256;
const LINE_SEND_INTERVAL_MS = 350;

/** 反射层：模型之前的肌肉记忆。纯函数，不产生 IO */
const reflex = require("./reflex.cjs");

/** 默认点名关键词 */
const DEFAULT_MENTION_PATTERNS = ["昔涟", "cyrene", "小昔", "希琳"];

/** 唤醒类型：冷却时间（毫秒）与最小间隔 */
const WAKE_POLICY = {
  mention: { cooldown: 0, hint: "有人在游戏里叫你" },
  hurt: { cooldown: 30_000, hint: "你被打了一下" },
  low_health: { cooldown: 60_000, hint: "你的血量很低" },
  death: { cooldown: 10_000, hint: "你死了" },
  disconnect: { cooldown: 10_000, hint: "你和服务器断开了" },
};

const CAPABILITY = {
  text: true,
  image: false,
  audio: false,
  file: false,
  video: false,
  markdown: false,
  card: false,
  sticker: false,
  maxTextLength: GAME_CHAT_LINE_LIMIT,
};

class MinecraftChannelAdapter {
  /**
   * @param {object} opts
   * @param {object} opts.bridge      BotBridge
   * @param {() => object} opts.getSettings 读当前设置（mentions / wakeEnabled / cooldown 等）
   * @param {(msg:string)=>void} opts.log
   */
  constructor(opts) {
    this.bridge = opts.bridge;
    this.getSettings = opts.getSettings || (() => ({}));
    this.log = opts.log || (() => {});

    /**
     * 反射层依赖：技能库 + 执行器 + 轨迹。
     * 技能库用 getter：记忆树换根时 index.cjs 会重建 SkillStore，
     * 直接存实例会让反射层一直读旧目录。
     */
    const fixedStore = opts.skillStore || null;
    this.getSkillStore = opts.getSkillStore || (() => fixedStore);
    this.skillRunner = opts.skillRunner || null;
    this.trace = opts.trace || null;

    /** 同一时刻只允许一次反射执行，避免两个技能同时操纵同一个角色 */
    this.reflexBusy = false;

    this.id = "minecraft-cyrene";
    this.displayName = "Minecraft（昔涟）";
    this.capability = CAPABILITY;

    /** 宿主设置的回调；send() 不用它，但 onMessage 存在性决定能否唤醒 */
    this.onMessage = null;

    this.unsubs = [];

    /** 最近一次唤醒时间，用于全局冷却 */
    this.lastWakeAt = 0;
    /** 每类事件上次触发时间 */
    this.lastWakeByKind = new Map();
    /** 已发送过的消息 id，避免同一条消息重复唤醒 */
    this.seenMessageIds = new Set();
    this.maxSeenIds = 500;
  }

  /* --------------------------- 生命周期 --------------------------- */

  async start() {
    // 玩家说话
    this.unsubs.push(
      this.bridge.onChat((player, message, raw) => {
        void this.#handleGameChat(player, message, raw);
      }),
    );

    // 被动事件：被打、死、掉线
    this.unsubs.push(
      this.bridge.onEvent((event, data) => {
        void this.#handleGameEvent(event, data);
      }),
    );
  }

  async stop() {
    for (const unsub of this.unsubs) {
      try {
        unsub();
      } catch {
        /* 退订失败不影响清理 */
      }
    }
    this.unsubs = [];
  }

  /* --------------------------- 入站 --------------------------- */

  /**
   * 判断这句话是不是在叫昔涟。
   *
   * 除了显式点名，还接受「@」前缀和「私聊」这两种明确指向。
   * 不做模糊匹配——宁可漏，也不要每句话都触发一轮 LLM。
   */
  isMentioned(text) {
    const settings = this.getSettings();
    const patterns = Array.isArray(settings.mentions) && settings.mentions.length
      ? settings.mentions
      : DEFAULT_MENTION_PATTERNS;

    const lower = String(text || "").toLowerCase();
    if (!lower.trim()) return false;

    // 显式 @
    if (lower.startsWith("@")) return true;

    for (const raw of patterns) {
      const p = String(raw || "").trim().toLowerCase();
      if (!p) continue;
      if (lower.includes(p)) return true;
    }
    return false;
  }

  async #handleGameChat(player, message, raw) {
    const settings = this.getSettings();

    // 自己的发言已经在 bridge 里过滤过，这里再防一层
    if (!player || !message) return;
    if (player === this.bridge.status().username) return;

    const mentioned = this.isMentioned(message);
    const respondToAll = settings.respondToAll === true;

    // 模型之前先问一次肌肉记忆。
    // 命中且执行成功 → 直接回复玩家，不惊动 LLM。
    // 没命中 → 继续走原来的点名逻辑。
    // 执行失败 → 强制投递给模型，让它接手补救。
    const reflexOutcome = await this.#tryReflex(player, message);
    if (reflexOutcome === "done") return;

    const forceDeliver = reflexOutcome === "failed";

    // 不点名、也没开「全部响应」——那这条消息只进日志，不惊动模型
    if (!mentioned && !respondToAll && !forceDeliver) return;

    if (!this.onMessage) {
      this.log("[channel] 宿主未接管渠道消息，跳过本次投递");
      return;
    }

    const messageId = `mc-${raw && raw.at ? raw.at : Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (this.seenMessageIds.has(messageId)) return;
    this.#rememberId(messageId);

    const status = this.bridge.status();

    const inMsg = {
      channel: this.id,
      chatType: "group",
      messageId,
      senderId: player,
      senderName: player,
      chatId: status.host ? `${status.host}:${status.port ?? 25565}` : "minecraft-server",
      // 明确标注这是游戏内说话，避免模型误以为是用户本人在桌面端打的字
      text: mentioned ? message : `（游戏里 ${player} 说：${message}）`,
      at: new Date(),
    };

    try {
      await this.onMessage(inMsg);
    } catch (e) {
      this.log(`[channel] 调度器处理游戏消息失败：${e && e.message ? e.message : e}`);
    }
  }

  /**
   * 肌肉记忆前置拦截。
   *
   * 返回值：
   *   "done"   命中并执行成功，消息到此为止，不惊动模型
   *   "failed" 命中但执行失败，调用方应强制投递给模型接手
   *   null     没命中 / 开关关闭 / 安全门禁拒绝，按原逻辑处理
   */
  async #tryReflex(player, message) {
    const settings = this.getSettings();
    if (settings.reflexEnabled !== true) return null;
    if (!this.skillRunner) return null;
    if (this.reflexBusy) return null;

    const store = this.getSkillStore();
    if (!store) return null;

    let hit = null;
    try {
      const skills = store
        .listNames()
        .map((name) => store.get(name))
        .filter(Boolean);
      if (!skills.length) return null;

      const status = this.bridge.status();
      const ctx = {
        connected: status.state === "connected",
        health: status.health,
        food: status.food,
      };

      const rawMin = Number(settings.reflexMinConfidence);
      const candidates = reflex.match(message, skills, ctx);
      hit = reflex.pick(candidates, Number.isFinite(rawMin) ? { minConfidence: rawMin } : {});

      if (!hit) return null;
      if (!reflex.isAutoAllowed(hit.skill)) {
        this.log(`[reflex] ${hit.skill.name} 命中但未通过安全门禁，交给模型`);
        return null;
      }
    } catch (e) {
      this.log(`[reflex] 匹配失败，回落到模型：${e && e.message ? e.message : e}`);
      return null;
    }

    const startedAt = Date.now();
    this.reflexBusy = true;
    this.log(`[reflex] 命中 ${hit.skill.name} confidence=${hit.confidence}（${player}: ${message}）`);

    let result;
    try {
      result = await this.skillRunner.run(hit.skill.name, {});
    } catch (e) {
      result = { ok: false, error: e && e.message ? e.message : String(e) };
    } finally {
      this.reflexBusy = false;
    }

    this.#recordReflexTrace(hit, message, result, Date.now() - startedAt);

    if (!result || !result.ok) {
      this.log(
        `[reflex] ${hit.skill.name} 执行失败，回落到模型：${(result && (result.error || result.reason)) || "未知原因"}`,
      );
      return "failed";
    }

    // 文案要短：游戏聊天是全服可见的，别让一次肌肉记忆刷屏。
    const label = String(hit.skill.description || hit.skill.name).slice(0, 30);
    try {
      await this.bridge.request("say", { message: `好呀，${label} 完成♪` }, "default");
    } catch (e) {
      this.log(`[reflex] 回复失败（不影响执行结果）：${e.message}`);
    }

    return "done";
  }

  /** 反射执行也写轨迹：成功失败都要留证据，之后才知道该不该继续信任它 */
  #recordReflexTrace(hit, text, result, durationMs) {
    if (!this.trace || typeof this.trace.record !== "function") return;

    try {
      this.trace.record({
        tool: "reflex",
        args: {
          skill: hit.skill.name,
          text: String(text || "").slice(0, 120),
          score: hit.score,
          confidence: hit.confidence,
        },
        ok: Boolean(result && result.ok),
        ms: durationMs,
        origin: "reflex",
        error: result && !result.ok ? result.error || result.reason : undefined,
      });
    } catch (e) {
      this.log(`[reflex] 写轨迹失败（不影响主流程）：${e.message}`);
    }
  }

  #rememberId(id) {
    this.seenMessageIds.add(id);
    if (this.seenMessageIds.size > this.maxSeenIds) {
      // Set 保序，删最早的几个
      const drop = this.seenMessageIds.size - this.maxSeenIds;
      let i = 0;
      for (const old of this.seenMessageIds) {
        if (i++ >= drop) break;
        this.seenMessageIds.delete(old);
      }
    }
  }

  /* --------------------------- 唤醒（看门狗等价物） --------------------------- */

  /**
   * 判断这次事件该不该把 AI 叫起来。
   *
   * 三道闸门：
   *   1. 总开关（默认关）
   *   2. 全局冷却
   *   3. 同类事件冷却
   */
  shouldWake(kind) {
    const settings = this.getSettings();
    if (settings.wakeEnabled !== true) return false;

    const now = Date.now();
    const globalCooldown = Number(settings.wakeCooldownMs) || 90_000;

    if (now - this.lastWakeAt < globalCooldown) return false;

    const policy = WAKE_POLICY[kind];
    if (!policy) return false;

    const last = this.lastWakeByKind.get(kind) || 0;
    if (now - last < policy.cooldown) return false;

    return true;
  }

  /** 真正投递一次唤醒 */
  async #wake(kind, text, meta = {}) {
    if (!this.shouldWake(kind)) return false;
    if (!this.onMessage) return false;

    const now = Date.now();
    this.lastWakeAt = now;
    this.lastWakeByKind.set(kind, now);

    const status = this.bridge.status();
    const messageId = `mc-wake-${kind}-${now}-${Math.random().toString(36).slice(2, 8)}`;
    this.#rememberId(messageId);

    const inMsg = {
      channel: this.id,
      chatType: "group",
      messageId,
      senderId: "minecraft-system",
      senderName: "Minecraft",
      chatId: status.host ? `${status.host}:${status.port ?? 25565}` : "minecraft-server",
      text,
      at: new Date(),
      // 宿主会忽略未知字段，但日志里能看到这是唤醒
      source: "wake",
      wakeKind: kind,
      ...meta,
    };

    try {
      await this.onMessage(inMsg);
      this.log(`[channel] 已唤醒（${kind}）：${WAKE_POLICY[kind].hint}`);
      return true;
    } catch (e) {
      this.log(`[channel] 唤醒投递失败：${e && e.message ? e.message : e}`);
      return false;
    }
  }

  async #handleGameEvent(event, data) {
    const settings = this.getSettings();
    if (settings.wakeEnabled !== true) return;

    switch (event) {
      case "hurt": {
        if (!this.shouldWake("hurt")) return;
        // 只说「被攻击」，原因与环境伤害分开，避免把摔落当敌人
        const who = data && data.attacker && data.attacker.name
          ? `（${data.attacker.name}${data.attacker.distance != null ? `，${data.attacker.distance} 格外` : ""}）`
          : "";
        const why = data && data.reason ? `，伤害类型 ${data.reason}` : "";
        await this.#wake(
          "hurt",
          `【游戏内事件】你在 Minecraft 里被实体攻击了${who}，血量从 ${data.from} 掉到 ${data.to}${why}。` +
            `需要的话可以看看周围有什么，或者先躲开。`,
        );
        break;
      }

      case "damage": {
        // 环境伤害（摔落/饥饿/岩浆…）只记录，不唤醒。
        // 砍树时从树顶掉下来不该打断正在跑的技能。
        this.log(
          `[channel] 环境伤害已记录：${data.origin}/${data.reason} -${data.amount}（${data.from}→${data.to}）`,
        );
        break;
      }

      case "death": {
        if (!this.shouldWake("death")) return;
        const pos = data && data.position
          ? `(${Math.round(data.position.x)}, ${Math.round(data.position.y)}, ${Math.round(data.position.z)})`
          : "未知位置";
        await this.#wake("death", `【游戏内事件】你在 Minecraft 里死了，死在 ${pos}。要不要回去捡东西？`);
        break;
      }

      case "state": {
        // 掉线才值得叫，连上不用
        if (!data || data.state !== "disconnected") return;
        if (!this.shouldWake("disconnect")) return;
        await this.#wake(
          "disconnect",
          `【游戏内事件】你和 Minecraft 服务器的连接断开了${data.reason ? `（${data.reason}）` : ""}。`,
        );
        break;
      }

      case "status": {
        // 低血只在跨过阈值那一刻叫一次，不是每次状态推送都叫
        const health = Number(data && data.health);
        if (!Number.isFinite(health)) return;
        const threshold = Number(this.getSettings().lowHealthThreshold) || 6;
        if (health > threshold || health <= 0) return;
        if (!this.shouldWake("low_health")) return;
        await this.#wake(
          "low_health",
          `【游戏内事件】你的血量只剩 ${Math.round(health)}/20。先吃点东西或者找个安全的地方吧。`,
        );
        break;
      }

      default:
        break;
    }
  }

  /* --------------------------- 出站 --------------------------- */

  /**
   * 把统一消息的文本部分拆行发到游戏里。
   *
   * 为什么要拆行：原版聊天单条上限 256 字符，长回复会被服务器直接拒。
   * 为什么要有间隔：连续刷屏会被服务器的反刷屏机制踢掉。
   */
  async send(message) {
    const status = this.bridge.status();
    if (status.state !== "connected") {
      return { ok: false, error: "机器人未连接服务器" };
    }

    const parts = Array.isArray(message && message.parts) ? message.parts : [];
    const text = parts
      .filter((p) => p && p.kind === "text" && typeof p.text === "string")
      .map((p) => String(p.text))
      .join("\n");

    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .map((line) => (line.length > GAME_CHAT_LINE_LIMIT ? line.slice(0, GAME_CHAT_LINE_LIMIT) : line))
      .filter((line) => line.length > 0);

    if (lines.length === 0) return { ok: true, sent: 0 };

    try {
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, LINE_SEND_INTERVAL_MS));
        await this.bridge.request("say", { message: lines[i] }, "default");
      }
      return { ok: true, sent: lines.length };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  getStatus() {
    const status = this.bridge.status();
    const settings = this.getSettings();

    if (status.state === "connected") {
      return {
        enabled: true,
        phase: "running",
        message:
          `已连接 ${status.host}:${status.port}（${status.username}）` +
          (settings.wakeEnabled ? " · 唤醒已开" : " · 唤醒关闭"),
      };
    }
    if (status.state === "starting" || status.state === "connecting") {
      return { enabled: true, phase: "starting", message: "正在连接服务器" };
    }
    return {
      enabled: true,
      phase: "offline",
      message: "机器人未连接，用 connect 工具接入服务器后频道自动生效",
    };
  }
}

module.exports = {
  MinecraftChannelAdapter,
  DEFAULT_MENTION_PATTERNS,
  WAKE_POLICY,
  GAME_CHAT_LINE_LIMIT,
};
