"use strict";

/**
 * 本能反射层（Instincts）。
 *
 * ── 为什么需要这一层 ─────────────────────────────────────────────
 * 插件式的机器人有个天生缺陷：AI 不调用工具的时候，它就是个木桩。
 * 站在野外、旁边有僵尸、血一直在掉——而它在等下一句指令。
 *
 * 这一层补的就是这段时间：每 tickMs 醒一次，看几眼周围，
 * 该跑就跑、该吃就吃、该捡就捡。不经过大模型，纯本地判断。
 *
 * ── 设计纪律（三条） ──────────────────────────────────────────────
 * 1. **保命优先，添乱靠后**
 *    逃跑、进食、脱离窒息这三类不管在做什么都要执行；
 *    捡东西、点火把、闪避落沙这类会打断当前动作的，只在闲着时做。
 *
 * 2. **不抢用户的活**
 *    如果附近有玩家且离得很近，逃跑时要先判断跑的方向会不会撞进
 *    玩家刚建好的地方——宁可站着挨一下，也别把人家房子拆了。
 *
 * 3. **同一个动作不反复触发**
 *    每个本能都有自己的冷却。否则血量刚好卡在阈值上，
 *    会变成每 800ms 逃一次、跳一下，看着像抽风。
 */

const TICK_MS = 800;

/** 血量低于这个值，且附近有敌对生物 -> 逃跑 */
const LOW_HEALTH = 12;
/** 逃跑冷却 */
const FLEE_COOLDOWN_MS = 6000;
/** 饥饿低于这个值自动进食 */
const HUNGRY_FOOD = 14;
/** 进食冷却 */
const EAT_COOLDOWN_MS = 3000;
/** 掉落物感应半径 */
const ITEM_PICKUP_RANGE = 6;
/** 捡东西冷却 */
const PICKUP_COOLDOWN_MS = 2500;
/** 光照低于这个值考虑放火把 */
const DARK_THRESHOLD = 5;
/** 放火把冷却 */
const TORCH_COOLDOWN_MS = 15000;
/** 环境自救（落沙/掉水/窒息）冷却 */
const ENV_COOLDOWN_MS = 4000;
/** 玩家距离小于这个值，逃跑时要看方向 */
const PLAYER_NEAR = 8;

/** 头顶会掉下来砸人的方块（子串匹配，含 sandstone / red_sand 等） */
const FALL_BLOCKS = ["sand", "gravel", "concrete_powder"];

/** 敌对生物清单 */
const HOSTILE = new Set([
  "zombie",
  "husk",
  "drowned",
  "skeleton",
  "stray",
  "creeper",
  "spider",
  "cave_spider",
  "witch",
  "slime",
  "magma_cube",
  "pillager",
  "vindicator",
  "evoker",
  "ravager",
  "phantom",
  "blaze",
  "ghast",
  "piglin",
  "piglin_brute",
  "hoglin",
  "zoglin",
  "wither_skeleton",
  "enderman",
  "silverfish",
  "endermite",
  "guardian",
  "elder_guardian",
  "shulker",
  "vex",
  "warden",
]);

/** 可猎的动物（饿到没东西吃时打猎用） */
const HUNTABLE = new Set(["chicken", "cow", "pig", "sheep", "rabbit", "mooshroom"]);

/**
 * 食物价值表：吃得越饱越优先。
 * 数值参考饥饿值恢复量，金苹果之类带特殊效果的排前面但不在日常吃。
 */
const FOOD_VALUE = new Map([
  ["cooked_beef", 8],
  ["cooked_porkchop", 8],
  ["cooked_mutton", 6],
  ["cooked_chicken", 6],
  ["cooked_rabbit", 5],
  ["cooked_cod", 5],
  ["cooked_salmon", 6],
  ["bread", 5],
  ["baked_potato", 5],
  ["golden_carrot", 6],
  ["apple", 4],
  ["carrot", 3],
  ["melon_slice", 2],
  ["beef", 3],
  ["porkchop", 3],
  ["mutton", 2],
  ["chicken", 2],
  ["rabbit", 3],
  ["cod", 2],
  ["salmon", 2],
  ["potato", 1],
  ["cookie", 2],
  ["sweet_berries", 2],
  ["dried_kelp", 1],
]);

/** 保命类本能：无论手上在做什么都要执行 */
const CRITICAL = new Set(["flee", "eat", "drown", "suffocate"]);

class Instincts {
  /**
   * @param {object} opts
   * @param {object} opts.bot     mineflayer bot
   * @param {(event:string, data:any)=>void} opts.emit  向上游报事件
   * @param {()=>string|null} opts.getTask  当前正在做的任务描述
   * @param {(msg:string)=>void} opts.log
   * @param {object} opts.config  可覆盖阈值
   */
  constructor(opts) {
    this.bot = opts.bot;
    this.emit = opts.emit || (() => {});
    this.getTask = opts.getTask || (() => null);
    this.log = opts.log || (() => {});

    const cfg = opts.config || {};
    this.tickMs = Number(cfg.tickMs) || TICK_MS;
    this.lowHealth = Number(cfg.lowHealth) || LOW_HEALTH;
    this.hungryFood = Number(cfg.hungryFood) || HUNGRY_FOOD;
    this.enabled = cfg.enabled !== false;

    this.timer = null;
    this.busy = false;
    this.lastFlee = 0;
    this.lastEat = 0;
    this.lastPickup = 0;
    this.lastTorch = 0;
    this.lastEnv = 0;

    /** 最近做过的本能动作，给状态接口用 */
    this.lastAction = null;
    this.lastActionAt = 0;
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  start() {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log(`[instinct] tick 异常：${e.message}`));
    }, this.tickMs);
    // 不要让定时器拖住进程退出
    if (this.timer.unref) this.timer.unref();
    this.log(`[instinct] 本能层已启动（${this.tickMs}ms / 血线 ${this.lowHealth} / 饿线 ${this.hungryFood}）`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 当前状态摘要，给 status 工具用 */
  snapshot() {
    return {
      enabled: Boolean(this.timer),
      tickMs: this.tickMs,
      lastAction: this.lastAction,
      lastActionAt: this.lastActionAt || null,
    };
  }

  /* ------------------------------ 主循环 ------------------------------ */

  async tick() {
    // 上一轮还没跑完就跳过，避免堆积
    if (this.busy) return;

    const bot = this.bot;
    if (!bot || !bot.entity) return;

    this.busy = true;
    try {
      // 顺序就是优先级：先活下来，再谈别的
      if (await this.guardDrown()) return;
      if (await this.guardSuffocate()) return;
      if (await this.guardFlee()) return;
      if (await this.guardEat()) return;

      // 闲时才做的事：正在跑任务就不插嘴
      if (this.getTask()) return;

      if (await this.guardFallingBlock()) return;
      if (await this.guardPickup()) return;
      if (await this.guardTorch()) return;
    } finally {
      this.busy = false;
    }
  }

  /** 记一次动作，顺便广播 */
  #did(kind, detail) {
    this.lastAction = kind;
    this.lastActionAt = Date.now();
    this.emit("instinct", { kind, detail, at: this.lastActionAt });
  }

  /* ------------------------------ 窒息 / 溺水 ------------------------------ */

  /** 头被方块堵住：赶紧挖开，不然一直掉血 */
  async guardSuffocate() {
    const now = Date.now();
    if (now - this.lastEnv < ENV_COOLDOWN_MS) return false;

    const bot = this.bot;
    const head = bot.entity.position.offset(0, 1.6, 0);
    let block;
    try {
      block = bot.blockAt(head);
    } catch {
      return false;
    }
    if (!block || block.name === "air" || block.boundingBox === "empty") return false;
    // 水不算窒息
    if (block.name.includes("water")) return false;

    this.lastEnv = now;
    this.log(`[instinct] 头部被 ${block.name} 堵住，挖开`);
    this.#did("suffocate", block.name);

    try {
      await bot.dig(block);
    } catch {
      /* 挖不动就算了，下一 tick 再试 */
    }
    return true;
  }

  /** 在水里且氧气见底：往上游 */
  async guardDrown() {
    const bot = this.bot;
    if (!bot.entity || !bot.entity.position) return false;

    // mineflayer 暴露氧气在 bot.oxygenLevel
    const oxygen = typeof bot.oxygenLevel === "number" ? bot.oxygenLevel : null;
    if (oxygen === null || oxygen > 60) return false;

    const head = bot.blockAt(bot.entity.position.offset(0, 1.6, 0));
    const inWater = head && head.name.includes("water");
    if (!inWater) return false;

    this.#did("drown", `氧气 ${oxygen}`);
    bot.setControlState("jump", true);
    setTimeout(() => {
      try {
        bot.setControlState("jump", false);
      } catch {
        /* 可能已经断了 */
      }
    }, 800);
    return true;
  }

  /* ------------------------------ 逃跑 ------------------------------ */

  /** 找最近的敌对生物 */
  #nearestHostile(radius) {
    const bot = this.bot;
    let best = null;
    let bestDist = Infinity;

    for (const id of Object.keys(bot.entities || {})) {
      const e = bot.entities[id];
      if (!e || !e.position || e === bot.entity) continue;
      const name = String(e.name || "").toLowerCase();
      if (!HOSTILE.has(name)) continue;
      // 已经死了的不算
      if (typeof e.health === "number" && e.health <= 0) continue;

      const dist = e.position.distanceTo(bot.entity.position);
      if (dist <= radius && dist < bestDist) {
        best = e;
        bestDist = dist;
      }
    }
    return best ? { entity: best, distance: bestDist } : null;
  }

  async guardFlee() {
    const bot = this.bot;
    const health = typeof bot.health === "number" ? bot.health : 20;
    if (health >= this.lowHealth) return false;

    const threat = this.#nearestHostile(16);
    if (!threat) return false;

    const now = Date.now();
    if (now - this.lastFlee < FLEE_COOLDOWN_MS) return false;
    this.lastFlee = now;

    const dir = this.#pickFleeDirection(threat.entity.position);
    if (!dir) return false;

    this.log(`[instinct] 血量 ${Math.round(health)}，逃 ${threat.entity.name}（${Math.round(threat.distance)} 格）`);
    this.#did("flee", `${threat.entity.name} @ ${Math.round(threat.distance)} 格`);

    // 有寻路就走个目标点，没有就持续推方向
    if (bot.pathfinder) {
      try {
        const { goals } = requireFromRuntime("mineflayer-pathfinder");
        const target = bot.entity.position.offset(dir.x * 12, 0, dir.z * 12);
        await bot.pathfinder.goto(new goals.GoalBlock(target.x, Math.round(target.y), target.z));
        return true;
      } catch {
        /* 寻路失败就退化成推方向 */
      }
    }

    // 降级：朝反方向跑 1.5 秒
    const yaw = Math.atan2(-dir.x, -dir.z);
    try {
      await bot.look(yaw, 0, true);
    } catch {
      /* ignore */
    }
    bot.setControlState("forward", true);
    setTimeout(() => {
      try {
        bot.setControlState("forward", false);
      } catch {
        /* ignore */
      }
    }, 1500);

    return true;
  }

  /**
   * 挑逃跑方向。
   *
   * 规则：
   *   - 默认往威胁反方向跑
   *   - 如果那个方向离某个玩家很近（PLAYER_NEAR 以内），换一个偏一点的角度
   *   - 实在挑不出来就原地跑（返回 null，不动作）
   */
  #pickFleeDirection(threatPos) {
    const bot = this.bot;
    const me = bot.entity.position;

    const away = {
      x: me.x - threatPos.x,
      z: me.z - threatPos.z,
    };
    const len = Math.hypot(away.x, away.z) || 1;
    const base = { x: away.x / len, z: away.z / len };

    // 附近有哪些玩家
    const players = [];
    for (const name of Object.keys(bot.players || {})) {
      if (name === bot.username) continue;
      const p = bot.players[name];
      if (p && p.entity && p.entity.position) players.push(p.entity.position);
    }

    // 候选方向：正后方，然后左右各偏 45°、90°
    const angles = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2];

    for (const a of angles) {
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const dir = {
        x: base.x * cos - base.z * sin,
        z: base.x * sin + base.z * cos,
      };

      // 看这个方向 12 格内会不会撞到玩家
      const probe = { x: me.x + dir.x * 12, z: me.z + dir.z * 12 };
      let tooClose = false;
      for (const pp of players) {
        const d = Math.hypot(pp.x - probe.x, pp.z - probe.z);
        if (d < PLAYER_NEAR) {
          tooClose = true;
          break;
        }
      }

      if (!tooClose) return dir;
    }

    // 全都会撞到人：干脆别跑了，站着比撞进别人家里好
    this.log("[instinct] 逃跑方向都会靠近玩家，原地不动");
    return null;
  }

  /* ------------------------------ 进食 ------------------------------ */

  async guardEat() {
    const bot = this.bot;
    const food = typeof bot.food === "number" ? bot.food : 20;
    if (food >= this.hungryFood) return false;

    const now = Date.now();
    if (now - this.lastEat < EAT_COOLDOWN_MS) return false;

    const pick = this.#bestFood();
    if (!pick) {
      // 饿到不行又没吃的：闲着的时候去打个猎
      if (food <= 6 && !this.getTask()) {
        await this.#hunt();
      }
      return false;
    }

    this.lastEat = now;
    this.log(`[instinct] 饥饿 ${Math.round(food)}，吃 ${pick.name}`);
    this.#did("eat", pick.name);

    try {
      await bot.equip(pick, "hand");
      await bot.consume();
    } catch (e) {
      this.log(`[instinct] 进食失败：${e.message}`);
    }
    return true;
  }

  /** 从背包里挑最划算的食物；没有返回 null */
  #bestFood() {
    const items = this.bot.inventory.items();
    let best = null;
    let bestScore = -1;

    for (const item of items) {
      const value = FOOD_VALUE.get(item.name);
      if (value === undefined) continue;
      // 同价值时留多一点的那种（避免只剩一个却在关键时刻没得吃）
      const score = value * 10 + Math.min(item.count, 5);
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    return best;
  }

  /** 没吃的去打猎：找最近的动物，打死，捡肉 */
  async #hunt() {
    const bot = this.bot;
    const me = bot.entity.position;

    let target = null;
    let bestDist = Infinity;
    for (const id of Object.keys(bot.entities || {})) {
      const e = bot.entities[id];
      if (!e || !e.position) continue;
      const name = String(e.name || "").toLowerCase();
      if (!HUNTABLE.has(name)) continue;
      // 幼体不下手
      if (e.metadata && Number(e.metadata[16]) === 1) continue;
      const dist = e.position.distanceTo(me);
      if (dist < 24 && dist < bestDist) {
        target = e;
        bestDist = dist;
      }
    }
    if (!target) return;

    this.log(`[instinct] 太饿了，去打 ${target.name}`);
    this.#did("hunt", target.name);

    try {
      if (bot.pathfinder) {
        const { goals } = requireFromRuntime("mineflayer-pathfinder");
        await bot.pathfinder.goto(
          new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2),
        );
      }
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const still = bot.entities[target.id];
        if (!still) break;
        if (typeof still.health === "number" && still.health <= 0) break;
        try {
          await bot.lookAt(still.position.offset(0, 1.6, 0));
          bot.attack(still);
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 600));
      }
      // 捡肉
      await new Promise((r) => setTimeout(r, 800));
    } catch (e) {
      this.log(`[instinct] 打猎没成：${e.message}`);
    }
  }

  /* ------------------------------ 捡东西 ------------------------------ */

  async guardPickup() {
    const bot = this.bot;
    const now = Date.now();
    if (now - this.lastPickup < PICKUP_COOLDOWN_MS) return false;

    const me = bot.entity.position;
    const drops = Object.values(bot.entities || {}).filter(
      (e) => e && e.name === "item" && e.position && e.position.distanceTo(me) <= ITEM_PICKUP_RANGE,
    );
    if (!drops.length) return false;

    this.lastPickup = now;
    this.#did("pickup", `${drops.length} 个掉落物`);

    // 只走到最近那个，别来回跑
    drops.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
    const near = drops[0];

    try {
      if (bot.pathfinder) {
        const { goals } = requireFromRuntime("mineflayer-pathfinder");
        await bot.pathfinder.goto(
          new goals.GoalNear(near.position.x, near.position.y, near.position.z, 1),
        );
      } else {
        const dx = near.position.x - me.x;
        const dz = near.position.z - me.z;
        const yaw = Math.atan2(-dx, -dz);
        await bot.look(yaw, 0, true);
        bot.setControlState("forward", true);
        setTimeout(() => {
          try {
            bot.setControlState("forward", false);
          } catch {
            /* ignore */
          }
        }, 600);
      }
    } catch {
      /* 走不过去就放弃这批，下次冷却后再说 */
    }

    return true;
  }

  /* ------------------------------ 补光 ------------------------------ */

  async guardTorch() {
    const bot = this.bot;
    const now = Date.now();
    if (now - this.lastTorch < TORCH_COOLDOWN_MS) return false;

    const torch = bot.inventory
      .items()
      .find((it) => it.name === "torch" || it.name === "lantern" || it.name === "glowstone");
    if (!torch) return false;

    const me = bot.entity.position;
    let light = null;
    try {
      const block = bot.blockAt(me);
      if (block && typeof block.light === "number") light = block.light;
    } catch {
      return false;
    }
    if (light === null || light >= DARK_THRESHOLD) return false;

    // 附近已经有点亮的东西就别浪费火把了
    const nearbyTorch = bot.findBlock({
      matching: (b) => b && (b.name === "torch" || b.name === "wall_torch" || b.name === "lantern"),
      maxDistance: 8,
    });
    if (nearbyTorch) return false;

    this.lastTorch = now;
    this.log(`[instinct] 光照 ${light}，插个 ${torch.name}`);
    this.#did("torch", `光照 ${light}`);

    try {
      await bot.equip(torch, "hand");

      // 放在脚下这一格旁边的地面上
      const offsets = [
        [0, -1, 0],
        [1, 0, 0],
        [-1, 0, 0],
        [0, 0, 1],
        [0, 0, -1],
      ];
      for (const [dx, dy, dz] of offsets) {
        const ref = bot.blockAt(me.offset(dx, dy, dz));
        if (!ref || ref.name === "air" || ref.boundingBox === "empty") continue;
        try {
          // 火把要放在实体方块的上表面
          await bot.placeBlock(ref, requireFromRuntime("vec3")(0, 1, 0));
          break;
        } catch {
          /* 换个位置试 */
        }
      }
    } catch (e) {
      this.log(`[instinct] 放火把失败：${e.message}`);
    }

    return true;
  }

  /* ------------------------------ 闪避落沙 ------------------------------ */

  async guardFallingBlock() {
    const bot = this.bot;
    const now = Date.now();
    if (now - this.lastEnv < ENV_COOLDOWN_MS) return false;

    const me = bot.entity.position;
    let danger = null;

    // 看头顶 1~4 格
    for (let dy = 1; dy <= 4; dy++) {
      const block = bot.blockAt(me.offset(0, dy, 0));
      if (!block || block.name === "air") continue;
      const name = block.name;
      if (FALL_BLOCKS.some((f) => name.includes(f))) {
        danger = block;
      }
      break; // 只关心头顶第一块实心的
    }

    if (!danger) return false;

    // 下方是空气才危险（悬空才会掉）
    const below = bot.blockAt(danger.position.offset(0, -1, 0));
    if (below && below.name !== "air") return false;

    this.lastEnv = now;
    this.log(`[instinct] 头顶悬着 ${danger.name}，躲一下`);
    this.#did("dodge", danger.name);

    // 横向挪一格
    const side = Math.random() > 0.5 ? 1 : -1;
    const yaw = Math.atan2(side, 0);
    try {
      await bot.look(yaw, 0, true);
      bot.setControlState("forward", true);
      setTimeout(() => {
        try {
          bot.setControlState("forward", false);
        } catch {
          /* ignore */
        }
      }, 400);
    } catch {
      /* ignore */
    }

    return true;
  }
}

module.exports = { Instincts, LOW_HEALTH, HUNGRY_FOOD, FOOD_VALUE, HOSTILE, TICK_MS };
