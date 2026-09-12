// 反射层：不经 LLM 的本能反应（参考 mindcraft modes 的分层思路）。
// 优先级：环境保命(溺水/坠落物/火岩浆/濒死) > 逃跑(保命或胆小) > 进食 > 反击 > 打猎 > 捡掉落物 > 放火把 > 看向玩家。
// 与任务的交互约定：
// - 环境保命/逃跑/反击无条件打断当前任务（保命优先），通过宿主注入的 clearTask 回调清理；
// - 打猎/捡物/火把/盯人只在空闲时发生，不打断寻路、跟随和收集。
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// tick 间隔：够快（反应灵敏）又不至于频繁打断其他逻辑
const TICK_MS = 800;
// 逃跑冷却：防止 tick 反复触发导致原地抖动
const FLEE_COOLDOWN_MS = 6000;
// 环境保命冷却：倒水/闪避/逃离需要几秒生效，期间不重复触发
const ENV_COOLDOWN_MS = 4000;
// 血量低于该值且附近有敌对怪时进入逃跑
const LOW_HEALTH = 12;
// 饥饿低于该值自动进食；没吃的就去打猎
const HUNGRY_FOOD = 14;
// 捡拾掉落物的感应半径
const ITEM_PICKUP_RANGE = 6;
// 放火把的光照阈值（0~15，越小越暗）
const DARK_THRESHOLD = 5;
// 头顶有这些方块悬空时会掉落砸伤，需要闪避（子串匹配含 sandstone/red_sand 等）
const FALL_BLOCKS = ["sand", "gravel", "concrete_powder"];
// 可猎动物清单（成年鸡牛猪羊兔蘑菇牛；幼体不下手）
const HUNTABLE_ANIMALS = ["chicken", "cow", "pig", "sheep", "rabbit", "mooshroom"];
// 打猎最长持续时长，防止无限追击
const HUNT_MAX_MS = 30_000;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// 判断实体是否敌对生物
function isHostile(entity) {
  return entity?.type === "mob" && entity.kind === "Hostile mobs";
}

// 判断实体是否可猎杀的成年动物
function isHuntable(entity) {
  if (!entity?.name) return false;
  if (!HUNTABLE_ANIMALS.includes(entity.name.toLowerCase())) return false;
  // metadata[16] 是幼体标志（版本间索引可能漂移，读不到当成年处理）
  try {
    return !entity.metadata?.[16];
  } catch {
    return true;
  }
}

export class Modes {
  // getBot 返回当前 mineflayer 实例（未连接时为 null）；
  // hooks.isCollecting/isCollecting() 当前是否有收集任务；
  // hooks.getTask() 当前移动任务描述（null 为空闲）；
  // hooks.setTask(desc) 反射捡物/打猎时登记任务描述；
  // hooks.clearTask(reason) 保命反射打断任务时调用；
  // hooks.onInstinct(text) 反射行为上报宿主。
  constructor(getBot, hooks) {
    this.getBot = getBot;
    this.hooks = hooks;
    this.timer = null;
    this.eating = false;
    this.fleeUntil = 0;
    this.envCooldownUntil = 0;
    this.wasJumping = false;
    this.hunting = false;
    // 胆小人格开关：开启后见怪就逃、永不反击，由宿主下发
    this.cowardice = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.eating = false;
    this.hunting = false;
    this.wasJumping = false;
  }

  /** 宿主切换胆小模式。 */
  setCowardice(enabled) {
    this.cowardice = !!enabled;
  }

  // 找范围内最近的敌对怪
  nearestHostile(range) {
    const bot = this.getBot();
    if (!bot?.entity) return null;
    return bot.nearestEntity((e) =>
      isHostile(e) && e.position.distanceTo(bot.entity.position) < range);
  }

  // 找范围内最近的可猎动物
  nearestHuntable(range) {
    const bot = this.getBot();
    if (!bot?.entity) return null;
    return bot.nearestEntity((e) =>
      isHuntable(e) && e.position.distanceTo(bot.entity.position) < range);
  }

  // 找最近的玩家实体（排除自己）
  nearestPlayer(range) {
    const bot = this.getBot();
    if (!bot?.entity) return null;
    return bot.nearestEntity((e) =>
      e.type === "player" && e.username !== bot.username &&
      e.position.distanceTo(bot.entity.position) < range);
  }

  // 从背包找食物（minecraft-data 的 food 字段 > 0 即可食用）
  findFood() {
    const bot = this.getBot();
    if (!bot) return null;
    const mcData = require("minecraft-data")(bot.version);
    const food = bot.inventory.items().find((it) => {
      const d = mcData.itemsByName[it.name];
      return d && d.food > 0;
    });
    return food ?? null;
  }

  // 装备最好的近战武器（优先剑，其次斧镐）
  async equipBestWeapon() {
    const bot = this.getBot();
    if (!bot) return;
    const items = bot.inventory.items();
    const weapon =
      items.find((i) => i.name.includes("sword")) ??
      items.find((i) => i.name.includes("axe")) ??
      items.find((i) => i.name.includes("pickaxe"));
    if (weapon) await bot.equip(weapon, "hand");
  }

  // 吃掉指定食物：装备到手上再 consume
  async eat(foodItem) {
    const bot = this.getBot();
    if (!bot || this.eating) return;
    this.eating = true;
    try {
      await bot.equip(foodItem, "hand");
      await bot.consume();
    } catch { /* 进食失败不影响下个 tick 重试 */ } finally {
      this.eating = false;
    }
  }

  // 朝远离实体的方向逃窜
  fleeFrom(entity, dist) {
    const bot = this.getBot();
    if (!bot?.entity) return;
    const { goals } = require("mineflayer-pathfinder");
    const dir = bot.entity.position.minus(entity.position).normalize();
    const target = bot.entity.position.plus(dir.scaled(dist));
    bot.pathfinder.setGoal(new goals.GoalXz(target.x, target.z));
  }

  // 随机方向走 dist 格（没有明确威胁源时的逃离，如脚下着火）
  moveAway(dist) {
    const bot = this.getBot();
    if (!bot?.entity) return;
    const { goals } = require("mineflayer-pathfinder");
    const angle = Math.random() * Math.PI * 2;
    const p = bot.entity.position;
    bot.pathfinder.setGoal(
      new goals.GoalXz(p.x + Math.cos(angle) * dist, p.z + Math.sin(angle) * dist));
  }

  // 灭火自救：有水桶就倒水浇身，其次跑向最近的水源，最后随机逃离躲火
  async extinguishSelf() {
    const bot = this.getBot();
    if (!bot?.entity) return;
    try {
      const bucket = bot.inventory.items().find((i) => i.name === "water_bucket");
      if (bucket) {
        await bot.equip(bucket, "hand");
        // 看向脚下再倒水，浇灭自己身上的火
        await bot.look(bot.entity.yaw, Math.PI / 2, false);
        await bot.activateItem();
        this.hooks.onInstinct("身上着火，倒了桶水把自己浇灭");
        return;
      }
      // 找 20 格内的水源，跑过去泡水降温
      const waters = bot.findBlocks({
        matching: (b) => b.name === "water",
        maxDistance: 20,
        count: 1,
      });
      if (waters && waters.length > 0) {
        const { goals } = require("mineflayer-pathfinder");
        const w = waters[0];
        bot.pathfinder.setGoal(new goals.GoalNear(w.x, w.y, w.z, 1));
        this.hooks.onInstinct("身上着火，附近有水，跑过去泡一泡");
        return;
      }
      this.moveAway(5);
      this.hooks.onInstinct("身上着火又没水，先跑开躲火");
    } catch { /* 自救失败等下个冷却周期重试 */ }
  }

  // 猎杀目标动物：追击+攻击直到倒下，掉落的肉由捡物反射顺手捡走
  async hunt(entity) {
    const bot = this.getBot();
    if (!bot?.entity) return;
    this.hunting = true;
    const desc = `打猎（${entity.name ?? "动物"}）`;
    this.hooks.setTask(desc);
    this.hooks.onInstinct(`饿了但背包没吃的，去猎${entity.name ?? "动物"}`);
    const startedAt = Date.now();
    try {
      await this.equipBestWeapon();
      while (bot.entity && bot.entities[entity.id]) {
        // 任务被抢（用户指令/保命反射）就立刻停手让位
        if (this.hooks.getTask() !== desc) return;
        // 超时放弃，防止无限追击
        if (Date.now() - startedAt > HUNT_MAX_MS) break;
        const dist = entity.position.distanceTo(bot.entity.position);
        if (dist > 3) {
          const { goals } = require("mineflayer-pathfinder");
          bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true);
          await sleepMs(300);
        } else {
          await bot.lookAt(entity.position.offset(0, 1, 0));
          await bot.attack(entity);
          await sleepMs(700);
        }
      }
    } catch { /* 打猎中断忽略 */ } finally {
      this.hunting = false;
      // 正常收尾才清任务；被抢时任务已归属新主人，不动
      if (this.hooks.getTask() === desc) {
        this.hooks.clearTask("打猎结束");
      }
    }
  }

  // 在脚下放火把；返回是否真的放了
  async placeTorchHere() {
    const bot = this.getBot();
    if (!bot?.entity) return false;
    const Vec3 = require("vec3");
    const at = bot.blockAt(bot.entity.position);
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!at || !below || below.boundingBox !== "block") return false;
    if (at.light >= DARK_THRESHOLD || at.skyLight >= DARK_THRESHOLD) return false;
    const torch = bot.inventory.items().find((i) => i.name === "torch");
    if (!torch) return false;
    await bot.equip(torch, "hand");
    await bot.placeBlock(below, new Vec3(0, 1, 0));
    return true;
  }

  // 环境保命检测：溺水/头顶坠落物/火岩浆/濒死重伤。
  // 返回 true 表示触发了需要独占的动作，本轮 tick 到此为止。
  checkEnvironment(bot) {
    const pos = bot.entity.position;
    let block = bot.blockAt(pos);
    let above = bot.blockAt(pos.offset(0, 1, 0));
    // 区块未加载时按空气处理，避免误判
    if (!block) block = { name: "air" };
    if (!above) above = { name: "air" };

    // 溺水：头进水里 → 跳起来换气（不打断任务，无寻路目标时才接管跳跃）
    if (above.name === "water") {
      try {
        if (!bot.pathfinder.goal) bot.setControlState("jump", true);
        this.wasJumping = true;
      } catch { /* pathfinder 未就绪时忽略 */ }
      // 换气不独占，继续检查其他危险
    } else if (this.wasJumping) {
      // 出水后解除我们设的跳跃状态
      try { bot.setControlState("jump", false); } catch { /* 忽略 */ }
      this.wasJumping = false;
    }

    // 头顶有沙砾类方块悬空 → 闪避开 2 格
    if (FALL_BLOCKS.some((n) => above.name.includes(n))) {
      if (Date.now() > this.envCooldownUntil) {
        this.envCooldownUntil = Date.now() + ENV_COOLDOWN_MS;
        this.hooks.clearTask(`本能：躲开头顶的${above.name}`);
        this.moveAway(2);
        this.hooks.onInstinct(`头顶的${above.name}要掉下来了，赶紧闪开`);
      }
      return true;
    }

    // 站在火/岩浆里，或头即将扎进火/岩浆 → 灭火自救
    if (block.name === "lava" || block.name === "fire" ||
        above.name === "lava" || above.name === "fire") {
      if (Date.now() > this.envCooldownUntil) {
        this.envCooldownUntil = Date.now() + ENV_COOLDOWN_MS;
        this.hooks.clearTask("本能：身上着火了");
        void this.extinguishSelf();
      }
      return true;
    }

    // 濒死重伤：3 秒内刚挨过打，且血量见底或单次伤害足以致命 → 大距离逃离
    const lastHurtAgo = Date.now() - (bot.lastDamageTime ?? 0);
    const lastDamage = bot.lastDamageTaken ?? 0;
    if (lastHurtAgo < 3000 && (bot.health < 5 || lastDamage >= bot.health)) {
      if (Date.now() > this.envCooldownUntil) {
        this.envCooldownUntil = Date.now() + ENV_COOLDOWN_MS;
        this.hooks.clearTask("本能：濒死逃离");
        this.moveAway(20);
        this.hooks.onInstinct("伤得太重了，先逃命再说");
      }
      return true;
    }

    return false;
  }

  tick() {
    const bot = this.getBot();
    if (!bot?.entity) return;
    try {
      // 1. 环境保命：溺水换气、躲坠落方块、灭火、濒死逃离（比敌对怪更急）
      if (this.checkEnvironment(bot)) return;
      // 2. 逃跑：血量低且附近有敌对怪 → 逃跑；胆小模式见怪就逃
      if (bot.health < LOW_HEALTH || this.cowardice) {
        const hostile = this.nearestHostile(16);
        if (hostile && (this.cowardice || Date.now() > this.fleeUntil)) {
          // 胆小模式无视冷却持续躲；低血量用冷却防抖
          this.fleeUntil = Date.now() + FLEE_COOLDOWN_MS;
          const scared = this.cowardice && bot.health >= LOW_HEALTH;
          this.hooks.clearTask(
            scared ? `本能：躲开 ${hostile.name ?? "敌对生物"}` : `本能：逃离 ${hostile.name ?? "敌对生物"}`);
          this.fleeFrom(hostile, 16);
          this.hooks.onInstinct(
            scared
              ? `有点害怕 ${hostile.name ?? "敌对生物"}，先躲远点`
              : `生命值低，正在逃离 ${hostile.name ?? "敌对生物"}`);
          return;
        }
      }
      // 3. 进食：饿了就吃（无需空闲，随时可以吃）
      if (bot.food < HUNGRY_FOOD && !this.eating) {
        const food = this.findFood();
        if (food) {
          void this.eat(food).then(() => {
            this.hooks.onInstinct(`有点饿，吃掉了 ${food.name}`);
          });
          return;
        }
      }
      // 4. 反击：敌对怪贴脸 → 装备武器攻击（胆小模式永不反击）
      const close = this.nearestHostile(3);
      if (close && !this.cowardice) {
        this.hooks.clearTask(`本能：反击 ${close.name ?? "敌对生物"}`);
        void this.equipBestWeapon().then(() => bot.attack(close)).catch(() => {});
        this.hooks.onInstinct(`遭到 ${close.name ?? "敌对生物"} 攻击，正在反击`);
        return;
      }
      // 以下反射只在没有任务/收集时进行，避免打断玩家指令
      if (this.hooks.isCollecting()) return;
      if (this.hooks.getTask()) return;
      // 5. 打猎：饿了但背包没吃的 → 猎杀附近动物弄点肉
      if (bot.food < HUNGRY_FOOD && !this.hunting && !this.findFood()) {
        const prey = this.nearestHuntable(16);
        if (prey) {
          void this.hunt(prey);
          return;
        }
      }
      // 6. 捡拾：附近有掉落物 → 走过去（碰到自动捡起）
      const drop = bot.nearestEntity((e) =>
        e.displayName === "Item" &&
        e.position.distanceTo(bot.entity.position) < ITEM_PICKUP_RANGE);
      if (drop) {
        const { goals } = require("mineflayer-pathfinder");
        this.hooks.setTask("捡拾掉落物");
        bot.pathfinder.setGoal(
          new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0));
        this.hooks.onInstinct("走过去捡附近的掉落物");
        return;
      }
      // 7. 火把：周围太暗且背包有火把 → 放一根
      const hasTorch = bot.inventory.items().some((i) => i.name === "torch");
      if (hasTorch) {
        void this.placeTorchHere().then((ok) => {
          if (ok) this.hooks.onInstinct("周围太暗，放了个火把");
        });
        return;
      }
      // 8. 存在感：闲着时看向最近的玩家
      const player = this.nearestPlayer(8);
      if (player) {
        try {
          void bot.lookAt(player.position.offset(0, 1.6, 0), true);
        } catch { /* lookAt 失败忽略 */ }
      }
    } catch { /* 反射层异常不影响主流程 */ }
  }
}
