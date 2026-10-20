"use strict";

/**
 * bot-runtime —— 机器人子进程入口。
 *
 * 独立于 Cyrene 宿主运行（ELECTRON_RUN_AS_NODE 下就是个普通 node 进程），
 * 只通过 stdin/stdout 的 JSON 行协议和宿主说话。这样它可以单独重启、单独调试。
 *
 * 环境变量：
 *   CYRENE_CRAFT_NODE_MODULES  mineflayer 所在的 node_modules 目录
 *   CYRENE_CRAFT_DATA          插件私有数据目录
 *
 * 设计约束：
 *   - 任何命令都必须能返回：长任务全部带 AbortSignal 风格的中断标记
 *   - 任何异常都不能让进程崩：顶层 uncaughtException 只记录不退出
 *   - 不向 stdout 写任何非协议内容（日志一律走 stderr）
 */

const path = require("node:path");
const { Instincts } = require("./instincts.cjs");
const terrainLib = require("./terrain.cjs");
const blockValue = require("./block-value.cjs");

/* ---------------------------- 依赖加载 ---------------------------- */

/**
 * 从指定 node_modules 目录加载 mineflayer。
 *
 * 为什么不用普通 require("mineflayer")：
 * 插件目录和运行时目录是两个地方，Node 默认的解析链找不到它。
 * 直接拼绝对路径 require 最稳，也顺便验证了目录确实可用。
 */
function loadMineflayer(nodeModulesDir) {
  const candidates = [];

  if (nodeModulesDir) candidates.push(path.join(nodeModulesDir, "mineflayer"));
  candidates.push("mineflayer");

  let lastError = null;
  for (const target of candidates) {
    try {
      const mod = require(target);
      // mineflayer 的导出形态在不同版本略有差异，统一兜一下
      const createBot = mod.createBot || (mod.default && mod.default.createBot) || mod;
      if (typeof createBot === "function") return { createBot, resolvedFrom: target };
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(
    `无法加载 mineflayer（尝试过：${candidates.join(" / ")}）：${lastError ? lastError.message : "未知错误"}`,
  );
}

/* ---------------------------- 输出通道 ---------------------------- */

/**
 * Windows 上 process.stdout.write(string) 会按控制台 OEM 代码页编码。
 * 本机 chcp 是 437，中文会被压成 ?，行协议里的错误信息就成了乱码。
 *
 * 解法：自己把字符串编成 UTF-8 Buffer 再写，绕开代码页。
 * 下游 bridge 读的是 setEncoding("utf8")，正好对上。
 */
function writeUtf8Line(stream, text) {
  try {
    stream.write(Buffer.from(text + "\n", "utf8"));
  } catch {
    /* 管道已关闭时写失败不应崩掉子进程 */
  }
}

function send(message) {
  writeUtf8Line(process.stdout, JSON.stringify(message));
}

function sendEvent(event, data) {
  send({ event, data });
}

function log(text) {
  // 子进程日志必须走 stderr，否则会污染行协议
  writeUtf8Line(process.stderr, String(text));
}

/* ---------------------------- 主状态 ---------------------------- */

const state = {
  bot: null,
  connecting: false,
  connected: false,
  mineflayer: null,
  opts: null,
  lastError: null,
  currentTask: null,
  /** 中断标记：长任务轮询它，stop 命令置位 */
  abortFlag: false,
  /** 状态推送定时器 */
  pushTimer: null,
  /** 上次血量，用于检测掉血事件 */
  lastHealth: 20,
  /** 最近一次伤害的来源分类（摔落/饥饿/实体…），供状态与提示词读取 */
  lastDamage: null,
  /** 掉落物/攻击等事件 */
  pendingEvents: [],
  /** 本能反射层实例（连接后创建） */
  instincts: null,
  /** 本能层开关与阈值（可由 set_instincts 命令调整） */
  instinctConfig: {
    enabled: true,
    lowHealth: 12,
    hungryFood: 14,
    tickMs: 800,
  },
};

/* ---------------------------- 工具函数 ---------------------------- */

function getNodeModulesDir() {
  return process.env.CYRENE_CRAFT_NODE_MODULES || null;
}

function nowMs() {
  return Date.now();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/* ---------------------------- 伤害来源分类 ---------------------------- */

/** 掉血少于这个值就不上报，避免自然掉血刷屏 */
const MIN_DAMAGE_TO_REPORT = 1;

/**
 * damage_event 包只给 sourceTypeId 数字，注册表里查不到名字。
 * 所以按 MC 的伤害类型注册表顺序硬编码。1.20 ~ 1.21.4 这一段顺序稳定；
 * 版本变了就对不上——所以查不到时一律按 unknown 处理，不冒充攻击。
 *
 * 顺序来源：Minecraft 1.21 的 damage_type 注册表。
 */
const DAMAGE_TYPES = [
  "in_fire", "lightning_bolt", "on_fire", "lava", "hot_floor",
  "in_wall", "cramming", "drown", "starve", "cactus",
  "fall", "fly_into_wall", "out_of_world", "generic", "magic",
  "wither", "dragon_breath", "dry_out", "sweet_berry_bush", "freeze",
  "stalagmite", "falling_block", "falling_anvil", "falling_stalactite", "sting",
  "mob_attack", "mob_attack_no_aggro", "player_attack", "arrow", "trident",
  "mob_projectile", "spit", "fireworks", "fireball", "unattributed_fireball",
  "wind_charge", "thrown", "indirect_magic", "thorns", "explosion",
  "player_explosion", "sonic_boom", "bad_respawn_point", "outside_border",
  "generic_kill", "campfire",
];

/**
 * 伤害类型 → 分类。
 *
 * 分成三类，用途不同：
 *   entity    有实体打你 —— 该唤醒、该逃、该反击
 *   environment 世界规则伤你 —— 只记录，不打断任务
 *   unknown   查不出来 —— 保守处理，不冒充攻击
 */
const DAMAGE_KIND = {
  mob_attack: "entity",
  mob_attack_no_aggro: "entity",
  player_attack: "entity",
  arrow: "entity",
  trident: "entity",
  mob_projectile: "entity",
  spit: "entity",
  fireworks: "entity",
  fireball: "entity",
  unattributed_fireball: "entity",
  wind_charge: "entity",
  thrown: "entity",
  indirect_magic: "entity",
  thorns: "entity",
  sting: "entity",

  explosion: "environment",
  player_explosion: "environment",
  sonic_boom: "environment",

  fall: "environment",
  fly_into_wall: "environment",
  in_wall: "environment",
  cramming: "environment",
  drown: "environment",
  starve: "environment",
  cactus: "environment",
  in_fire: "environment",
  on_fire: "environment",
  lava: "environment",
  hot_floor: "environment",
  freeze: "environment",
  lightning_bolt: "environment",
  falling_block: "environment",
  falling_anvil: "environment",
  falling_stalactite: "environment",
  sweet_berry_bush: "environment",
  stalagmite: "environment",
  dry_out: "environment",
  magic: "environment",
  wither: "environment",
  dragon_breath: "environment",
  bad_respawn_point: "environment",
  outside_border: "environment",
  generic: "environment",
  generic_kill: "environment",
  out_of_world: "environment",
  campfire: "environment",
};

/** 给模型看的中文说明，要说清楚「是什么伤了你」 */
const DAMAGE_LABEL = {
  entity: "被实体攻击",
  environment: "环境伤害",
  unknown: "来源不明",
};

/** 具体伤害类型 → 中文，提示词里用 */
const DAMAGE_TYPE_LABEL = {
  fall: "摔落",
  fly_into_wall: "撞墙",
  in_wall: "卡在方块里",
  cramming: "被挤",
  drown: "溺水",
  starve: "饥饿",
  cactus: "仙人掌",
  in_fire: "着火",
  on_fire: "被烧",
  lava: "岩浆",
  hot_floor: "踩到热方块",
  freeze: "冰冻",
  lightning_bolt: "雷击",
  falling_block: "被掉落方块砸",
  falling_anvil: "被铁砧砸",
  falling_stalactite: "被钟乳石砸",
  sweet_berry_bush: "甜浆果丛",
  stalagmite: "石笋",
  magic: "魔法伤害",
  wither: "凋零",
  dragon_breath: "龙息",
  sonic_boom: "音爆",
  explosion: "爆炸",
  player_explosion: "玩家引发的爆炸",
  mob_attack: "生物近战",
  mob_attack_no_aggro: "生物近战",
  player_attack: "玩家攻击",
  arrow: "箭",
  trident: "三叉戟",
  mob_projectile: "生物投掷物",
  spit: "羊驼唾沫",
  fireball: "火球",
  wind_charge: "风弹",
  thorns: "荆棘反伤",
  sting: "蜜蜂蛰",
};

/**
 * 伤害来源追踪器。
 *
 * 为什么要缓冲：damage_event 包和 update_health 包几乎是同时到，
 * 但不保证 health 回调先执行。所以收到包先记进队列，等 health 掉血时
 * 再从队列里取一条最近的来对账。
 */
function createDamageTracker(opts = {}) {
  const ttl = Number(opts.ttlMs) || 1500;
  const pending = [];
  const maxPending = 8;

  return {
    /** 收到原始 damage_event 包时调用 */
    notePacket(packet) {
      if (!packet) return;
      const id = Number(packet.sourceTypeId);
      const type = Number.isInteger(id) && id >= 0 ? DAMAGE_TYPES[id] || null : null;

      pending.push({
        sourceTypeId: Number.isFinite(id) ? id : null,
        type,
        sourceCauseId: Number(packet.sourceCauseId) || 0,
        sourceDirectId: Number(packet.sourceDirectId) || 0,
        at: Date.now(),
      });
      if (pending.length > maxPending) pending.shift();
    },

    /** 取一条最近的、还没过期的记录（取完就删） */
    takeRecent() {
      const now = Date.now();
      while (pending.length) {
        const item = pending[pending.length - 1];
        if (now - item.at <= ttl) {
          pending.pop();
          return item;
        }
        pending.pop();
      }
      return null;
    },

    /** 当前缓冲里的条数（调试用） */
    size() {
      return pending.length;
    },

    /** 清空缓冲（重连时用） */
    reset() {
      pending.length = 0;
    },

    /**
     * 把这次掉血归到一个来源。
     *
     * 优先级：
     *   1. 有 damage_event → 用它的类型
     *   2. 没有包但确实在高速下落 → 判摔落（物理推断，标 inferred）
     *   3. 都没有 → unknown
     *
     * @param {number} drop 掉了多少血
     * @param {object} bot
     * @returns {{kind:string, reason:string|null, label:string, inferred:boolean, attacker:object|null}}
     */
    resolve(drop, bot) {
      const hit = this.takeRecent();

      if (hit && hit.type) {
        const kind = DAMAGE_KIND[hit.type] || "unknown";
        const label = DAMAGE_TYPE_LABEL[hit.type] || DAMAGE_LABEL[kind];

        // 实体伤害尽量把攻击者指出来，好让调用方知道是谁
        let attacker = null;
        if (kind === "entity" && hit.sourceCauseId > 0 && bot && bot.entities) {
          const e = bot.entities[hit.sourceCauseId];
          if (e) {
            attacker = {
              id: e.id,
              name: e.name || e.username || null,
              type: e.type || null,
                            distance: e.position && bot.entity ? Math.round(e.position.distanceTo(bot.entity.position) * 10) / 10 : null,
            };
          }
        }

        return { kind, reason: hit.type, label, inferred: false, attacker };
      }

      // 没有伤害包时的兜底：
      //   1. 正在快速下落 → 摔落
      //   2. 附近有敌对生物 → 大概率中招了，按实体伤害处理
      const vy = bot && bot.entity && bot.entity.velocity ? bot.entity.velocity.y : 0;
      if (Number.isFinite(vy) && vy < -0.7) {
        return {
          kind: "environment",
          reason: "fall",
          label: DAMAGE_TYPE_LABEL.fall,
          inferred: true,
          attacker: null,
        };
      }

      // 没有包但旁边确实有能打人的东西，别漏判
      const near = nearbyHostile(bot);
      if (near) {
        return {
          kind: "entity",
          reason: near.name ? "mob_attack" : null,
          label: DAMAGE_TYPE_LABEL.mob_attack,
          inferred: true,
          attacker: near,
        };
      }

      return {
        kind: "unknown",
        reason: hit ? hit.type : null,
        label: DAMAGE_LABEL.unknown,
        inferred: false,
        attacker: null,
      };
    },
  };
}

/**
 * 找最近的敌对生物。只用于「没有伤害包时」的兜底判断，
 * 所以限制得很紧：必须有敌对生物名单命中、活着、且在 8 格内。
 */
function nearbyHostile(bot) {
  if (!bot || !bot.entities || !bot.entity || !bot.entity.position) return null;

  const HOSTILE_NAMES = new Set([
    "zombie", "husk", "drowned", "skeleton", "stray", "creeper", "spider",
    "cave_spider", "witch", "pillager", "vindicator", "evoker", "ravager",
    "blaze", "ghast", "magma_cube", "slime", "phantom", "warden", "piglin_brute",
    "zombified_piglin", "wither_skeleton", "silverfish", "endermite", "guardian",
    "elder_guardian", "shulker", "vex", "hoglin", "zoglin",
  ]);

  let best = null;
  let bestDist = Infinity;

  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!e || e === bot.entity || !e.position) continue;
    if (e.type !== "mob") continue;
    if (typeof e.health === "number" && e.health <= 0) continue;
    if (!HOSTILE_NAMES.has(e.name)) continue;

    const d = e.position.distanceTo(bot.entity.position);
    if (d <= 8 && d < bestDist) {
      bestDist = d;
      best = {
        id: e.id,
        name: e.name || null,
        type: e.type || null,
        distance: Math.round(d * 10) / 10,
      };
    }
  }

  return best;
}

/** 等一会儿；signal 是简单的中断标记对象（{aborted:boolean}） */
function delay(ms, signal) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if ((signal && signal.aborted) || Date.now() - start >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, Math.min(100, Math.max(16, ms)));
    if (timer.unref) timer.unref();
  });
}

/** 中断检查：长任务里循环调用 */
function assertNotAborted() {
  if (state.abortFlag) throw new Error("任务已被停止");
}

/** 把 mineflayer 的 Item/Block 等对象整理成纯数据，避免序列化环 */
function itemSummary(item) {
  if (!item) return null;
  return {
    name: item.name,
    displayName: item.displayName,
    count: item.count,
    slot: item.slot,
  };
}

function vecSummary(vec) {
  if (!vec) return null;
  return {
    x: Math.round(vec.x * 100) / 100,
    y: Math.round(vec.y * 100) / 100,
    z: Math.round(vec.z * 100) / 100,
  };
}

/**
 * 造一个真正的 Vec3。
 *
 * mineflayer 的 blockAt / placeBlock 内部会调 Vec3 的方法（offset、equals、distanceTo），
 * 传普通 {x,y,z} 字面量迟早会炸在某一行上。所以统一从这里造。
 */
function vec(x, y, z) {
  const Vec3 = requireFromRuntime("vec3");
  return new Vec3(x, y, z);
}

/* ---------------------------- 状态快照 ---------------------------- */

function buildStatus() {
  const bot = state.bot;
  if (!bot || !state.connected) {
    return {
      online: false,
      state: state.connected ? "connecting" : "disconnected",
      connection: state.opts ? { host: state.opts.host, port: state.opts.port } : null,
      lastError: state.lastError,
    };
  }

  const inventory = [];
  for (const item of bot.inventory.items()) {
    inventory.push({ name: item.name, count: item.count, slot: item.slot });
  }

  const players = [];
  for (const name of Object.keys(bot.players || {})) {
    const p = bot.players[name];
    players.push({
      username: name,
      isSelf: name === bot.username,
      position: p && p.entity ? vecSummary(p.entity.position) : null,
    });
  }

  // 本能层最近做了什么：让模型知道它刚才自己跑过/吃过，
  // 否则模型会以为自己一直站着没动，重复下令。prompt.cjs 依赖这三个字段。
  const inst = state.instincts ? state.instincts.snapshot() : null;
  const lastActionAt = inst && inst.lastActionAt ? inst.lastActionAt : null;

  return {
    online: true,
    state: "connected",
    connection: state.opts ? { host: state.opts.host, port: state.opts.port } : null,
    username: bot.username,
    position: vecSummary(bot.entity && bot.entity.position),
    health: Math.round(bot.health || 0),
    food: Math.round(bot.food || 0),
    // 氧气只在水中变化；给自主驱动的闸门用，陆地上是 20
    oxygen: typeof bot.oxygenLevel === "number" ? bot.oxygenLevel : null,
    gameMode: bot.game ? bot.game.gameMode : null,
    dimension: bot.game ? bot.game.dimension : null,
    time: bot.time ? { timeOfDay: bot.time.timeOfDay, isDay: bot.time.isDay } : null,
    inventory,
    players,
    currentTask: state.currentTask,
    instinctLastAction: inst ? inst.lastAction : null,
    instinctActionAgeMs: lastActionAt ? Math.max(0, Date.now() - lastActionAt) : null,
    instinctsRunning: Boolean(state.instincts),
    // 最近一次伤害的来源分类：摔落/饥饿/被实体打，各自含义不同，别混为一谈
    lastDamage: state.lastDamage,
    lastError: state.lastError,
  };
}

/** 定期把状态推给宿主，UI 就不用每次都打一次请求 */
function startStatusPush() {
  stopStatusPush();
  state.pushTimer = setInterval(() => {
    if (!state.connected) return;
    try {
      sendEvent("status", buildStatus());
    } catch (e) {
      log(`状态推送失败：${e.message}`);
    }
  }, 3000);
  // 不要让定时器拖住进程退出
  if (state.pushTimer.unref) state.pushTimer.unref();
}

function stopStatusPush() {
  if (state.pushTimer) {
    clearInterval(state.pushTimer);
    state.pushTimer = null;
  }
}

/* ---------------------------- 寻路插件 ---------------------------- */

/**
 * 加载 mineflayer-pathfinder，并配好 movements。
 *
 * 没有它就只能直线接近（naiveWalk），过不了墙、上不了台阶。
 * 但有它也不是无条件的：如果运行时里没装这个包，不能因此让连接失败，
 * 只是相关工具会在调用时给出明确提示。
 *
 * ── 为什么要配 movements ──────────────────────────────────────────
 * mineflayer-pathfinder 的默认配置里 canDig = false：路径上有方块挡着，
 * 它宁可判定「不可达」也不去挖。实跑时就卡在这里 —— 那片藤蔓把通往
 * 原木的路裹住了，goto 连试三次都超时，报「走不到目标」。
 * 藤蔓本来就能攀，可默认不挖不爬，A* 里这棵树就是过不去。
 */
function loadPathfinder(bot) {
  if (state.pathfinderLoaded) return true;
  try {
    const mod = requireFromRuntime("mineflayer-pathfinder");
    bot.loadPlugin(mod.pathfinder);
    state.pathfinderLoaded = true;

    // movements 依赖 bot.registry，spawn 之后才稳
    const applyMovements = () => {
      try {
        const { Movements } = mod;
        const movements = new Movements(bot);

        // 允许挖掉挡路的方块。digCost 给高一点：优先绕路，绕不过才动手。
        movements.canDig = true;
        movements.digCost = 10;

        // 藤蔓、梯子这类攀爬方块放行
        if ("canClimb" in movements) movements.canClimb = true;
        movements.canOpenDoors = true;

        // 不走「自己搭方块往上叠」那套，太容易搞出奇怪的柱子
        movements.allow1by1towers = false;

        bot.pathfinder.setMovements(movements);
        log("寻路配置已应用：允许挖挡路方块、允许攀爬");
      } catch (e) {
        log(`寻路配置失败（退回默认配置）：${e.message}`);
      }
    };

    if (bot.entity) applyMovements();
    else bot.once("spawn", applyMovements);

    log("mineflayer-pathfinder 已加载");
    return true;
  } catch (e) {
    log(`mineflayer-pathfinder 不可用（自动寻路会降级为直线接近）：${e.message}`);
    return false;
  }
}

/** 等 pathfinder 挂上去；插件是异步 load 的，刚连接时可能还没有 */
function requirePathfinder(bot) {
  if (!bot.pathfinder) {
    throw new Error("自动寻路不可用（运行时缺少 mineflayer-pathfinder）");
  }
  return bot.pathfinder;
}

/* ---------------------------- 本能反射层 ---------------------------- */

/** 连接成功后挂上本能层 */
function startInstincts(bot) {
  stopInstincts();

  const inst = new Instincts({
    bot,
    emit: (event, data) => sendEvent(event, data),
    // 正在跑任务时，本能层只做保命动作，不插嘴捡东西/点火把
    getTask: () => state.currentTask,
    log: (msg) => log(msg),
    config: state.instinctConfig,
  });

  state.instincts = inst;
  inst.start();
}

function stopInstincts() {
  if (state.instincts) {
    try {
      state.instincts.stop();
    } catch {
      /* ignore */
    }
    state.instincts = null;
  }
}

/** 运行期调整本能层参数 */
function doSetInstincts(args) {
  const cfg = state.instinctConfig;

  if (typeof args.enabled === "boolean") cfg.enabled = args.enabled;
  if (Number.isFinite(Number(args.lowHealth))) cfg.lowHealth = Math.max(1, Math.min(19, Number(args.lowHealth)));
  if (Number.isFinite(Number(args.hungryFood))) cfg.hungryFood = Math.max(1, Math.min(19, Number(args.hungryFood)));
  if (Number.isFinite(Number(args.tickMs))) cfg.tickMs = Math.max(200, Math.min(5000, Number(args.tickMs)));

  // 重新挂一次让新参数生效
  if (state.bot && state.connected) {
    if (cfg.enabled) startInstincts(state.bot);
    else stopInstincts();
  }

  return {
    ...cfg,
    running: Boolean(state.instincts),
    lastAction: state.instincts ? state.instincts.snapshot().lastAction : null,
  };
}

/* ---------------------------- 连接 ---------------------------- */

async function doConnect(args) {
  if (!state.mineflayer) {
    const loaded = loadMineflayer(getNodeModulesDir());
    state.mineflayer = loaded.createBot;
    log(`mineflayer 已从 ${loaded.resolvedFrom} 加载`);
  }

  if (state.bot) {
    try {
      state.bot.quit();
    } catch {
      /* 旧连接可能已经断了 */
    }
    state.bot = null;
  }

  state.connected = false;
  state.connecting = true;
  state.lastError = null;
  state.opts = {
    host: args.host,
    port: Number(args.port) || 25565,
    username: args.username || "Cyrene",
  };

  sendEvent("state", { state: "connecting", host: state.opts.host, port: state.opts.port });

  const options = {
    host: state.opts.host,
    port: state.opts.port,
    username: state.opts.username,
    // 离线模式：不登录 Mojang，服务器需要 online-mode=false
    auth: args.auth || "offline",
  };
  if (args.version) options.version = args.version;
  if (args.password) options.password = args.password;

  const bot = state.mineflayer(options);
  state.bot = bot;
  wireBotEvents(bot);
  loadPathfinder(bot);

  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      state.connecting = false;
      state.lastError = "连接超时（60 秒内没有完成登录握手）";
      try {
        bot.quit();
      } catch {
        /* ignore */
      }
      reject(new Error(state.lastError));
    }, 60_000);

    bot.once("spawn", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.connecting = false;
      state.connected = true;
      state.lastHealth = bot.health;
      sendEvent("state", { state: "connected" });
      startStatusPush();
      startInstincts(bot);

      // 等区块加载完再返回，否则 AI 立刻查地图会拿到空白
      waitForChunks(bot, 30_000)
        .then(() => resolve(buildStatus()))
        .catch(() => resolve(buildStatus()));
    });

    bot.once("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.connecting = false;
      state.lastError = e && e.message ? e.message : String(e);
      sendEvent("state", { state: "disconnected", reason: state.lastError });
      reject(new Error(state.lastError));
    });

    bot.once("end", (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.connecting = false;
      state.lastError = `连接被服务器关闭：${reason || "未知原因"}`;
      sendEvent("state", { state: "disconnected", reason: state.lastError });
      reject(new Error(state.lastError));
    });
  });
}

/** 等区块加载：mineflayer 有 waitForChunksToLoad，但没有就自己轮询 */
function waitForChunks(bot, timeoutMs) {
  return new Promise((resolve) => {
    if (typeof bot.waitForChunksToLoad === "function") {
      const timer = setTimeout(resolve, timeoutMs);
      bot
        .waitForChunksToLoad()
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch(() => {
          clearTimeout(timer);
          resolve();
        });
      return;
    }
    // 降级：等 2 秒，让区块有机会到
    setTimeout(resolve, 2000);
  });
}

function wireBotEvents(bot) {
  bot.on("chat", (username, message, translate, jsonMsg, matches) => {
    // 自己的发言不再回声给上游，否则会造成自问自答
    if (username === bot.username) return;
    sendEvent("chat", {
      player: username,
      message,
      matches: matches || null,
      at: nowMs(),
    });
  });

  bot.on("message", (jsonMsg, position) => {
    // 系统消息（加入/退出/服务器公告）
    const text = jsonMsg && jsonMsg.toString ? jsonMsg.toString() : String(jsonMsg);
    if (!text) return;
    if (position === "game_info") return; // 动作栏文字太吵，丢掉
    sendEvent("system", { message: text, position: position || "chat", at: nowMs() });
  });

  /* ---- 伤害来源分类 ----
   *
   * 之前只看血量掉了多少：掉 2 点以上就发 hurt，宿主收到就唤醒一轮对话。
   * 问题是摔落、饿、岩浆、窒息全都算「被攻击」，砍树时从树顶掉下来
   * 就会把正在跑的技能打断。
   *
   * 现在改成看伤害来源：只有「实体造成的伤害」才算被攻击。
   * 数据来自 damage_event 包（1.20+）的 sourceTypeId。
   */
  const dmg = createDamageTracker();

  bot._client.on("damage_event", (packet) => {
    dmg.notePacket(packet);
  });

  bot.on("health", () => {
    if (!bot.entity) return;
    const health = bot.health;
    const drop = state.lastHealth - health;
    state.lastHealth = health;

    if (drop < MIN_DAMAGE_TO_REPORT) return;

    // 查这次掉血对应的伤害来源。查不到就按未知处理，不冒充攻击。
    const origin = dmg.resolve(drop, bot);
    state.lastDamage = {
      origin: origin.kind,
      reason: origin.reason,
      amount: drop,
      at: Date.now(),
    };

    sendEvent("damage", {
      from: health + drop,
      to: health,
      amount: drop,
      origin: origin.kind,
      reason: origin.reason,
      attacker: origin.attacker || null,
      by: bot.entity && bot.entity.position ? vecSummary(bot.entity.position) : null,
    });

    // 只有「实体造成的伤害」才广播 hurt，触发唤醒。
    // 摔落/饥饿/环境伤害只记录，不打断正在进行的任务。
    if (origin.kind === "entity") {
      sendEvent("hurt", {
        from: health + drop,
        to: health,
        amount: drop,
        origin: origin.kind,
        reason: origin.reason,
        attacker: origin.attacker || null,
        by: bot.entity && bot.entity.position ? vecSummary(bot.entity.position) : null,
      });
    }
  });

  bot.on("death", () => {
    sendEvent("death", { position: vecSummary(bot.entity && bot.entity.position) });
    state.currentTask = null;
    sendEvent("task", { label: null });
  });

  bot.on("kicked", (reason) => {
    const text = reason && reason.toString ? reason.toString() : String(reason);
    state.lastError = `被服务器踢出：${text}`;
    sendEvent("error", { message: state.lastError });
  });

  bot.on("end", (reason) => {
    state.connected = false;
    stopStatusPush();
    sendEvent("state", { state: "disconnected", reason: reason || null });
  });

  bot.on("error", (e) => {
    state.lastError = e && e.message ? e.message : String(e);
    sendEvent("error", { message: state.lastError });
  });

  // 掉落物拾取、实体变化之类不逐条推，避免刷屏
}

async function doDisconnect() {
  state.abortFlag = true;
  stopStatusPush();
  stopInstincts();
  if (state.bot) {
    try {
      state.bot.quit();
    } catch {
      /* 已经断了 */
    }
  }
  state.bot = null;
  state.connected = false;
  state.currentTask = null;
  sendEvent("state", { state: "disconnected" });
  return { ok: true };
}

/* ---------------------------- 查询类 ---------------------------- */

function requireBot() {
  if (!state.bot || !state.connected) {
    throw new Error("尚未连接服务器，请先调用 connect 工具");
  }
  return state.bot;
}

async function doStatus() {
  return buildStatus();
}

async function doInventory() {
  const bot = requireBot();
  const items = bot.inventory.items().map(itemSummary);
  const held = bot.heldItem ? itemSummary(bot.heldItem) : null;
  return {
    count: items.length,
    held,
    items,
    emptySlots: bot.inventory.emptySlotCount ? bot.inventory.emptySlotCount() : null,
  };
}

async function doPlayers() {
  const bot = requireBot();
  const list = [];
  for (const name of Object.keys(bot.players || {})) {
    const p = bot.players[name];
    list.push({
      username: name,
      isSelf: name === bot.username,
      ping: p && typeof p.ping === "number" ? p.ping : null,
      position: p && p.entity ? vecSummary(p.entity.position) : null,
    });
  }
  return { count: list.length, players: list };
}

async function doEntities(args) {
  const bot = requireBot();
  const radius = clamp(Number(args.radius) || 16, 1, 64);
  const kinds = args.kind ? String(args.kind).toLowerCase() : null;
  const list = [];

  for (const id of Object.keys(bot.entities || {})) {
    const e = bot.entities[id];
    if (!e || e === bot.entity) continue;
    if (!e.position) continue;

    const dist = e.position.distanceTo(bot.entity.position);
    if (dist > radius) continue;

    const kind = e.type === "player" ? "player" : e.type === "mob" ? "mob" : e.type === "object" ? "object" : "other";
    if (kinds && kinds !== "all" && kind !== kinds) continue;

    list.push({
      id: e.id,
      name: e.name || e.username || e.displayName || String(e.type),
      type: kind,
      username: e.username || null,
      position: vecSummary(e.position),
      distance: Math.round(dist * 10) / 10,
      health: typeof e.health === "number" ? e.health : null,
    });
  }

  list.sort((a, b) => a.distance - b.distance);
  return { count: list.length, radius, entities: list.slice(0, 60) };
}

async function doScan(args) {
  const bot = requireBot();
  const mcData = requireFromRuntime("minecraft-data")(bot.version);
  const name = String(args.block || "").trim();
  if (!name) throw new Error("block 参数不能为空（方块 id，如 oak_log / iron_ore）");

  const blockInfo = mcData.blocksByName[name];
  if (!blockInfo) throw new Error(`不认识的方块 id：${name}`);

  const radius = clamp(Number(args.radius) || 32, 1, 128);
  const limit = clamp(Number(args.limit) || 20, 1, 100);

  const found = bot.findBlocks({
    matching: blockInfo.id,
    maxDistance: radius,
    count: limit,
  });

  const origin = bot.entity.position;
  const blocks = found.map((pos) => ({
    x: pos.x,
    y: pos.y,
    z: pos.z,
    distance: Math.round(origin.distanceTo(pos) * 10) / 10,
  }));
  blocks.sort((a, b) => a.distance - b.distance);

  return { block: name, count: blocks.length, radius, blocks };
}

/** 从运行时目录 require 一个 mineflayer 的同伴包（minecraft-data 等） */
function requireFromRuntime(name) {
  const dir = getNodeModulesDir();
  const candidates = [];
  if (dir) candidates.push(path.join(dir, name));
  candidates.push(name);
  let lastError = null;
  for (const target of candidates) {
    try {
      return require(target);
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`无法加载 ${name}：${lastError ? lastError.message : "未知错误"}`);
}

async function doContext(args) {
  const bot = requireBot();
  const survival = args.survival !== false;

  const ctx = {
    online: true,
    username: bot.username,
    position: vecSummary(bot.entity.position),
    health: Math.round(bot.health || 0),
    food: Math.round(bot.food || 0),
    dimension: bot.game ? bot.game.dimension : null,
    time: bot.time ? { timeOfDay: bot.time.timeOfDay, isDay: bot.time.isDay } : null,
  };

  if (survival) {
    // 只有在意生存时才查这些东西，平时省点开销
    ctx.blockBelow = blockNameAt(bot, bot.entity.position.offset(0, -1, 0));
    ctx.light = lightAt(bot, bot.entity.position);
    ctx.heldItem = bot.heldItem ? itemSummary(bot.heldItem) : null;
    ctx.inventorySize = bot.inventory.items().length;
  }

  return ctx;
}

function blockNameAt(bot, pos) {
  try {
    const block = bot.blockAt(pos);
    return block ? block.name : null;
  } catch {
    return null;
  }
}
function lightAt(bot, pos) {
  try {
    const block = bot.blockAt(pos);
    return block && typeof block.light === "number" ? block.light : null;
  } catch {
    return null;
  }
}

/* ---------------------------- 移动 ---------------------------- */

/** 寻路移动：优先用 pathfinder 插件，没有就退化成直接 setControlState */
async function doMove(args) {
  const bot = requireBot();
  state.currentTask = args.player ? `走向玩家 ${args.player}` : `走向坐标`;
  sendEvent("task", { label: state.currentTask });

  try {
    const target = resolveMoveTarget(bot, args);
    if (!target) throw new Error("move 需要 x/y/z 坐标，或者 player 参数");

    if (!bot.pathfinder) {
      // 没有寻路插件：直线靠近，够用但会卡障碍
      return await naiveWalk(bot, target);
    }

    const { goals } = requireFromRuntime("mineflayer-pathfinder");
    const goal = args.player
      ? new goals.GoalFollow(bot.entities[findPlayerEntityId(bot, args.player)], 2)
      : new goals.GoalBlock(target.x, target.y, target.z);

    await bot.pathfinder.goto(goal);
    return {
      ok: true,
      position: vecSummary(bot.entity.position),
      distance: Math.round(bot.entity.position.distanceTo(target) * 10) / 10,
    };
  } finally {
    state.currentTask = null;
    sendEvent("task", { label: null });
  }
}

function resolveMoveTarget(bot, args) {
  if (args.x !== undefined && args.y !== undefined && args.z !== undefined) {
    return { x: Number(args.x), y: Number(args.y), z: Number(args.z) };
  }
  if (args.player) {
    const player = bot.players[String(args.player)];
    if (player && player.entity) return player.entity.position;
    throw new Error(`找不到玩家 ${args.player}（可能不在附近或不在线）`);
  }
  return null;
}

function findPlayerEntityId(bot, username) {
  const p = bot.players[username];
  if (!p || !p.entity) throw new Error(`找不到玩家 ${username} 的实体`);
  return p.entity.id;
}

/** 没有 pathfinder 时的降级移动：朝目标方向平推，带防卡死 */
async function naiveWalk(bot, target) {
  const start = bot.entity.position.clone();
  const deadline = Date.now() + 60_000;
  let stuckAt = null;
  let stuckSince = 0;

  while (Date.now() < deadline) {
    assertNotAborted();
    const dist = bot.entity.position.distanceTo(target);
    if (dist < 2) {
      bot.clearControlStates();
      return { ok: true, position: vecSummary(bot.entity.position), naive: true };
    }

    // 卡住检测：位置几乎没变超过 3 秒就跳一下
    if (stuckAt && bot.entity.position.distanceTo(stuckAt) < 0.5) {
      if (Date.now() - stuckSince > 3000) {
        bot.setControlState("jump", true);
        setTimeout(() => bot.setControlState("jump", false), 300);
        stuckSince = Date.now();
      }
    } else {
      stuckAt = bot.entity.position.clone();
      stuckSince = Date.now();
    }

    const dx = target.x - bot.entity.position.x;
    const dz = target.z - bot.entity.position.z;
    const yaw = Math.atan2(-dx, -dz);
    bot.look(yaw, 0, true).catch(() => {});

    bot.setControlState("forward", true);
    await delay(250);
  }

  bot.clearControlStates();
  throw new Error(`直线接近超时（起点 ${JSON.stringify(vecSummary(start))}）`);
}

async function doFollow(args) {
  const bot = requireBot();
  const username = String(args.player || "").trim();
  if (!username) throw new Error("player 参数不能为空");
  if (!bot.pathfinder) throw new Error("跟随需要 mineflayer-pathfinder，运行时不完整");

  const { goals } = requireFromRuntime("mineflayer-pathfinder");
  const entityId = findPlayerEntityId(bot, username);
  const goal = new goals.GoalFollow(bot.entities[entityId], Number(args.distance) || 3);

  state.currentTask = `跟随 ${username}`;
  sendEvent("task", { label: state.currentTask });

  // pathfinder.setGoal 是持续跟随，不阻塞
  bot.pathfinder.setGoal(goal, true);
  return { ok: true, following: username, distance: Number(args.distance) || 3 };
}

async function doStop() {
  state.abortFlag = true;
  const bot = state.bot;
  if (bot) {
    try {
      if (bot.pathfinder) bot.pathfinder.setGoal(null);
      bot.clearControlStates();
      if (bot.stopDigging) bot.stopDigging();
    } catch {
      /* 可能已经断了 */
    }
  }
  state.currentTask = null;
  sendEvent("task", { label: null });
  // 置位后延迟复位，让正在跑的长任务有机会读到
  setTimeout(() => {
    state.abortFlag = false;
  }, 1500);
  return { ok: true, message: "已停止当前动作" };
}

/* ---------------------------- 挖掘 / 放置 ---------------------------- */

const PROTECTED_BLOCKS = new Set([
  "bedrock",
  "barrier",
  "command_block",
  "chain_command_block",
  "repeating_command_block",
  "structure_block",
  "end_portal_frame",
  "jigsaw",
]);

/** 背包快照：name -> count。工具选择与收益统计共用这一份。 */
function inventoryCountMap(bot) {
  const map = new Map();
  for (const it of bot.inventory.items()) {
    map.set(it.name, (map.get(it.name) || 0) + (Number(it.count) || 0));
  }
  return map;
}

/** 背包里正增长的物品；第一个就是主要掉落物。 */
function positiveDeltas(before, after) {
  const out = [];
  for (const [name, count] of after) {
    const gain = count - (before.get(name) || 0);
    if (gain > 0) out.push({ name, count: gain });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

/** 只负责装备调用方指定的工具，不替决策层选工具。 */
async function equipTool(bot, name) {
  const wanted = String(name || "").trim();
  if (!wanted || wanted === "barehand") return null;

  const item = bot.inventory.items().find((it) => it.name === wanted);
  if (!item) throw new Error(`背包里没有工具 ${wanted}`);

  if (!bot.heldItem || bot.heldItem.name !== wanted) {
    await bot.equip(item, "hand");
  }
  return item;
}

/**
 * 当前版本的游戏事实：这个方块需不需要特定工具。
 * 从 minecraft-data 读，不写死方块表；版本更新时自动跟着变。
 */
function harvestRequirement(mcData, blockName, heldItem) {
  const info = mcData.blocksByName[blockName];
  if (!info || !info.harvestTools) return null;

  const ids = Object.keys(info.harvestTools).map(Number);
  const heldId = heldItem ? Number(heldItem.type) : null;
  if (!heldId || !ids.includes(heldId)) {
    return `空手挖 ${blockName} 没有掉落（需要可用工具）`;
  }
  return null;
}

async function doBlockMeta(args) {
  const bot = requireBot();
  const mcData = requireFromRuntime("minecraft-data")(bot.version);
  const name = String(args.block || "").trim();
  if (!name) throw new Error("block 参数不能为空");

  const info = mcData.blocksByName[name];
  if (!info) throw new Error(`未知方块：${name}`);

  const harvestTools = info.harvestTools
    ? Object.keys(info.harvestTools)
        .map(Number)
        .map((id) => (mcData.items[id] && mcData.items[id].name) || String(id))
    : [];

  return {
    ok: true,
    name,
    hardness: Number.isFinite(info.hardness) ? info.hardness : null,
    material: info.material || null,
    harvestTools,
    drops: info.drops || null,
  };
}

async function doDig(args) {
  const bot = requireBot();
  const mcData = requireFromRuntime("minecraft-data")(bot.version);
  const pos = { x: Number(args.x), y: Number(args.y), z: Number(args.z) };
  if (![pos.x, pos.y, pos.z].every(Number.isFinite)) throw new Error("dig 需要有效的 x/y/z 坐标");

  const block = bot.blockAt(vec(pos.x, pos.y, pos.z));
  if (!block) throw new Error(`(${pos.x}, ${pos.y}, ${pos.z}) 没有方块（区块可能未加载）`);
  if (block.name === "air") throw new Error(`(${pos.x}, ${pos.y}, ${pos.z}) 是空气`);
  if (PROTECTED_BLOCKS.has(block.name)) throw new Error(`${block.name} 无法被挖掘`);

  await equipTool(bot, args.tool);
  const held = bot.heldItem;
  const blocked = harvestRequirement(mcData, block.name, held);
  if (blocked) throw new Error(blocked);

  state.currentTask = `挖掘 ${block.name}`;
  sendEvent("task", { label: state.currentTask });

  try {
    const before = inventoryCountMap(bot);
    await bot.dig(block);
    await delay(500);

    const deltas = positiveDeltas(before, inventoryCountMap(bot));
    const gained = deltas.reduce((sum, item) => sum + item.count, 0);
    const drop = deltas.length ? deltas[0].name : null;

    if (gained === 0) {
      throw new Error(`挖掉了 ${block.name}，但没有掉落物（工具或方块状态不对）`);
    }

    return {
      ok: true,
      complete: true,
      block: block.name,
      position: pos,
      tool: held ? held.name : "barehand",
      drop,
      gained,
      handItem: held ? held.name : null,
    };
  } finally {
    state.currentTask = null;
    sendEvent("task", { label: null });
  }
}

async function doPlace(args) {
  const bot = requireBot();
  const pos = { x: Number(args.x), y: Number(args.y), z: Number(args.z) };
  if (![pos.x, pos.y, pos.z].every(Number.isFinite)) throw new Error("place 需要有效的 x/y/z 坐标");

  const blockName = String(args.block || "").trim();
  if (!blockName) throw new Error("block 参数不能为空（要放的方块 id）");

  // 从背包找这个方块
  const item = bot.inventory.items().find((it) => it.name === blockName);
  if (!item) throw new Error(`背包里没有 ${blockName}`);

  await bot.equip(item, "hand");

  // 放置需要有依附面：找一个相邻的实心方块
  const offsets = [
    [0, -1, 0],
    [0, 1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  let reference = null;
  for (const [dx, dy, dz] of offsets) {
    const ref = bot.blockAt(vec(pos.x + dx, pos.y + dy, pos.z + dz));
    if (ref && ref.name !== "air" && ref.boundingBox !== "empty") {
      reference = ref;
      break;
    }
  }
  if (!reference) throw new Error("目标位置四周没有可以依附的方块，无法放置");

  // 依附面就是「从参照方块的哪个方向指向目标」
  const face = vec(
    Math.sign(pos.x - reference.position.x),
    Math.sign(pos.y - reference.position.y),
    Math.sign(pos.z - reference.position.z),
  );

  await bot.placeBlock(reference, face);
  return { ok: true, block: blockName, position: pos };
}

/* ---------------------------- 容器 ---------------------------- */

/**
 * 箱子 / 木桶。
 *
 * list：读附近容器里有什么。开箱子有成本，限制最多看两个。
 * withdraw：走到容器旁取出指定物品；没给坐标就按距离一个个试。
 *
 * 目标规划层需要「箱子里有没有现成材料」这个信息，
 * 否则背包一空就只能去砍树，明明旁边一箱木板却看不见。
 */
async function doContainer(args) {
  const bot = requireBot();
  const action = String(args.action || "list").toLowerCase();
  const radius = clamp(Number(args.radius) || 8, 1, 32);

  const mcData = requireFromRuntime("minecraft-data")(bot.version);
  const names = ["chest", "trapped_chest", "barrel"];
  const ids = names
    .map((n) => mcData.blocksByName[n] && mcData.blocksByName[n].id)
    .filter((id) => Number.isFinite(id));

  if (!ids.length) return { ok: true, containers: [] };

  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 8 });
  if (!found.length) {
    return { ok: true, containers: [], reason: `${radius} 格内没有容器` };
  }

  const nearest = found
    .map((p) => ({ p, d: bot.entity.position.distanceTo(p) }))
    .sort((a, b) => a.d - b.d);

  const approach = async (p) => {
    if (bot.entity.position.distanceTo(p) <= 4 || !bot.pathfinder) return;
    const { goals } = requireFromRuntime("mineflayer-pathfinder");
    await withTimeout(
      bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2)),
      8000,
      "走向容器",
      () => {
        try {
          bot.pathfinder.stop();
        } catch {
          /* ignore */
        }
      },
    );
  };

  if (action === "list") {
    const out = [];
    for (const { p, d } of nearest.slice(0, 2)) {
      try {
        await approach(p);
        const block = bot.blockAt(p);
        if (!block || block.name === "air") continue;
        const win = await bot.openContainer(block);
        const items = win
          .containerItems()
          .map((it) => ({ name: it.name, count: it.count }));
        win.close();
        out.push({
          position: vecSummary(p),
          block: block.name,
          distance: Math.round(d * 10) / 10,
          items,
        });
      } catch (e) {
        out.push({ position: vecSummary(p), error: e.message });
      }
    }
    return { ok: true, containers: out };
  }

  if (action === "withdraw") {
    const itemName = String(args.item || "").trim();
    const count = clamp(Number(args.count) || 1, 1, 64);
    if (!itemName) throw new Error("withdraw 需要 item");

    const targets = Number.isFinite(Number(args.x))
      ? [vec(Number(args.x), Number(args.y), Number(args.z))]
      : nearest.map((x) => x.p);

    for (const p of targets) {
      try {
        await approach(p);
        const block = bot.blockAt(p);
        if (!block || block.name === "air") continue;

        const win = await bot.openContainer(block);
        const stack = win.containerItems().filter((it) => it.name === itemName);
        if (!stack.length) {
          win.close();
          continue;
        }

        let left = count;
        for (const it of stack) {
          if (left <= 0) break;
          const take = Math.min(left, it.count);
          await win.withdraw(it.type, null, take);
          left -= take;
        }

        const remaining = win
          .containerItems()
          .filter((it) => it.name === itemName)
          .reduce((sum, it) => sum + it.count, 0);
        win.close();

        return {
          ok: true,
          item: itemName,
          took: count - left,
          remaining,
          position: vecSummary(p),
        };
      } catch {
        // 这个容器不行就换下一个
      }
    }

    throw new Error(`附近 ${radius} 格内的容器里没有可取的 ${itemName}`);
  }

  throw new Error(`未知 container action：${action}。可用：list / withdraw`);
}

/* ---------------------------- 生活技能 ---------------------------- */

async function doCraft(args) {
  const bot = requireBot();
  const itemName = String(args.item || "").trim();
  const count = clamp(Number(args.count) || 1, 1, 64);
  if (!itemName) throw new Error("item 参数不能为空（产物 id，如 oak_planks）");

  const mcData = requireFromRuntime("minecraft-data")(bot.version);
  const itemInfo = mcData.itemsByName[itemName];
  if (!itemInfo) throw new Error(`不认识的物品 id：${itemName}`);

  const findTable = () =>
    bot.findBlock({
      matching: (b) => b && b.name && b.name.includes("crafting_table"),
      maxDistance: 4,
    });

  // 先按「手上合成」查 2×2 配方
  let recipe = bot.recipesFor(itemInfo.id, null, 1, null)[0] || null;
  let table = null;

  // 3×3 配方必须把工作台传进 recipesFor 才查得到。
  // 之前固定传 null，木镐 / 石镐 / 铁镐这类配方永远查不到，
  // 表现成「材料明明够，却说没有可用的配方」。
  if (!recipe) {
    table = findTable();
    if (table) {
      recipe = bot.recipesFor(itemInfo.id, null, 1, table)[0] || null;
    }
  }

  if (!recipe) {
    throw new Error(
      table
        ? `没有可用的 ${itemName} 配方（材料不足）`
        : `没有可用的 ${itemName} 配方（材料不足，或附近 4 格内没有工作台）`,
    );
  }

  const times = Math.ceil(count / (recipe.result.count || 1));

  state.currentTask = `合成 ${itemName} ×${count}`;
  sendEvent("task", { label: state.currentTask });

  try {
    if (recipe.requiresTable && !table) {
      table = findTable();
      if (!table) throw new Error(`${itemName} 需要在附近 4 格内的工作台，找不到`);
    }
    await bot.craft(recipe, times, table);
    return { ok: true, item: itemName, crafted: count, times };
  } finally {
    state.currentTask = null;
    sendEvent("task", { label: null });
  }
}

async function doSmelt(args) {
  const bot = requireBot();
  const itemName = String(args.item || "").trim();
  const count = clamp(Number(args.count) || 1, 1, 64);
  if (!itemName) throw new Error("item 参数不能为空（原料 id，如 raw_iron）");

  const furnaceBlock = bot.findBlock({
    matching: (b) => b && (b.name === "furnace" || b.name === "blast_furnace" || b.name === "smoker"),
    maxDistance: 4,
  });
  if (!furnaceBlock) throw new Error("附近 4 格内没有熔炉");

  const item = bot.inventory.items().find((it) => it.name === itemName);
  if (!item) throw new Error(`背包里没有 ${itemName}`);

  // 找燃料
  const fuelNames = ["coal", "charcoal", "oak_planks", "spruce_planks", "birch_planks", "oak_log", "lava_bucket"];
  const fuel = bot.inventory.items().find((it) => fuelNames.includes(it.name));
  if (!fuel) throw new Error(`背包里没有燃料（可用：${fuelNames.join(" / ")}）`);

  const furnace = await bot.openFurnace(furnaceBlock);
  state.currentTask = `烧炼 ${itemName} ×${count}`;
  sendEvent("task", { label: state.currentTask });

  try {
    await furnace.putFuel(fuel.type, null, Math.min(fuel.count, 8));
    await furnace.putInput(item.type, null, Math.min(item.count, count));

    const deadline = Date.now() + 8 * 60_000;
    while (Date.now() < deadline) {
      assertNotAborted();
      const output = furnace.outputItem();
      if (output && output.count >= count) break;
      await delay(1000);
    }

    const output = furnace.outputItem();
    const produced = output ? output.count : 0;
    if (output) await furnace.takeOutput();
    return { ok: true, item: itemName, produced, fuel: fuel.name };
  } finally {
    try {
      furnace.close();
    } catch {
      /* ignore */
    }
    state.currentTask = null;
    sendEvent("task", { label: null });
  }
}

/**
 * 给一段异步操作加超时。
 *
 * 为什么需要：mineflayer-pathfinder 的 goto 在目标不可达时不会很快失败，
 * 它会一直算下去。实测砍树时单次采集被拖到 583 秒，就是卡在这里。
 * 超时后要显式 stop()，否则寻路器还在后台跑，继续吃 CPU 和 tick。
 */
function withTimeout(promise, ms, label, onTimeout) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        if (typeof onTimeout === "function") onTimeout();
      } catch {
        /* 兜底清理失败不影响超时本身 */
      }
      reject(new Error(`${label} 超时（${Math.round(ms / 1000)} 秒）`));
    }, ms);
    // 这里不能 unref：超时定时器是「保证操作被切断」的唯一凭据。
    // unref 后如果进程没有别的活动句柄，会直接退出而不触发超时。
  });

  return Promise.race([promise, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 采集：挖指定方块并自动捡掉落物，直到达到数量或超时 */
async function doCollect(args) {
  const bot = requireBot();
  const mcData = requireFromRuntime("minecraft-data")(bot.version);
  const blockName = String(args.block || "").trim();
  if (!blockName) throw new Error("block 参数不能为空");
  const blockInfo = mcData.blocksByName[blockName];
  if (!blockInfo) throw new Error(`不认识的方块 id：${blockName}`);

  // 工具由调用方（类脑决策）指定；这里只负责装备，不替决策层选。
  await equipTool(bot, args.tool);
  const toolName = bot.heldItem ? bot.heldItem.name : "barehand";
  const beforeCounts = inventoryCountMap(bot);

  const want = clamp(Number(args.count) || 1, 1, 512);

  // 搜索半径：在多大范围内找目标
  const radius = clamp(Number(args.radius) || 32, 4, 128);

  // 必达距离：目标超过这么远就放弃，不追。
  // 搜索半径管「找不找得到」，必达距离管「值不值得去」。
  // 分开是因为半径给大了之后，最远的目标可能要走很久，而收益完全一样。
  const maxDistance = clamp(Number(args.maxDistance) || Math.min(radius, 20), 2, 128);

  // 单次寻路超时：走不到就别耗着
  const travelMs = clamp(Number(args.travelMs) || 12_000, 1_000, 120_000);

  // 连续多少次没有进展就整体放弃
  const maxStalls = clamp(Number(args.maxStalls) || 3, 1, 20);

  // 总时限：兜底，防止各种意外把任务拖死
  const totalMs = clamp(Number(args.timeoutMs) || 4 * 60_000, 10_000, 9 * 60_000);
  const startedAt = Date.now();
  const deadline = startedAt + totalMs;

  let collected = 0;
  let attempts = 0;
  let stalls = 0;
  let lastReason = null;
  let approachResult = null;

  // 同一个目标只读一次地形，避免反复失败时重复扫 1000 多格
  const approachTried = new Set();
  const tryApproach = async (targetPos) => {
    const key = `${targetPos.x},${targetPos.y},${targetPos.z}`;
    if (approachTried.has(key)) return null;
    approachTried.add(key);

    approachResult = await approachTarget(bot, targetPos, {
      radius: 16,
      allowPlace: args.allowPlace,
      allowDig: args.allowDig,
      targetBlock: blockName,
      protectedItems: args.protectedItems,
      bias: args.bias,
    });
    return approachResult;
  };

  state.currentTask = `采集 ${blockName}（目标 ${want}）`;
  sendEvent("task", { label: state.currentTask });

  try {
    while (collected < want && Date.now() < deadline) {
      assertNotAborted();
      attempts += 1;
      if (attempts > want * 4 + 20) {
        lastReason = `尝试次数超限（${attempts}）`;
        break;
      }

      const pos = bot.findBlock({ matching: blockInfo.id, maxDistance: radius });
      if (!pos) {
        await doPickup({ range: Math.min(radius, 8) });
        lastReason = `${radius} 格内找不到 ${blockName}`;
        break;
      }

      // 当前版本明确要求工具、手里却没有：不空挖，直接把原因写进轨迹。
      const missingTool = harvestRequirement(mcData, blockName, bot.heldItem);
      if (missingTool) {
        lastReason = missingTool;
        break;
      }

      const dist = bot.entity.position.distanceTo(pos.position);

      // 最近的目标都超出必达距离 → 附近没有值得去的东西了，收工
      if (dist > maxDistance) {
        lastReason = `最近的目标在 ${dist.toFixed(1)} 格，超过必达距离 ${maxDistance}`;
        log(`采集 ${blockName}：${lastReason}，停止`);
        break;
      }

      // 走近再挖，太远挖不动
      if (dist > 3.5 && bot.pathfinder) {
        const { goals } = requireFromRuntime("mineflayer-pathfinder");
        try {
          await withTimeout(
            bot.pathfinder.goto(new goals.GoalNear(pos.position.x, pos.position.y, pos.position.z, 2)),
            travelMs,
            `走向 ${blockName}`,
            () => {
              // 超时必须停掉，否则寻路器还在后台跑
              try {
                bot.pathfinder.stop();
              } catch {
                /* ignore */
              }
            },
          );
        } catch (e) {
          lastReason = `走不过去：${e.message}`;
          log(`采集 ${blockName} 第 ${attempts} 次：${lastReason}`);

          // 寻路失败也先换接近面，而不是立刻放弃这个目标
          const approach = await tryApproach(pos.position);
          if (approach && approach.ok) {
            lastReason = `换接近面成功（${approach.strategy}，距离 ${approach.dist}）`;
            stalls = 0;
            continue;
          }

          stalls += 1;
          if (stalls >= maxStalls) {
            lastReason = `连续 ${stalls} 次走不到目标，停止`;
            break;
          }
          // 走不到就换下一个，不要硬挖（人没到，挖不动，白耗一轮）
          continue;
        }
      }

      // 到了再确认一次距离，别对着空气挥锄头
      const arrived = bot.entity.position.distanceTo(pos.position);
      if (arrived > 4.5) {
        lastReason = `到了位置但距离仍有 ${arrived.toFixed(1)} 格`;

        // 不再原地重试：读地形，换一个真正站得住的位置
        const approach = await tryApproach(pos.position);
        if (approach && approach.ok) {
          lastReason = `换接近面成功（${approach.strategy}，距离 ${approach.dist}）`;

          // 已经进交互距离，直接试着挖，不再空转一轮
          try {
            await bot.dig(bot.blockAt(pos.position));
            collected += 1;
            stalls = 0;
            await delay(600);
            continue;
          } catch (e) {
            lastReason = `接近后挖不动：${e.message}`;
          }
        }

        stalls += 1;
        if (stalls >= maxStalls) break;
        continue;
      }

      try {
        await bot.dig(bot.blockAt(pos.position));
        collected += 1;
        stalls = 0; // 有进展就重置
        // 等掉落物飞过来
        await delay(600);
      } catch (e) {
        // 单个方块挖不到不该让整个采集失败
        stalls += 1;
        lastReason = `挖不动：${e.message}`;
        log(`采集 ${blockName} 失败一次：${e.message}`);
        await delay(300);
        if (stalls >= maxStalls) break;
      }
    }

    await doPickup({ range: 8 });
    const have = bot.inventory.items().filter((it) => it.name === blockName).reduce((s, it) => s + it.count, 0);

    // 实际收益：不按 blockName 算，按背包真实增量算。
    // stone 掉 cobblestone 这种情况，只有增量能看见。
    const deltas = positiveDeltas(beforeCounts, inventoryCountMap(bot));
    const gained = deltas.reduce((sum, item) => sum + item.count, 0);
    const drop = deltas.length ? deltas[0].name : null;

    // 需要工具却一块都没掉：这趟不算完成，让负样本进轨迹。
    const needsTool = Boolean(blockInfo && blockInfo.harvestTools);
    const complete = collected >= want && (gained > 0 || !needsTool);
    if (!complete && !lastReason) {
      lastReason = needsTool && gained === 0
        ? `挖了 ${collected} 个 ${blockName}，但没有掉落（工具或方块状态不对）`
        : `只拿到 ${gained} 个掉落物`;
    }

    return {
      ok: true,
      block: blockName,
      tool: toolName,
      drop,
      gained,
      target: want,
      mined: collected,
      inInventory: have,
      // 诊断信息：为什么停、卡了几次，方便上层判断要不要换位置
      stalled: stalls,
      attempts,
      complete,
      reason: complete ? null : lastReason,
      elapsedMs: Date.now() - startedAt,
      // 路线诊断：上层用它决定记不记这条接近路线
      terrainKey: approachResult ? approachResult.terrainKey : null,
      approach: approachResult ? approachResult.approach : null,
      approachSteps: approachResult ? approachResult.steps || null : null,
      strategy: approachResult ? approachResult.strategy || null : null,
      tried: approachResult ? approachResult.tried || null : null,
      approachReason: approachResult ? approachResult.reason || null : null,
    };
  } finally {
    state.currentTask = null;
    sendEvent("task", { label: null });
  }
}

async function doPickup(args) {
  const bot = requireBot();
  const range = clamp(Number(args.range) || 8, 1, 32);
  const origin = bot.entity.position;

  const drops = Object.values(bot.entities || {}).filter(
    (e) => e && e.name === "item" && e.position && e.position.distanceTo(origin) <= range,
  );

  let picked = 0;
  for (const drop of drops.slice(0, 20)) {
    assertNotAborted();
    if (bot.pathfinder) {
      try {
        const { goals } = requireFromRuntime("mineflayer-pathfinder");
        await bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1));
        picked += 1;
      } catch {
        /* 走不过去就跳过 */
      }
    } else {
      await naiveWalk(bot, drop.position);
      picked += 1;
    }
  }

  return { ok: true, found: drops.length, approached: picked };
}

/* ---------------------------- 战斗 ---------------------------- */

const HOSTILE = new Set([
  "zombie",
  "skeleton",
  "creeper",
  "spider",
  "cave_spider",
  "enderman",
  "witch",
  "slime",
  "magma_cube",
  "pillager",
  "vindicator",
  "ravager",
  "husk",
  "drowned",
  "phantom",
  "blaze",
  "ghast",
  "piglin",
  "hoglin",
  "zoglin",
  "wither_skeleton",
]);

async function doAttack(args) {
  const bot = requireBot();
  const targetName = String(args.mob || args.target || "").trim();
  if (!targetName) throw new Error("mob 参数不能为空（生物 id，如 zombie / cow）");

  const kill = args.kill !== false;
  const deadline = Date.now() + 90_000;

  state.currentTask = `攻击 ${targetName}`;
  sendEvent("task", { label: state.currentTask });

  let killed = 0;

  try {
    while (Date.now() < deadline) {
      assertNotAborted();

      const targets = Object.values(bot.entities || {}).filter((e) => {
        if (!e || !e.position) return false;
        if (e === bot.entity) return false;
        const name = String(e.name || "").toLowerCase();
        return name === targetName.toLowerCase() && e.position.distanceTo(bot.entity.position) <= 24;
      });

      if (!targets.length) {
        if (killed > 0 || !kill) break;
        throw new Error(`附近 24 格内没有 ${targetName}`);
      }

      targets.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
      const target = targets[0];

      // 走近
      const dist = target.position.distanceTo(bot.entity.position);
      if (dist > 3 && bot.pathfinder) {
        try {
          const { goals } = requireFromRuntime("mineflayer-pathfinder");
          await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2));
        } catch {
          /* 走不过去就直接打打看 */
        }
      }

      // 持续攻击直到目标消失或血量为 0
      const attackDeadline = Date.now() + 30_000;
      while (Date.now() < attackDeadline) {
        assertNotAborted();
        const stillAlive = bot.entities[target.id];
        if (!stillAlive || (typeof stillAlive.health === "number" && stillAlive.health <= 0)) {
          killed += 1;
          break;
        }
        try {
          await bot.lookAt(stillAlive.position.offset(0, 1.6, 0));
          bot.attack(stillAlive);
        } catch {
          break;
        }
        await delay(600);
      }

      if (!kill) break;
      await delay(300);
    }

    // 顺手捡战利品
    if (args.pickup !== false) {
      try {
        await doPickup({ range: 10 });
      } catch {
        /* 捡不到不影响结果 */
      }
    }

    return { ok: true, mob: targetName, killed };
  } finally {
    state.currentTask = null;
    sendEvent("task", { label: null });
  }
}

/* ---------------------------- 交互动作 ---------------------------- */

async function doAct(args) {
  const bot = requireBot();
  const action = String(args.action || "").trim();

  switch (action) {
    case "eat": {
      const foods = [
        "bread",
        "cooked_beef",
        "cooked_porkchop",
        "cooked_chicken",
        "apple",
        "carrot",
        "baked_potato",
        "golden_apple",
        "beef",
        "porkchop",
        "chicken",
        "melon_slice",
      ];
      const item = bot.inventory.items().find((it) => foods.includes(it.name));
      if (!item) throw new Error("背包里没有能吃的食物");
      await bot.equip(item, "hand");
      await bot.consume();
      return { ok: true, action: "eat", item: item.name, food: Math.round(bot.food || 0) };
    }

    case "equip": {
      const itemName = String(args.item || "").trim();
      if (!itemName) throw new Error("equip 需要 item 参数");
      const item = bot.inventory.items().find((it) => it.name === itemName);
      if (!item) throw new Error(`背包里没有 ${itemName}`);
      await bot.equip(item, args.destination || "hand");
      return { ok: true, action: "equip", item: itemName };
    }

    case "sleep": {
      const bed = bot.findBlock({
        matching: (b) => b && b.name && b.name.endsWith("_bed"),
        maxDistance: 32,
      });
      if (!bed) throw new Error("附近没有床");
      if (bot.pathfinder) {
        const { goals } = requireFromRuntime("mineflayer-pathfinder");
        await bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 1));
      }
      await bot.sleep(bed);
      return { ok: true, action: "sleep" };
    }

    case "wake": {
      await bot.wake();
      return { ok: true, action: "wake" };
    }

    case "use": {
      // 使用手上的物品（例如打火石、剪刀对最近的实体）
      const item = bot.heldItem;
      if (!item) throw new Error("手上没有东西");
      await bot.activateItem();
      return { ok: true, action: "use", item: item.name };
    }

    case "drop": {
      const itemName = String(args.item || "").trim();
      if (!itemName) throw new Error("drop 需要 item 参数");
      const item = bot.inventory.items().find((it) => it.name === itemName);
      if (!item) throw new Error(`背包里没有 ${itemName}`);
      const count = clamp(Number(args.count) || 1, 1, item.count);
      await bot.toss(item.type, null, count);
      return { ok: true, action: "drop", item: itemName, count };
    }

    case "jump": {
      bot.setControlState("jump", true);
      setTimeout(() => bot.setControlState("jump", false), 300);
      return { ok: true, action: "jump" };
    }

    case "sneak": {
      const on = args.on !== false;
      bot.setControlState("sneak", on);
      return { ok: true, action: "sneak", on };
    }

    default:
      throw new Error(
        `不认识的 action：${action}。可用：eat / equip / sleep / wake / use / drop / jump / sneak`,
      );
  }
}

async function doGive(args) {
  const bot = requireBot();
  const itemName = String(args.item || "").trim();
  const playerName = String(args.player || "").trim();
  const count = clamp(Number(args.count) || 1, 1, 64);
  if (!itemName || !playerName) throw new Error("give 需要 item 和 player 参数");

  const item = bot.inventory.items().find((it) => it.name === itemName);
  if (!item) throw new Error(`背包里没有 ${itemName}`);

  const target = bot.players[playerName];
  if (!target || !target.entity) throw new Error(`找不到玩家 ${playerName}`);

  // 走到对方身边再丢
  if (bot.pathfinder) {
    try {
      const { goals } = requireFromRuntime("mineflayer-pathfinder");
      await bot.pathfinder.goto(
        new goals.GoalNear(target.entity.position.x, target.entity.position.y, target.entity.position.z, 3),
      );
    } catch {
      /* 走不到就直接丢，能不能捡到看距离 */
    }
  }

  await bot.toss(item.type, null, count);
  return { ok: true, item: itemName, count, player: playerName };
}

/* ---------------------------- 批量 ---------------------------- */

async function doSequence(args) {
  const steps = Array.isArray(args.steps) ? args.steps : [];
  if (!steps.length) throw new Error("sequence 需要 steps 数组");

  const results = [];
  for (let i = 0; i < steps.length; i++) {
    assertNotAborted();
    const step = steps[i];
    if (!step || !step.cmd) {
      results.push({ index: i, ok: false, error: "缺少 cmd" });
      continue;
    }
    try {
      const data = await dispatch(step.cmd, step.args || {});
      // 跑完了 ≠ 做成了：collect 没达成目标时会返回 ok:true + complete:false。
      // sequence 这一层要把它当成失败，否则失败样本进不了轨迹。
      const incomplete = Boolean(data && data.complete === false);
      results.push({
        index: i,
        ok: !incomplete,
        cmd: step.cmd,
        ...(incomplete ? { error: data.reason || "没有达成目标" } : {}),
        data,
      });
      // steps 里可以带 wait 字段，做节奏控制
      if (typeof step.wait === "number" && step.wait > 0) await delay(Math.min(step.wait, 30_000));
    } catch (e) {
      results.push({ index: i, ok: false, cmd: step.cmd, error: e.message });
      if (step.stopOnError !== false) break;
    }
  }

  return {
    total: steps.length,
    done: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

async function doBuild(args) {
  const bot = requireBot();
  const blockName = String(args.block || "").trim();
  if (!blockName) throw new Error("build 需要 block 参数（用哪种方块盖）");

  const origin = args.x !== undefined
    ? { x: Number(args.x), y: Number(args.y), z: Number(args.z) }
    : { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) };

  const kind = String(args.shape || "box").trim();
  const size = clamp(Number(args.size) || 3, 1, 12);

  const item = bot.inventory.items().find((it) => it.name === blockName);
  if (!item) throw new Error(`背包里没有 ${blockName}`);
  await bot.equip(item, "hand");

  const positions = buildShape(kind, origin, size, args);
  state.currentTask = `建造 ${kind}（${positions.length} 格）`;
  sendEvent("task", { label: state.currentTask });

  let placed = 0;
  let failed = 0;

  try {
    for (const pos of positions) {
      assertNotAborted();
      try {
        const existing = bot.blockAt(vec(pos.x, pos.y, pos.z));
        if (existing && existing.name !== "air") continue; // 已经有方块就跳过
        await placeAt(bot, pos);
        placed += 1;
      } catch {
        failed += 1;
      }
    }
    return { ok: true, shape: kind, block: blockName, placed, failed };
  } finally {
    state.currentTask = null;
    sendEvent("task", { label: null });
  }
}

function buildShape(kind, origin, size, args) {
  const out = [];
  const push = (x, y, z) => out.push({ x, y, z });

  switch (kind) {
    case "wall": {
      const height = clamp(Number(args.height) || 3, 1, 8);
      for (let x = 0; x < size; x++) for (let y = 0; y < height; y++) push(origin.x + x, origin.y + y, origin.z);
      break;
    }
    case "floor": {
      for (let x = 0; x < size; x++) for (let z = 0; z < size; z++) push(origin.x + x, origin.y, origin.z + z);
      break;
    }
    case "box": {
      const height = clamp(Number(args.height) || size, 1, 12);
      for (let x = 0; x < size; x++) {
        for (let z = 0; z < size; z++) {
          for (let y = 0; y < height; y++) {
            const isEdge = x === 0 || x === size - 1 || z === 0 || z === size - 1 || y === 0 || y === height - 1;
            if (isEdge) push(origin.x + x, origin.y + y, origin.z + z);
          }
        }
      }
      break;
    }
    case "pillar": {
      const height = clamp(Number(args.height) || size, 1, 32);
      for (let y = 0; y < height; y++) push(origin.x, origin.y + y, origin.z);
      break;
    }
    default:
      throw new Error(`不认识的 shape：${kind}。可用：box / wall / floor / pillar`);
  }

  // UTF-8 注释：按 y 从低到高、再按水平距离由近到远排，减少来回跑
  out.sort((a, b) => a.y - b.y || (Math.abs(a.x - origin.x) + Math.abs(a.z - origin.z)) - (Math.abs(b.x - origin.x) + Math.abs(b.z - origin.z)));
  return out;
}

/** 单格放置：找依附面 + placeBlock */
async function placeAt(bot, pos) {
  const offsets = [
    [0, -1, 0],
    [0, 1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];

  for (const [dx, dy, dz] of offsets) {
    const refPos = { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz };
    const ref = bot.blockAt(vec(refPos.x, refPos.y, refPos.z));
    if (!ref || ref.name === "air" || ref.boundingBox === "empty") continue;

    const face = vec(-dx, -dy, -dz);
    try {
      await bot.placeBlock(ref, face);
      return;
    } catch {
      /* 换一个面继续试 */
    }
  }
  throw new Error(`放不下去 (${pos.x},${pos.y},${pos.z})：四周没有可依附的面`);
}

/* ---------------------------- 指令 / 聊天 ---------------------------- */

/** 指令白名单：默认只放行只读或无害的指令 */
const DEFAULT_COMMAND_ALLOW = [
  "/list",
  "/seed",
  "/time query",
  "/weather query",
  "/help",
  "/me",
  "/msg",
  "/tell",
];

async function doCommand(args) {
  const bot = requireBot();
  const command = String(args.command || "").trim();
  if (!command) throw new Error("command 参数不能为空");

  const allowAll = args.allowAll === true;
  if (!allowAll) {
    const allowed = DEFAULT_COMMAND_ALLOW.some((prefix) => command.startsWith(prefix));
    if (!allowed) {
      throw new Error(
        `指令 ${command} 不在白名单内。可用的前缀：${DEFAULT_COMMAND_ALLOW.join(" / ")}。` +
          `确实需要执行任意指令，请传 allowAll=true（会由宿主向用户确认）`,
      );
    }
  }

  await bot.chat(command);
  return { ok: true, command };
}

function doSay(args) {
  const bot = requireBot();
  const message = String(args.message || "").trim();
  if (!message) throw new Error("message 不能为空");
  // 原版聊天单条上限 256
  const text = message.length > 256 ? message.slice(0, 256) : message;
  bot.chat(text);
  return { ok: true, message: text };
}

/* ---------------------------- 地图 ---------------------------- */

async function doMap(args) {
  const bot = requireBot();
  const radius = clamp(Number(args.radius) || 16, 4, 48);
  const layer = Number.isFinite(Number(args.y)) ? Number(args.y) : Math.floor(bot.entity.position.y) - 1;

  const origin = bot.entity.position;
  const rows = [];

  for (let dz = -radius; dz <= radius; dz++) {
    let row = "";
    for (let dx = -radius; dx <= radius; dx++) {
      const x = Math.floor(origin.x) + dx;
      const z = Math.floor(origin.z) + dz;
      const block = bot.blockAt(vec(x, layer, z));
      row += blockChar(block);
    }
    rows.push(row);
  }

  return {
    layer,
    radius,
    origin: { x: Math.floor(origin.x), z: Math.floor(origin.z) },
    legend: {
      ".": "空气",
      "#": "石头/矿石类",
      "+": "泥土/沙",
      T: "树干",
      "*": "树叶",
      "~": "水",
      "^": "其他",
      "@": "你所在列",
    },
    grid: rows,
  };
}

function blockChar(block) {
  if (!block || block.name === "air") return ".";
  const name = block.name;
  if (name === "water" || name === "flowing_water" || name === "lava") return "~";
  if (name.includes("log") || name.includes("wood")) return "T";
  if (name.includes("leaves")) return "*";
  if (name.includes("dirt") || name.includes("sand") || name.includes("gravel")) return "+";
  if (name.includes("stone") || name.includes("ore") || name.includes("deepslate")) return "#";
  return "^";
}

async function doHeight(args) {
  const bot = requireBot();
  const radius = clamp(Number(args.radius) || 12, 3, 32);
  const origin = bot.entity.position;
  const rows = [];
  let minY = Infinity;
  let maxY = -Infinity;

  for (let dz = -radius; dz <= radius; dz++) {
    const row = [];
    for (let dx = -radius; dx <= radius; dx++) {
      const x = Math.floor(origin.x) + dx;
      const z = Math.floor(origin.z) + dz;

      // 自上而下找第一个非空气方块
      let height = null;
      for (let y = Math.min(320, Math.floor(origin.y) + 40); y >= -64; y--) {
        const block = bot.blockAt(vec(x, y, z));
        if (block && block.name !== "air") {
          height = y;
          break;
        }
      }
      row.push(height);
      if (height !== null) {
        if (height < minY) minY = height;
        if (height > maxY) maxY = height;
      }
    }
    rows.push(row);
  }

  return {
    radius,
    minY: minY === Infinity ? null : minY,
    maxY: maxY === -1 ? null : maxY,
    heights: rows,
  };
}

/* ---------------------------- 地形与路线原语 ---------------------------- */

/** 一次读齐高度矩阵与地表图，减少两次往返 */
async function doTerrain(args) {
  const bot = requireBot();
  const radius = clamp(Number(args.radius) || 16, 4, 32);
  const origin = bot.entity.position;

  const height = await doHeight({ radius });
  const map = await doMap({ radius, y: Math.floor(origin.y) - 1 });

  return {
    radius,
    origin: { x: Math.floor(origin.x), z: Math.floor(origin.z) },
    minY: height.minY,
    maxY: height.maxY,
    heights: height.heights,
    grid: map.grid,
  };
}

/**
 * 路线自动挖时额外回避的玩家用品。
 * 挖掘层的 PROTECTED_BLOCKS 管的是「世界核心方块」，
 * 这里补的是「玩家摆出来的东西」。
 */
const ROUTE_AVOID_BLOCKS = new Set([
  "chest",
  "trapped_chest",
  "ender_chest",
  "crafting_table",
  "furnace",
  "blast_furnace",
  "smoker",
  "anvil",
  "enchanting_table",
  "beacon",
]);

function isProtectedBlock(name) {
  const n = String(name || "");
  if (!n) return true;
  if (PROTECTED_BLOCKS.has(n)) return true;
  if (ROUTE_AVOID_BLOCKS.has(n)) return true;
  // 门、床、告示牌这类玩家用品一律不碰
  return n.endsWith("_door") || n.endsWith("_sign") || n.endsWith("_bed");
}

/** 背包里找一种最适合消耗的方块：先便宜、再避开当前目标需要的资源 */
function findPlaceableItem(bot, opts = {}) {
  const items = bot.inventory.items();
  const pick = blockValue.pickConsumable(items, {
    maxTier: Number.isFinite(opts.maxTier) ? opts.maxTier : 2,
    protectedItems: opts.protectedItems || [],
    prefer: opts.item || "",
  });

  if (!pick) return null;
  return items.find((it) => it.name === pick.name) || null;
}

/** 向上垫方块：跳起，在脚下放一块，每放一块确认真的上去了 */
async function doPillar(args) {
  const bot = requireBot();
  const height = clamp(Number(args.height) || 1, 1, 8);
  const wanted = args.item ? String(args.item) : "";

  // 指定物品优先；没指定就按珍惜度挑最便宜的，并避开当前目标需要的资源
  const item = findPlaceableItem(bot, {
    item: wanted,
    protectedItems: args.protectedItems || [],
  });
  if (!item) throw new Error("背包里没有可安全消耗的方块");

  await bot.equip(item, "hand");

  // 垫高需要头顶两格净空：脚下 1 格是脚，往上 2 格才是起跳后的落脚空间。
  // 树冠下、天花板下直接判定不可用，让规划器换 bridge / walk，
  // 而不是跳一次、放不上去、再报一个没有信息量的「一块都没放上去」。
  const px = Math.floor(bot.entity.position.x);
  const pz = Math.floor(bot.entity.position.z);
  const baseY = Math.floor(bot.entity.position.y);
  const head1 = bot.blockAt(vec(px, baseY + 1, pz));
  const head2 = bot.blockAt(vec(px, baseY + 2, pz));
  if (!head1 || !head2 || head1.name !== "air" || head2.name !== "air") {
    throw new Error("垫高失败：头顶没有 2 格净空，换搭桥");
  }

  let placed = 0;
  let lastError = null;

  for (let i = 0; i < height; i++) {
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!below || below.name === "air") {
      lastError = "脚下没有可依附的方块";
      break;
    }

    const startY = bot.entity.position.y;
    bot.setControlState("jump", true);
    try {
      // 等到真的离地再放：固定延迟在低矮空间里经常还没升起来，
      // placeBlock 会撞在玩家自己的碰撞箱上。
      let lifted = false;
      for (let t = 0; t < 8; t += 1) {
        await delay(60);
        if (bot.entity.position.y - startY >= 0.35) {
          lifted = true;
          break;
        }
      }
      if (!lifted) {
        lastError = "起跳被挡住";
        break;
      }

      await bot.placeBlock(below, vec(0, 1, 0));
      placed += 1;
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
      break;
    } finally {
      bot.setControlState("jump", false);
    }

    await delay(160);

    // 方块放下去了但人没被顶上去：继续循环只会把方块摞在同一层，直接停
    if (bot.entity.position.y - startY < 0.5) {
      lastError = "方块放了但人没被顶上去";
      break;
    }
  }

  if (placed === 0) {
    throw new Error(`垫高失败：一块都没放上去${lastError ? `（${lastError}）` : ""}`);
  }
  return { ok: true, placed, height, position: vecSummary(bot.entity.position) };
}

/** 水平搭桥：朝一个方向逐格放方块，最多 4 格 */
async function doBridge(args) {
  const bot = requireBot();
  const dx = clamp(Number(args.dx) || 0, -4, 4);
  const dz = clamp(Number(args.dz) || 0, -4, 4);
  if (!dx && !dz) throw new Error("dx / dz 至少要有一个非零");

  const item = findPlaceableItem(bot, {
    item: args.item ? String(args.item) : "",
    protectedItems: args.protectedItems || [],
  });
  if (!item) throw new Error("背包里没有可安全消耗的方块");
  await bot.equip(item, "hand");

  const total = Math.max(Math.abs(dx), Math.abs(dz));
  const stepX = Math.sign(dx);
  const stepZ = Math.sign(dz);

  let placed = 0;
  for (let i = 1; i <= total; i++) {
    const target = bot.entity.position.offset(stepX * i, -1, stepZ * i);
    const block = bot.blockAt(target);
    if (block && block.name !== "air") continue;

    const ref = bot.blockAt(bot.entity.position.offset(stepX * (i - 1), -1, stepZ * (i - 1)));
    if (!ref || ref.name === "air") break;
    try {
      await bot.placeBlock(ref, vec(stepX, 0, stepZ));
      placed += 1;
    } catch {
      break;
    }
    await delay(150);
  }

  return { ok: placed > 0, placed, requested: total };
}

/** 执行一条路线步骤 */
async function runRouteStep(bot, step) {
  const action = String((step && step.action) || "");
  const a = step && step.args ? step.args : {};

  if (action === "move") {
    if (!bot.pathfinder) throw new Error("没有寻路器");
    const { goals } = requireFromRuntime("mineflayer-pathfinder");
    await withTimeout(
      bot.pathfinder.goto(new goals.GoalBlock(a.x, a.y, a.z)),
      12_000,
      "路线移动",
      () => {
        try {
          bot.pathfinder.stop();
        } catch {
          /* ignore */
        }
      },
    );
    return;
  }

  if (action === "jump") {
    bot.setControlState("jump", true);
    await delay(300);
    bot.setControlState("jump", false);
    return;
  }

  if (action === "pillar") {
    await doPillar({ height: a.height, item: a.item, protectedItems: a.protectedItems });
    return;
  }

  // 手段注册表会产出 bridge 步骤；这里必须和 dispatch 的 bridge 命令对齐，
  // 否则路线里一出现桥就会以「未知路线动作」整条失败。
  if (action === "bridge") {
    await doBridge({ dx: a.dx, dz: a.dz, item: a.item, protectedItems: a.protectedItems });
    return;
  }

  if (action === "dig") {
    const block = bot.blockAt(vec(a.x, a.y, a.z));
    if (!block) throw new Error("目标位置没有方块");
    if (isProtectedBlock(block.name)) throw new Error(`受保护方块，不挖：${block.name}`);
    await bot.dig(block);
    return;
  }

  throw new Error(`未知路线动作：${action}`);
}

/**
 * 采集失败时的接近策略：读地形 → 本地规划 → 逐条试。
 * 全程本地计算，不调模型。
 */
async function approachTarget(bot, targetPos, opts = {}) {
  const radius = clamp(Number(opts.radius) || 16, 8, 32);
  const terrain = await doTerrain({ radius });

  const inventory =
    bot.inventory && typeof bot.inventory.items === "function"
      ? bot.inventory.items()
      : [];

  const plan = terrainLib.planRoute(bot.entity.position, targetPos, terrain, {
    allowPlace: opts.allowPlace !== false,
    allowDig: opts.allowDig !== false,
    // 手段注册表按背包判断脚手架等可用手段
    inventory,
    // 当前目标需要的方块永不拿来垫高 / 搭桥
    protectedItems: Array.isArray(opts.protectedItems) ? opts.protectedItems : [],
    targetBlock: opts.targetBlock || "",
    // 路线记忆的历史成功率，交给手段注册表调整代价
    bias: opts.bias && typeof opts.bias === "object" ? opts.bias : {},
  });

  if (!plan.ok) {
    return { ok: false, reason: plan.reason, terrainKey: plan.terrainKey, tried: [] };
  }

  // 接近成功的判定线：Minecraft 服务端交互距离约 4.5，留一点余量。
  // 卡在 4.8 格这种「差一点点」不该直接判死，交给后面的 dig 试一次。
  const reach = clamp(Number(opts.reach) || 5, 3, 6);

  const tried = [];
  for (const strategy of plan.strategies) {
    try {
      for (const step of strategy.steps) {
        await runRouteStep(bot, step);
      }
      const dist = bot.entity.position.distanceTo(targetPos);
      tried.push({ kind: strategy.kind, dist: Math.round(dist * 10) / 10 });
      if (dist <= reach) {
        return {
          ok: true,
          strategy: strategy.kind,
          terrainKey: plan.terrainKey,
          approach: strategy.approach,
          // 成功的完整接近步骤（move / pillar / dig / jump）。
          // 上层要把这条路径原样记进路线库，下次直接复用，而不是只记「走到哪」。
          steps: strategy.steps,
          dist: Math.round(dist * 10) / 10,
          tried,
        };
      }
    } catch (e) {
      tried.push({ kind: strategy.kind, error: e.message });
    }
  }

  return {
    ok: false,
    reason: "所有接近策略都失败",
    terrainKey: plan.terrainKey,
    approach: plan.approach,
    tried,
  };
}

/* ---------------------------- 命令分发 ---------------------------- */

async function dispatch(cmd, args) {
  switch (cmd) {
    case "connect":
      return doConnect(args);
    case "disconnect":
      return doDisconnect();
    case "status":
      return doStatus();
    case "inventory":
      return doInventory();
    case "players":
      return doPlayers();
    case "entities":
      return doEntities(args);
    case "scan":
      return doScan(args);
    case "context":
      return doContext(args);
    case "move":
      return doMove(args);
    case "follow":
      return doFollow(args);
    case "stop":
      return doStop();
    case "dig":
      return doDig(args);
    case "block_meta":
      return doBlockMeta(args);
    case "place":
      return doPlace(args);
    case "craft":
      return doCraft(args);
    case "container":
      return doContainer(args);
    case "smelt":
      return doSmelt(args);
    case "collect":
      return doCollect(args);
    case "pickup":
      return doPickup(args);
    case "attack":
      return doAttack(args);
    case "act":
      return doAct(args);
    case "give":
      return doGive(args);
    case "sequence":
      return doSequence(args);
    case "build":
      return doBuild(args);
    case "command":
      return doCommand(args);
    case "say":
      return doSay(args);
    case "map":
      return doMap(args);
    case "height":
      return doHeight(args);
    case "terrain":
      return doTerrain(args);
    case "pillar":
      return doPillar(args);
    case "bridge":
      return doBridge(args);
    case "jump":
      return doAct({ action: "jump" });
    case "ping":
      return doPing(args);
    case "instincts":
      return doSetInstincts(args);
    default:
      throw new Error(`未知命令：${cmd}`);
  }
}

/* ---------------------------- 协议主循环 ---------------------------- */

/** 服务端状态探测：不登录，只发一次 STATUS 握手 */
async function doPing(args) {
  const host = String(args.host || "").trim();
  const port = Number(args.port) || 25565;
  if (!host) throw new Error("host 不能为空");

  const net = require("node:net");
  const timeoutMs = clamp(Number(args.timeoutMs) || 5000, 1000, 30_000);

  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let done = false;
    let buffer = Buffer.alloc(0);

    const finish = (payload) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve({ ...payload, latencyMs: Date.now() - started });
    };

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => finish({ ok: false, error: "连接超时（服务器没响应，或防火墙挡了）" }));
    socket.on("error", (e) => {
      const map = {
        ECONNREFUSED: "端口没有服务在监听",
        ENOTFOUND: "域名解析失败，检查地址拼写",
        EHOSTUNREACH: "主机不可达",
      };
      finish({ ok: false, error: map[e.code] || e.message });
    });

    socket.connect(port, host, () => {
      // 握手包（Handshake，packet id 0x00）的字段顺序：
      //   VarInt  protocolVersion   —— 状态查询填 -1 即可
      //   String  serverAddress     —— 长度是 **VarInt 字符数**，不是 uint16
      //   UShort  serverPort        —— 这个才是 uint16 大端
      //   VarInt  nextState         —— 1 = status
      //
      // ⚠️ 这里之前把地址长度写成 uint16，导致 Buffer 算小了 1 字节，
      //    写端口时越界抛 RangeError，包根本没发出去，表现为「服务器没响应」。
      const hostBuf = Buffer.from(host, "utf8");
      const hostLenSize = varIntSize(hostBuf.length);
      const protoSize = varIntSize(-1);
      const stateSize = varIntSize(1);

      const payloadLen = 1 + protoSize + hostLenSize + hostBuf.length + 2 + stateSize;
      const payload = Buffer.alloc(payloadLen);

      let o = 0;
      payload.writeUInt8(0x00, o); o += 1;                          // packet id
      const protoBuf = varIntBuf(-1);
      protoBuf.copy(payload, o); o += protoBuf.length;              // protocol version
      const hostLenBuf = varIntBuf(hostBuf.length);
      hostLenBuf.copy(payload, o); o += hostLenBuf.length;          // 地址长度（VarInt）
      hostBuf.copy(payload, o); o += hostBuf.length;                // 地址本体
      payload.writeUInt16BE(port, o); o += 2;                       // 端口（uint16 BE）
      const stateBuf = varIntBuf(1);
      stateBuf.copy(payload, o); o += stateBuf.length;              // next state = status

      // 外层再套一层长度前缀
      const lenBuf = varIntBuf(payloadLen);
      socket.write(Buffer.concat([lenBuf, payload]));

      // 紧接一个 Status Request（长度 1 + packet id 0x00）
      socket.write(Buffer.from([0x01, 0x00]));
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      // 至少要有长度前缀 + 包 id
      if (buffer.length < 3) return;

      try {
        const { value: len, size } = readVarInt(buffer, 0);
        if (buffer.length < size + len) return;
        const body = buffer.slice(size, size + len);
        const { value: packetId, size: idSize } = readVarInt(body, 0);
        if (packetId !== 0x00) return finish({ ok: false, error: `意外的包 id：${packetId}` });

        const { value: strLen, size: strSize } = readVarInt(body, idSize);
        const json = body.slice(idSize + strSize, idSize + strSize + strLen).toString("utf8");
        const data = JSON.parse(json);

        finish({
          ok: true,
          host,
          port,
          version: data.version ? data.version.name : null,
          protocol: data.version ? data.version.protocol : null,
          motd: flattenMotd(data.description),
          players: data.players ? { online: data.players.online, max: data.players.max } : null,
          favicon: data.favicon ? "present" : null,
        });
      } catch (e) {
        finish({ ok: false, error: `解析响应失败：${e.message}` });
      }
    });
  });
}

function varIntSize(value) {
  let v = value < 0 ? value + 0x100000000 : value;
  let size = 1;
  while (v >= 0x80) {
    v >>>= 7;
    size += 1;
  }
  return size;
}

function varIntBuf(value) {
  const out = [];
  let v = value < 0 ? value + 0x100000000 : value;
  for (;;) {
    if ((v & ~0x7f) === 0) {
      out.push(v);
      break;
    }
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return Buffer.from(out);
}

function writeVarInt(buf, value, offset) {
  const b = varIntBuf(value);
  b.copy(buf, offset);
}

function readVarInt(buf, offset) {
  let value = 0;
  let size = 0;
  for (;;) {
    const byte = buf[offset + size];
    value |= (byte & 0x7f) << (7 * size);
    size += 1;
    if ((byte & 0x80) === 0) break;
    if (size > 5) throw new Error("VarInt 过长");
  }
  return { value, size };
}

function flattenMotd(description) {
  if (description === null || description === undefined) return "";
  if (typeof description === "string") return description;
  if (Array.isArray(description)) return description.map(flattenMotd).join("");
  if (typeof description === "object") {
    let text = description.text || "";
    if (Array.isArray(description.extra)) text += description.extra.map(flattenMotd).join("");
    return text;
  }
  return String(description);
}

/* ---------------------------- 启动 ---------------------------- */

/**
 * 只有作为子进程直接运行时才接管 stdin。
 * 被 require 引入时（比如单测要拿 createDamageTracker）什么也不做，
 * 否则测试进程会被 stdin 监听拖住不退出。
 */
const isMain = require.main === module;

let bufferIn = "";

if (isMain) {
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  bufferIn += chunk;
  if (bufferIn.length > 8 * 1024 * 1024) {
    bufferIn = "";
    log("输入缓冲超限，已清空");
    return;
  }

  let index;
  while ((index = bufferIn.indexOf("\n")) !== -1) {
    const line = bufferIn.slice(0, index);
    bufferIn = bufferIn.slice(index + 1);
    if (!line.trim()) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      log(`协议解析失败：${e.message}`);
      continue;
    }

    // 收到命令先复位中断标记（stop 是唯一不挂起的命令）
    if (msg.cmd !== "stop") state.abortFlag = false;

    Promise.resolve()
      .then(() => dispatch(msg.cmd, msg.args || {}))
      .then((data) => {
        send({ id: msg.id, ok: true, data: data === undefined ? null : data });
      })
      .catch((e) => {
        send({ id: msg.id, ok: false, error: e && e.message ? e.message : String(e) });
      });
  }
});

process.stdin.on("end", () => {
  // 宿主关掉了管道：干净退出
  try {
    if (state.bot) state.bot.quit();
  } catch {
    /* ignore */
  }
  process.exit(0);
});

// 任何未捕获异常都只记录，不让进程死掉
process.on("uncaughtException", (e) => {
  log(`未捕获异常：${e && e.stack ? e.stack : e}`);
  sendEvent("error", { message: String(e && e.message ? e.message : e) });
});
process.on("unhandledRejection", (e) => {
  log(`未处理的 Promise 拒绝：${e && e.stack ? e.stack : e}`);
});

process.on("SIGTERM", () => {
  try {
    if (state.bot) state.bot.quit();
  } catch {
    /* ignore */
  }
  process.exit(0);
});

// 通知宿主可以开始发命令了
let mineflayerVersion = null;
try {
  const dir = getNodeModulesDir();
  if (dir) {
    mineflayerVersion = JSON.parse(
      require("node:fs").readFileSync(path.join(dir, "mineflayer", "package.json"), "utf8"),
    ).version;
  }
} catch {
  /* 版本号拿不到不影响运行 */
}

send({ kind: "ready", pid: process.pid, mineflayerVersion });
startStatusPush();
} // end if (isMain)

/* ---------------------------- 导出（供单测使用） ---------------------------- */

module.exports = {
  createDamageTracker,
  nearbyHostile,
  withTimeout,
  harvestRequirement,
  inventoryCountMap,
  positiveDeltas,
  DAMAGE_TYPES,
  DAMAGE_KIND,
  DAMAGE_LABEL,
  DAMAGE_TYPE_LABEL,
  MIN_DAMAGE_TO_REPORT,
  state,
};

