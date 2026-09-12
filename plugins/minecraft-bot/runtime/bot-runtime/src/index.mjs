#!/usr/bin/env node
// 机器人子进程：用 mineflayer 连接 Minecraft 服务器，
// 与宿主插件之间用 stdin/stdout 的 JSON 行协议双向通信。
// 宿主 → 机器人：connect / say / move_to / follow / stop / collect / inventory / players /
//                 consume / equip / give / sleep / craft / smelt / place / break / build_shelter /
//                 attack / pickup / use_door / goto_block / dig_down / go_surface / stay / discard /
//                 till_sow / use_tool_on / chest_put / chest_take / chest_view / activate_block /
//                 villager_trades / villager_trade / shutdown
// 机器人 → 宿主：connecting / connected / connect_error / spawn / chat / health / position /
//                 inventory_push / instinct / death / kicked / end / path_result / resp / collect_result / log / say_result
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { Modes } from "./modes.mjs";

const require = createRequire(import.meta.url);

/** 向宿主发送一条 JSON 行消息。 */
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

/** 诊断日志走协议通道，宿主统一打印。 */
function log(message) {
  send({ type: "log", message: String(message) });
}

/** kicked/end 事件里的原因可能是字符串或富文本对象，统一转成可读文本。 */
function normalizeReason(reason) {
  if (typeof reason === "string") return reason;
  if (reason && typeof reason.toString === "function") {
    try { return reason.toString(); } catch { /* 转换失败走兜底 */ }
  }
  return JSON.stringify(reason);
}

// 自检模式：验证子进程能启动并输出协议消息，不依赖 mineflayer 和服务器
if (process.argv.includes("--self-test")) {
  send({ type: "log", message: "bot-runtime 自检通过" });
  process.exit(0);
}

/** 当前 mineflayer 实例；未连接时为 null。 */
let bot = null;
/** 位置消息节流：两秒最多上报一次。 */
let lastPosSent = 0;
/** 当前移动任务的描述，用于 path_result 回报。 */
let currentTask = null;
/** 正在进行的收集任务标志，用于 stop 时取消。 */
let collecting = false;
// 可中断技能（攻击/捡拾/下挖等）的中止标志：stop 指令或本能保命时置位，runSkill 开始时复位
let skillAbort = false;
// 原地等待的到期计时器（stay 技能用，非阻塞）
let stayTimer = null;
/** 背包定时上报的计时器；连接断开时清理。 */
let invTimer = null;
/** 上次上报的背包 JSON，用于去重（内容没变就不发）。 */
let lastInvJson = "";

/** 把背包快照推给宿主；内容有变化才发送，宿主用它做聊天情境注入。 */
function pushInventory() {
  if (!bot || !bot.inventory) return;
  const items = bot.inventory.items().map((it) => ({ name: it.name, count: it.count }));
  const json = JSON.stringify(items);
  if (json === lastInvJson) return;
  lastInvJson = json;
  send({ type: "inventory_push", items });
}

// 反射层：自保/反击/进食/捡物/火把/盯人，不经 LLM 直接驱动身体
const modes = new Modes(() => bot, {
  isCollecting: () => collecting,
  getTask: () => currentTask,
  setTask: (desc) => { currentTask = desc; },
  clearTask: (reason) => stopTask(reason),
  onInstinct: (action) => send({ type: "instinct", action }),
});

function sendSpawn() {
  send({
    type: "spawn",
    position: [bot.entity.position.x, bot.entity.position.y, bot.entity.position.z],
    health: bot.health,
    food: bot.food,
  });
}

/** 停止当前移动/跟随任务并回报结果。 */
function stopTask(reason) {
  if (!bot) return;
  // 中断进行中的可中断技能（攻击/捡拾/下挖），并解除原地等待
  skillAbort = true;
  if (stayTimer) {
    clearTimeout(stayTimer);
    stayTimer = null;
  }
  try {
    bot.pathfinder.setGoal(null);
  } catch { /* pathfinder 未就绪时忽略 */ }
  // 收集任务内部也走寻路，一并取消
  if (collecting) {
    try { bot.collectBlock.cancelTask(); } catch { /* 无任务时忽略 */ }
  }
  if (currentTask) {
    send({ type: "path_result", task: currentTask, status: "stopped", reason: reason ?? "用户停止" });
  }
  currentTask = null;
}

/** 建立 mineflayer 连接并挂载所有事件转发。 */
function connect({ host, port, username }) {
  if (bot) {
    log("已有连接，忽略重复 connect 指令");
    return;
  }
  const mineflayer = require("mineflayer");
  const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
  const { plugin: collectBlockPlugin } = require("mineflayer-collectblock");
  // host 参数可能混着端口（如 "localhost:56511"），拆开容错
  let realHost = String(host).trim();
  let realPort = port;
  const withPort = /^(.+):(\d+)$/.exec(realHost);
  if (withPort) {
    realHost = withPort[1];
    realPort = Number(withPort[2]);
    log(`host 参数带端口，已拆分为 ${realHost}:${realPort}`);
  }
  send({ type: "connecting" });
  bot = mineflayer.createBot({
    host: realHost,
    port: realPort,
    username,
    // 不锁定协议版本，由 mineflayer 根据服务器握手自动协商
    version: false,
    // 离线模式（局域网/离线服务器）；正版验证需要额外的微软登录流程，暂不支持
    auth: "offline",
  });

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(collectBlockPlugin);

  // 背包快照定时上报（3 秒查一次，内容变了才发）
  invTimer = setInterval(pushInventory, 3000);

  // 登录成功后关闭连接失败上报，避免运行期错误被误判为连不上
  let loggedIn = false;

  bot.once("login", () => {
    loggedIn = true;
    send({ type: "connected", username: bot.username });
  });
  bot.on("spawn", () => {
    // 每次重生重置默认移动参数（允许挖方块、允许游泳等交给上层配置，这里用默认）
    bot.pathfinder.setMovements(new Movements(bot));
    sendSpawn();
    pushInventory();
    modes.start();
  });
  bot.on("chat", (player, message) => {
    // 过滤自己发出的聊天，避免宿主收到回声
    if (player === bot.username) return;
    send({ type: "chat", player, message });
  });
  bot.on("whisper", (player, message) => {
    if (player === bot.username) return;
    send({ type: "chat", player, message: `(私聊) ${message}` });
  });
  bot.on("health", () => send({ type: "health", health: bot.health, food: bot.food }));
  bot.on("move", () => {
    const now = Date.now();
    if (now - lastPosSent < 2000) return;
    lastPosSent = now;
    const p = bot.entity?.position;
    if (p) send({ type: "position", position: [p.x, p.y, p.z] });
  });
  bot.on("death", () => {
    // 死亡会中断寻路任务，统一走 stopTask 清理状态
    stopTask("机器人在游戏中死亡");
    send({ type: "death" });
  });
  bot.on("kicked", (reason) => send({ type: "kicked", reason: normalizeReason(reason) }));
  bot.on("error", (err) => {
    const message = err?.message ?? String(err);
    // 连接阶段的错误立即上报让宿主快速失败；登录后的错误只记日志
    if (!loggedIn) {
      send({ type: "connect_error", error: message });
    } else {
      log(`mineflayer 错误: ${message}`);
    }
  });
  bot.on("end", () => {
    bot = null;
    currentTask = null;
    collecting = false;
    modes.stop();
    if (invTimer) {
      clearInterval(invTimer);
      invTimer = null;
    }
    lastInvJson = "";
    send({ type: "end", reason: "连接已关闭" });
  });

  // 寻路终点到达/不可达的回报，转成 path_result 上报宿主
  bot.on("goal_reached", () => {
    if (!currentTask) return;
    const p = bot.entity?.position;
    send({
      type: "path_result",
      task: currentTask,
      status: "arrived",
      position: p ? [p.x, p.y, p.z] : undefined,
    });
    currentTask = null;
  });
}

/** 走到指定坐标或玩家身边。 */
function moveTo({ target, x, y, z }) {
  if (!bot) {
    log("未连接，忽略 move_to");
    return;
  }
  const { goals } = require("mineflayer-pathfinder");
  let goal;
  let taskDesc;
  if (target) {
    const player = Object.values(bot.players).find((p) => p.username === target);
    const entity = player?.entity;
    if (!entity) {
      send({ type: "path_result", task: `走向 ${target}`, status: "failed", reason: "玩家不在线或不在视野内" });
      return;
    }
    // 距玩家 2 格内算到达，避免贴脸抖动
    goal = new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2);
    taskDesc = `走向 ${target}`;
  } else {
    goal = new goals.GoalBlock(x, y, z);
    taskDesc = `走向 (${x}, ${y}, ${z})`;
  }
  currentTask = taskDesc;
  bot.pathfinder.setGoal(goal);
}

/** 持续跟随指定玩家。 */
function follow({ target }) {
  if (!bot) {
    log("未连接，忽略 follow");
    return;
  }
  const { goals } = require("mineflayer-pathfinder");
  const player = Object.values(bot.players).find((p) => p.username === target);
  if (!player) {
    send({ type: "path_result", task: `跟随 ${target}`, status: "failed", reason: "玩家不在线" });
    return;
  }
  currentTask = `跟随 ${target}`;
  // GoalFollow：动态目标，玩家移动时自动更新路径
  bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, 3), true);
}

/** 收集指定数量的方块（自动寻路、选工具、挖掘、拾取）。 */
async function collect({ block, count }) {
  if (!bot) {
    send({ type: "collect_result", block, requested: count, ok: false, error: "机器人未连接" });
    return;
  }
  const mcData = require("minecraft-data")(bot.version);
  const blockType = mcData.blocksByName[block];
  if (!blockType) {
    send({ type: "collect_result", block, requested: count, ok: false, error: `未知方块 id: ${block}（用英文小写下划线，如 oak_log）` });
    return;
  }
  // 一次找齐目标数量的方块位置（64 格搜索半径）
  const positions = bot.findBlocks({ matching: blockType.id, maxDistance: 64, count });
  if (positions.length === 0) {
    send({ type: "collect_result", block, requested: count, ok: false, error: `附近 64 格内找不到 ${block}` });
    return;
  }
  const targets = positions.map((p) => bot.blockAt(p)).filter(Boolean);
  collecting = true;
  try {
    await bot.collectBlock.collect(targets, { ignoreNoPath: true });
    send({ type: "collect_result", block, requested: count, ok: true, found: targets.length });
  } catch (err) {
    send({ type: "collect_result", block, requested: count, ok: false, error: err?.message ?? String(err) });
  } finally {
    collecting = false;
    currentTask = null;
    // 收集结束背包必然变化，立即推一次让宿主侧情境保持新鲜
    pushInventory();
  }
}

/** 上报背包物品清单。 */
function inventory({ reqId }) {
  if (!bot) {
    send({ type: "resp", reqId, ok: false, error: "机器人未连接" });
    return;
  }
  const items = bot.inventory.items().map((it) => ({ name: it.name, count: it.count }));
  send({ type: "resp", reqId, ok: true, data: items });
}

/** 上报在线玩家（有实体的带坐标）。 */
function players({ reqId }) {
  if (!bot) {
    send({ type: "resp", reqId, ok: false, error: "机器人未连接" });
    return;
  }
  const list = Object.values(bot.players)
    .filter((p) => p.username !== bot.username)
    .map((p) => {
      const pos = p.entity?.position;
      return {
        name: p.username,
        position: pos ? [pos.x, pos.y, pos.z] : undefined,
      };
    });
  send({ type: "resp", reqId, ok: true, data: list });
}

// ---------- 生活技能（参考 mindcraft skills.js 的简化实现）----------

/** 吃食物：不指定就挑背包里第一个能吃的。 */
async function consumeFood({ item }) {
  const mcData = require("minecraft-data")(bot.version);
  let target;
  if (item) {
    const named = bot.inventory.items().find((i) => i.name === String(item));
    if (!named) throw new Error(`背包里没有 ${item}`);
    const d = mcData.itemsByName[named.name];
    if (!d || !d.food) throw new Error(`${item} 不是食物`);
    target = named;
  } else {
    target = bot.inventory.items().find((i) => {
      const d = mcData.itemsByName[i.name];
      return d && d.food > 0;
    });
    if (!target) throw new Error("背包里没有任何食物");
  }
  await bot.equip(target, "hand");
  await bot.consume();
  return `吃掉了 ${target.name}（饥饿值已恢复）`;
}

/** 把物品装备到手上（工具/武器/食物都可以）。 */
async function equipItem({ item }) {
  const named = bot.inventory.items().find((i) => i.name === String(item));
  if (!named) throw new Error(`背包里没有 ${item}`);
  await bot.equip(named, "hand");
  return `已把 ${named.name} 拿在手上`;
}

/** 走到玩家身边把物品丢给对方。 */
async function giveItem({ player, item, count }) {
  const p = Object.values(bot.players).find((pl) => pl.username === String(player));
  if (!p?.entity) throw new Error(`玩家 ${player} 不在线或不在视野内`);
  const dist = p.entity.position.distanceTo(bot.entity.position);
  if (dist > 3) {
    // 先走到跟前再给，避免丢到地上被别人捡走
    const { goals } = require("mineflayer-pathfinder");
    currentTask = `走向 ${player}（送东西）`;
    await bot.pathfinder.goto(new goals.GoalNear(
      p.entity.position.x, p.entity.position.y, p.entity.position.z, 2));
    currentTask = null;
  }
  const named = bot.inventory.items().find((i) => i.name === String(item));
  if (!named) throw new Error(`背包里没有 ${item}`);
  const n = Math.min(Math.max(Number(count) || 1, 1), named.count);
  // 面向玩家再丢
  await bot.lookAt(p.entity.position.offset(0, 1, 0));
  await bot.toss(named.type, null, n);
  return `已把 ${item} x${n} 丢给 ${player}`;
}

/** 找最近的床走过去睡觉。 */
async function sleepInBed() {
  const mcData = require("minecraft-data")(bot.version);
  const bedIds = Object.values(mcData.blocks)
    .filter((b) => b.name.endsWith("_bed"))
    .map((b) => b.id);
  const positions = bot.findBlocks({ matching: bedIds, maxDistance: 32, count: 1 });
  if (positions.length === 0) throw new Error("附近 32 格内没有床");
  const bed = bot.blockAt(positions[0]);
  const { goals } = require("mineflayer-pathfinder");
  currentTask = "走向床";
  await bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
  currentTask = null;
  await bot.sleep(bed);
  return "已躺下睡觉（天亮会自动醒来）";
}

/** 合成物品：优先用附近 3 格内的合成台，2x2 配方可空手合。 */
async function craftItem({ item, count }) {
  const mcData = require("minecraft-data")(bot.version);
  const itemData = mcData.itemsByName[String(item)];
  if (!itemData) throw new Error(`未知物品 id: ${item}（用英文小写下划线，如 oak_planks）`);
  const n = Math.min(Math.max(Number(count) || 1, 1), 64);
  const table = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 4 });
  const recipes = bot.recipesFor(itemData.id, null, 1, table ?? undefined);
  if (recipes.length === 0) {
    throw new Error(table
      ? `缺少 ${item} 的材料（或需要 3x3 合成台而在 4 格内没找到）`
      : `合成 ${item} 需要合成台（附近 4 格内没有）或缺少材料`);
  }
  await bot.craft(recipes[0], n, table ?? null);
  return `合成了 ${item} x${n}`;
}

/** 熔炼物品：找附近熔炉，放燃料和原料，等结果取出。 */
async function smeltItem({ item, count }) {
  const mcData = require("minecraft-data")(bot.version);
  const itemData = mcData.itemsByName[String(item)];
  if (!itemData) throw new Error(`未知物品 id: ${item}`);
  const n = Math.min(Math.max(Number(count) || 1, 1), 64);
  const furnaceBlock = bot.findBlock({ matching: mcData.blocksByName.furnace.id, maxDistance: 4 });
  if (!furnaceBlock) throw new Error("附近 4 格内没有熔炉");
  const furnace = await bot.openFurnace(furnaceBlock);
  try {
    // 燃料优先煤，其次木炭、木板、原木
    const fuelNames = ["coal", "charcoal", "oak_planks", "oak_log", "planks"];
    const fuel = bot.inventory.items().find((i) => fuelNames.includes(i.name));
    if (!fuel) throw new Error("背包里没有可用的燃料（煤/木炭/木板/原木）");
    const input = bot.inventory.items().find((i) => i.name === String(item));
    if (!input) throw new Error(`背包里没有 ${item}`);
    await furnace.putFuel(fuel.type, null, Math.ceil(n / 8));
    await furnace.putInput(input.type, null, n);
    // 轮询等熔炼完成：每件约 10 秒，留足余量
    const deadline = Date.now() + n * 12_000 + 15_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const out = furnace.outputItem();
      if (out && out.count >= n) break;
      if (!furnace.inputItem() && out) break;
    }
    const out = furnace.outputItem();
    if (!out) throw new Error("熔炼超时：没有产出（燃料或原料可能不足）");
    await furnace.takeOutput();
    return `熔炼完成：得到 ${out.name} x${out.count}`;
  } finally {
    furnace.close();
  }
}

// ---------- 建造（参考 mindcraft placeBlock 的简化实现）----------

/** 站在能交互的距离内；离得远就寻路走过去。 */
async function walkWithin(pos, range, desc) {
  if (pos.distanceTo(bot.entity.position) <= range) return;
  const { goals } = require("mineflayer-pathfinder");
  currentTask = desc;
  try {
    await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range - 1));
  } finally {
    currentTask = null;
  }
}

/** 在指定坐标放一个方块（需要背包里有该方块）。 */
async function placeBlockAt({ x, y, z, block }) {
  const Vec3 = require("vec3");
  const targetPos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
  const target = bot.blockAt(targetPos);
  if (!target || !["air", "cave_air", "water"].includes(target.name)) {
    throw new Error(`(${x},${y},${z}) 已被 ${target?.name ?? "未知"} 占据`);
  }
  // 找相邻实心方块当放置支撑面（六面里挑第一个）
  const dirs = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
  let ref = null;
  let face = null;
  for (const [dx, dy, dz] of dirs) {
    const b = bot.blockAt(targetPos.offset(dx, dy, dz));
    if (b && b.boundingBox === "block") {
      ref = b;
      face = new Vec3(-dx, -dy, -dz);
      break;
    }
  }
  if (!ref) throw new Error(`(${x},${y},${z}) 周围没有支撑面，悬空无法放置`);
  const item = bot.inventory.items().find((i) => i.name === String(block));
  if (!item) throw new Error(`背包里没有 ${block}`);
  await walkWithin(ref.position, 4, `走向 (${x},${y},${z})`);
  await bot.equip(item, "hand");
  await bot.placeBlock(ref, face);
  return `已在 (${targetPos.x},${targetPos.y},${targetPos.z}) 放置 ${block}`;
}

/** 挖掉指定坐标的方块。 */
async function breakBlockAt({ x, y, z }) {
  const Vec3 = require("vec3");
  const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
  const block = bot.blockAt(pos);
  if (!block || block.name === "air" || block.name === "cave_air") {
    throw new Error(`(${x},${y},${z}) 已经是空气`);
  }
  await walkWithin(pos, 4, `走向 (${x},${y},${z})`);
  await bot.dig(block);
  return `已挖掉 (${pos.x},${pos.y},${pos.z}) 的 ${block.name}`;
}

/** 自动建小屋：5x5 木板小屋（地板+墙+屋顶+门+火把），中心可指定。 */
async function buildShelter({ x, z }) {
  const Vec3 = require("vec3");
  const cx = Number.isFinite(Number(x)) ? Math.floor(Number(x)) : Math.floor(bot.entity.position.x);
  const cz = Number.isFinite(Number(z)) ? Math.floor(Number(z)) : Math.floor(bot.entity.position.z);
  // 地板层高度：取脚下位置向下取整（假设平地；逐格探测太慢）
  const floorY = Math.floor(bot.entity.position.y) - 1;

  // 材料检查：地板25 + 墙45 + 屋顶25 ≈ 95 块木板，1 门 1 火把
  const plankCount = bot.inventory.items()
    .filter((i) => i.name.endsWith("_planks"))
    .reduce((s, i) => s + i.count, 0);
  const doorItem = bot.inventory.items().find((i) => i.name.endsWith("_door"));
  const hasTorch = bot.inventory.items().some((i) => i.name === "torch");
  if (plankCount < 90 || !doorItem || !hasTorch) {
    throw new Error(
      `材料不足：需要约 95 个任意木板、1 个门、1 个火把；当前木板 ${plankCount}、` +
      `门 ${doorItem ? "有" : "无"}、火把 ${hasTorch ? "有" : "无"}。` +
      `可以先收集原木再合成木板（橡木原木 1 个 = 4 个橡木木板）`,
    );
  }

  const placed = [];
  const R = 2; // 5x5 半径
  // 1. 地板（中心格留给火把，其实也放木板，火把叠上去）
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      await placeIfAir(cx + dx, floorY, cz + dz, plankName(), placed);
    }
  }
  // 2. 墙：三层，门口留南面中间（z+R 一列的 y+1/y+2 空）
  for (let h = 1; h <= 3; h++) {
    for (let dx = -R; dx <= R; dx++) {
      for (const dz of [-R, R]) {
        if (dz === R && dx === 0 && h <= 2) continue; // 门口
        await placeIfAir(cx + dx, floorY + h, cz + dz, plankName(), placed);
      }
    }
    for (let dz2 = -R + 1; dz2 <= R - 1; dz2++) {
      for (const dx of [-R, R]) {
        await placeIfAir(cx + dx, floorY + h, cz + dz2, plankName(), placed);
      }
    }
  }
  // 3. 屋顶：走进屋中心再放（不然垂直够不到）
  const { goals } = require("mineflayer-pathfinder");
  await bot.pathfinder.goto(new goals.GoalNear(cx, floorY + 1, cz, 0)).catch(() => {});
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      await placeIfAir(cx + dx, floorY + 4, cz + dz, plankName(), placed);
    }
  }
  // 4. 门（南面中间，朝外放）
  const doorGround = bot.blockAt(new Vec3(cx, floorY, cz + R));
  await bot.equip(doorItem, "hand");
  await bot.placeBlock(doorGround, new Vec3(0, 1, 0));
  // 5. 屋内火把（中心地板上）
  const centerFloor = bot.blockAt(new Vec3(cx, floorY, cz));
  const torchItem = bot.inventory.items().find((i) => i.name === "torch");
  await bot.equip(torchItem, "hand");
  await bot.placeBlock(centerFloor, new Vec3(0, 1, 0));
  return `小屋建好了！中心 (${cx},${floorY},${cz})，用了 ${placed.length} 块木板，带门和火把`;
}

/** 内部辅助：目标格是空气才放，已占用就跳过（随地势容错）。 */
async function placeIfAir(x, y, z, blockName, placed) {
  const Vec3 = require("vec3");
  const pos = new Vec3(x, y, z);
  const b = bot.blockAt(pos);
  if (b && b.name !== "air" && b.name !== "cave_air") return;
  await placeBlockAt({ x, y, z, block: blockName });
  placed.push(`${x},${y},${z}`);
}

/** 取背包里数量最多的那种木板当建材。 */
function plankName() {
  const items = bot.inventory.items().filter((i) => i.name.endsWith("_planks"));
  items.sort((a, b) => b.count - a.count);
  return items[0]?.name ?? "oak_planks";
}

// ---------- 第二批技能：战斗/导航/农活/箱子/村民（参考 mindcraft 对应实现简化移植）----------

/** 便捷等待。 */
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** 装备背包里最好的近战武器（剑 > 斧 > 镐）。 */
async function equipBestWeaponLocal() {
  const items = bot.inventory.items();
  const weapon =
    items.find((i) => i.name.includes("sword")) ??
    items.find((i) => i.name.includes("axe")) ??
    items.find((i) => i.name.includes("pickaxe"));
  if (weapon) await bot.equip(weapon, "hand");
}

/** 攻击指定生物：追击 + 近战循环，直到目标死亡（kill=false 只打一下）。 */
async function attackNearest({ mob, kill }) {
  const name = String(mob ?? "").toLowerCase();
  if (!name) throw new Error("缺少生物 id 参数（英文，如 zombie、cow）");
  const target = bot.nearestEntity(
    (e) => e.name === name && e.position.distanceTo(bot.entity.position) < 24,
  );
  if (!target) throw new Error("附近 24 格内没有 " + name);
  const { goals } = require("mineflayer-pathfinder");
  await equipBestWeaponLocal();
  currentTask = "攻击 " + name;
  try {
    while (!skillAbort && bot.entities[target.id]) {
      const dist = target.position.distanceTo(bot.entity.position);
      if (dist > 3) {
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
        await sleepMs(300);
      } else {
        try { bot.pathfinder.stop(); } catch { /* 无目标时忽略 */ }
        await bot.lookAt(target.position.offset(0, 1, 0));
        try { await bot.attack(target); } catch { /* 目标消失等忽略 */ }
        await sleepMs(700);
      }
      if (!kill) break;
    }
    try { bot.pathfinder.stop(); } catch { /* 无目标时忽略 */ }
    if (!bot.entities[target.id]) {
      // 击杀后顺手捡战利品
      await pickupItems({ range: 8 });
      return "击杀了 " + name + "，顺手捡了掉落物";
    }
    return "已对 " + name + " 发起攻击";
  } finally {
    currentTask = null;
  }
}

/** 主动捡拾范围内的掉落物。 */
async function pickupItems({ range }) {
  const r = Math.min(Math.max(Number(range) || 8, 1), 32);
  const { goals } = require("mineflayer-pathfinder");
  const findNearest = () =>
    bot.nearestEntity(
      (e) => e.displayName === "Item" && e.position.distanceTo(bot.entity.position) < r,
    );
  let nearest = findNearest();
  let picked = 0;
  currentTask = "捡拾掉落物";
  try {
    while (nearest && !skillAbort) {
      try {
        await bot.pathfinder.goto(new goals.GoalFollow(nearest, 0.5));
      } catch { /* 单个捡不到就跳过 */ }
      await sleepMs(200);
      const prev = nearest;
      nearest = findNearest();
      if (prev === nearest) break; // 卡在同一个物品上拿不到，放弃
      picked++;
    }
  } finally {
    currentTask = null;
  }
  return picked > 0 ? "捡了 " + picked + " 处掉落物" : "附近没有可捡的掉落物";
}

/** 使用最近的门：开门 → 穿过 → 随手关上。 */
async function useDoorSkill({ x, y, z }) {
  const Vec3 = require("vec3");
  const { goals } = require("mineflayer-pathfinder");
  const mcData = require("minecraft-data")(bot.version);
  let doorPos = null;
  if (Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && Number.isFinite(Number(z))) {
    doorPos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
  } else {
    const doorIds = Object.values(mcData.blocks)
      .filter((b) => b.name.endsWith("_door"))
      .map((b) => b.id);
    const found = bot.findBlocks({ matching: doorIds, maxDistance: 16, count: 1 });
    if (found.length > 0) doorPos = found[0];
  }
  if (!doorPos) throw new Error("附近 16 格内没有门");
  currentTask = "开门";
  try {
    await bot.pathfinder.goto(new goals.GoalNear(doorPos.x, doorPos.y, doorPos.z, 1));
    const doorBlock = bot.blockAt(doorPos);
    if (!doorBlock) throw new Error("找不到门方块");
    await bot.lookAt(doorPos.offset(0.5, 0.5, 0.5));
    if (!doorBlock._properties?.open) await bot.activateBlock(doorBlock);
    // 向前迈一步穿过门
    bot.setControlState("forward", true);
    await sleepMs(600);
    bot.setControlState("forward", false);
    // 回手关门
    await bot.activateBlock(doorBlock).catch(() => {});
    return "开了一下门（穿过去并随手关上了）";
  } finally {
    currentTask = null;
  }
}

/** 找到最近的指定方块并走过去。 */
async function gotoBlockSkill({ block, range }) {
  const name = String(block ?? "").toLowerCase();
  if (!name) throw new Error("缺少方块 id 参数");
  const r = Math.min(Math.max(Number(range) || 64, 4), 128);
  const mcData = require("minecraft-data")(bot.version);
  const blockData = mcData.blocksByName[name];
  if (!blockData) throw new Error("未知方块 id: " + name);
  const positions = bot.findBlocks({ matching: blockData.id, maxDistance: r, count: 1 });
  if (positions.length === 0) throw new Error("周围 " + r + " 格内没有找到 " + name);
  const pos = positions[0];
  const { goals } = require("mineflayer-pathfinder");
  currentTask = "走向最近的 " + name;
  try {
    await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
  } finally {
    currentTask = null;
  }
  return "找到了 " + name + "，在 (" + pos.x + ", " + pos.y + ", " + pos.z + ")，已走到附近";
}

/** 向下挖指定格数（遇岩浆/水/大落差自动停，防摔防烧）。 */
async function digDownSkill({ distance }) {
  const d = Math.min(Math.max(Number(distance) || 1, 1), 32);
  const start = bot.blockAt(bot.entity.position).position;
  for (let i = 1; i <= d; i++) {
    if (skillAbort) return "已中止：向下挖了 " + (i - 1) + " 格";
    const target = bot.blockAt(start.offset(0, -i, 0));
    let below = bot.blockAt(start.offset(0, -i - 1, 0));
    if (!target || !below) return "挖了 " + (i - 1) + " 格，到世界底部了";
    if (["lava", "water"].includes(target.name) || ["lava", "water"].includes(below.name)) {
      return "挖了 " + (i - 1) + " 格就停了：下面是 " + below.name + "，太危险";
    }
    // 下方悬空超过 2 格就停，防止摔伤
    let fall = 0;
    let probe = below;
    while (fall <= 2 && probe && (probe.name === "air" || probe.name === "cave_air")) {
      fall++;
      probe = bot.blockAt(probe.position.offset(0, -1, 0));
    }
    if (fall > 2) return "挖了 " + (i - 1) + " 格就停了：下面落差太大";
    if (target.name === "air" || target.name === "cave_air") continue;
    try {
      await breakBlockAt({ x: target.position.x, y: target.position.y, z: target.position.z });
    } catch (err) {
      return "挖了 " + (i - 1) + " 格后卡住了：" + (err?.message ?? err);
    }
  }
  return "向下挖了 " + d + " 格，现在可以采矿了";
}

/** 回到当前位置正上方的地表。 */
async function goSurfaceSkill() {
  const Vec3 = require("vec3");
  const { goals } = require("mineflayer-pathfinder");
  const pos = bot.entity.position;
  for (let y = 319; y > -64; y--) {
    const block = bot.blockAt(new Vec3(Math.floor(pos.x), y, Math.floor(pos.z)));
    if (!block || block.name === "air" || block.name === "cave_air") continue;
    currentTask = "回到地表";
    try {
      await bot.pathfinder.goto(
        new goals.GoalNear(Math.floor(pos.x), y + 1, Math.floor(pos.z), 1),
      );
    } catch {
      return "找到地表在 y=" + (y + 1) + "，但走不过去（可能被封在洞里），可以试试向下挖或搭方块上去";
    } finally {
      currentTask = null;
    }
    return "回到地表了，坐标 (" + Math.floor(pos.x) + ", " + (y + 1) + ", " + Math.floor(pos.z) + ")";
  }
  throw new Error("找不到地表（区块未加载？）");
}

/** 原地等待：登记等待状态立即返回，到时自动解除；被移动/停止指令打断即失效。 */
function staySkill({ seconds }) {
  const s = Math.min(Math.max(Number(seconds) || 30, 5), 300);
  if (currentTask) throw new Error("现在正忙着（" + currentTask + "），等不了");
  if (stayTimer) clearTimeout(stayTimer);
  currentTask = "原地等待";
  stayTimer = setTimeout(() => {
    if (currentTask === "原地等待") currentTask = null;
    stayTimer = null;
  }, s * 1000);
  return "好，我原地等你 " + s + " 秒（期间不会乱跑，你叫我就会动）";
}

/** 丢掉指定物品（count 省略 = 全丢）。 */
async function discardSkill({ item, count }) {
  const name = String(item ?? "").toLowerCase();
  if (!name) throw new Error("缺少物品 id 参数");
  const num = Number(count) || -1;
  let discarded = 0;
  while (true) {
    const inv = bot.inventory.items().find((i) => i.name === name);
    if (!inv) break;
    const toDiscard = num === -1 ? inv.count : Math.min(num - discarded, inv.count);
    if (toDiscard <= 0) break;
    await bot.toss(inv.type, null, toDiscard);
    discarded += toDiscard;
    if (num !== -1 && discarded >= num) break;
  }
  if (discarded === 0) throw new Error("背包里没有 " + name + " 可丢");
  return "丢掉了 " + name + " x" + discarded;
}

/** 翻土并播种（y 是地面方块坐标；种子省略只翻土）。 */
async function tillSowSkill({ x, y, z, seed }) {
  const Vec3 = require("vec3");
  const pos = new Vec3(Math.floor(Number(x)), Math.floor(Number(y)), Math.floor(Number(z)));
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
    throw new Error("坐标参数不完整");
  }
  const block = bot.blockAt(pos);
  if (!block) throw new Error("该坐标区块未加载");
  if (!["grass_block", "dirt", "farmland"].includes(block.name)) {
    throw new Error(block.name + " 不能耕种，得是草方块或泥土");
  }
  // 上方有方块挡着就先挖掉
  const above = bot.blockAt(pos.offset(0, 1, 0));
  if (above && above.name !== "air" && above.name !== "cave_air") {
    if (block.name === "farmland") return "这块地已经耕好了";
    await breakBlockAt({ x: pos.x, y: pos.y + 1, z: pos.z });
  }
  if (bot.entity.position.distanceTo(block.position) > 4.5) {
    await walkWithin(block.position, 4, "走向耕地");
  }
  if (block.name !== "farmland") {
    const hoe = bot.inventory.items().find((i) => i.name.includes("hoe"));
    if (!hoe) throw new Error("背包里没有锄头（先合成一把，如 wooden_hoe）");
    await bot.equip(hoe, "hand");
    await bot.activateBlock(block);
  }
  let seedName = seed ? String(seed).toLowerCase() : null;
  if (seedName) {
    // 容错：说 wheat 不带 s 的常见口误
    if (seedName.endsWith("seed") && !seedName.endsWith("seeds")) seedName += "s";
    const seedItem = bot.inventory.items().find((i) => i.name === seedName);
    if (!seedItem) throw new Error("翻好土了，但背包里没有 " + seedName + "（小麦种子是 wheat_seeds）");
    await bot.equip(seedItem, "hand");
    await bot.activateBlock(bot.blockAt(pos));
  }
  return seedName
    ? "在 (" + pos.x + ", " + pos.y + ", " + pos.z + ") 翻土并种下了 " + seedName
    : "把 (" + pos.x + ", " + pos.y + ", " + pos.z + ") 翻成了耕地";
}

/** 拿工具对最近的实体或方块使用（工具传 hand 表示空手，目标传 nothing 表示对空气使用）。 */
async function useToolOnSkill({ tool, target }) {
  const toolName = String(tool ?? "").toLowerCase();
  const targetName = String(target ?? "").toLowerCase();
  if (!toolName) throw new Error("缺少工具参数");
  const { goals } = require("mineflayer-pathfinder");
  const equipTool = async () => {
    if (toolName === "hand") {
      await bot.unequip("hand");
      return;
    }
    const it = bot.inventory.items().find((i) => i.name === toolName);
    if (!it) throw new Error("背包里没有 " + toolName);
    await bot.equip(it, "hand");
  };
  // 对空气使用（右键手上的东西）
  if (!targetName || targetName === "nothing") {
    await equipTool();
    await bot.activateItem();
    return "使用了 " + toolName;
  }
  // 先找实体再找方块
  const entity = bot.nearestEntity(
    (e) => e.name === targetName && e.position.distanceTo(bot.entity.position) < 32,
  );
  if (entity) {
    if (bot.entity.position.distanceTo(entity.position) > 3) {
      await bot.pathfinder.goto(
        new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2),
      );
    }
    await equipTool();
    await bot.useOn(entity);
    return "对 " + targetName + " 使用了 " + toolName;
  }
  const mcData = require("minecraft-data")(bot.version);
  const blockData = mcData.blocksByName[targetName];
  if (!blockData) throw new Error("找不到 " + targetName + "（既不是附近的实体也不是已知方块）");
  const positions = bot.findBlocks({ matching: blockData.id, maxDistance: 32, count: 1 });
  if (positions.length === 0) throw new Error("附近 32 格内没有 " + targetName);
  const block = bot.blockAt(positions[0]);
  await walkWithin(block.position, 4, "走向 " + targetName);
  await equipTool();
  await bot.activateBlock(block);
  return "对 " + targetName + " 使用了 " + toolName;
}

/** 找最近的箱子/木桶并走到跟前，返回打开的容器。 */
async function openNearestChest() {
  const mcData = require("minecraft-data")(bot.version);
  const ids = ["chest", "trapped_chest", "barrel"]
    .map((n) => mcData.blocksByName[n]?.id)
    .filter((id) => id != null);
  const positions = bot.findBlocks({ matching: ids, maxDistance: 32, count: 1 });
  if (positions.length === 0) throw new Error("附近 32 格内没有箱子或木桶");
  const block = bot.blockAt(positions[0]);
  await walkWithin(block.position, 3, "走向箱子");
  return await bot.openContainer(block);
}

/** 把物品存进最近的箱子。 */
async function chestPutSkill({ item, count }) {
  const name = String(item ?? "").toLowerCase();
  if (!name) throw new Error("缺少物品 id 参数");
  const num = Number(count) || -1;
  const container = await openNearestChest();
  try {
    const inv = bot.inventory.items().find((i) => i.name === name);
    if (!inv) throw new Error("背包里没有 " + name);
    const toPut = num === -1 ? inv.count : Math.min(num, inv.count);
    await container.deposit(inv.type, null, toPut);
    return "往箱子里存了 " + name + " x" + toPut;
  } finally {
    container.close();
  }
}

/** 从最近的箱子取物品（可跨槽位凑数）。 */
async function chestTakeSkill({ item, count }) {
  const name = String(item ?? "").toLowerCase();
  if (!name) throw new Error("缺少物品 id 参数");
  const num = Number(count) || -1;
  const container = await openNearestChest();
  try {
    const matching = container.containerItems().filter((i) => i.name === name);
    if (matching.length === 0) throw new Error("箱子里没有 " + name);
    const total = matching.reduce((s, i) => s + i.count, 0);
    let remaining = num === -1 ? total : Math.min(num, total);
    let taken = 0;
    for (const it of matching) {
      if (remaining <= 0) break;
      const toTake = Math.min(remaining, it.count);
      await container.withdraw(it.type, null, toTake);
      taken += toTake;
      remaining -= toTake;
    }
    return "从箱子里取了 " + name + " x" + taken;
  } finally {
    container.close();
  }
}

/** 查看最近箱子的内容（同名合并显示）。 */
async function chestViewSkill() {
  const container = await openNearestChest();
  try {
    const items = container.containerItems();
    if (items.length === 0) return "箱子是空的";
    const merged = new Map();
    for (const it of items) merged.set(it.name, (merged.get(it.name) ?? 0) + it.count);
    return "箱子里有：" + [...merged.entries()].map(([n, c2]) => n + " x" + c2).join("、");
  } finally {
    container.close();
  }
}

/** 激活最近的指定方块（按钮/拉杆等可交互方块）。 */
async function activateBlockSkill({ block }) {
  const name = String(block ?? "").toLowerCase();
  if (!name) throw new Error("缺少方块 id 参数");
  const mcData = require("minecraft-data")(bot.version);
  const blockData = mcData.blocksByName[name];
  if (!blockData) throw new Error("未知方块 id: " + name);
  const positions = bot.findBlocks({ matching: blockData.id, maxDistance: 16, count: 1 });
  if (positions.length === 0) throw new Error("附近 16 格内没有 " + name);
  const target = bot.blockAt(positions[0]);
  await walkWithin(target.position, 4, "走向 " + name);
  await bot.activateBlock(target);
  return "激活了 " + name + "（在 " + target.position.x + ", " + target.position.y + ", " + target.position.z + "）";
}

/** 找村民并走到跟前：带 id 找指定，不带找最近的。 */
async function reachVillager(id) {
  let entity = null;
  if (id != null && String(id).trim() !== "") {
    entity = bot.entities[String(id)] ?? bot.entities[Number(id)] ?? null;
    if (entity && entity.name !== "villager") throw new Error("该 id 不是村民");
  }
  if (!entity) {
    entity = bot.nearestEntity(
      (e) => e.name === "villager" && e.position.distanceTo(bot.entity.position) < 16,
    );
  }
  if (!entity) throw new Error("附近 16 格内没有村民（先找到村庄再说）");
  if (bot.entity.position.distanceTo(entity.position) > 3) {
    const { goals } = require("mineflayer-pathfinder");
    currentTask = "走向村民";
    try {
      await bot.pathfinder.goto(
        new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2),
      );
    } finally {
      currentTask = null;
    }
  }
  return entity;
}

/** 把单条交易格式化成一行文本。 */
function formatTrade(trade, idx) {
  const in1 = (trade.inputItem1?.count ?? 1) + "x " + (trade.inputItem1?.name ?? "?");
  const in2 = trade.inputItem2 ? " + " + trade.inputItem2.count + "x " + trade.inputItem2.name : "";
  const out = (trade.outputItem?.count ?? 1) + "x " + (trade.outputItem?.name ?? "?");
  return (idx + 1) + ": " + in1 + in2 + " → " + out + (trade.disabled ? "（暂不可用）" : "");
}

/** 查看村民交易列表（不带 id 看最近的）。 */
async function villagerTradesSkill({ id }) {
  const entity = await reachVillager(id);
  const villager = await bot.openVillager(entity);
  try {
    if (!villager.trades || villager.trades.length === 0) {
      return "这个村民没有可交易的项目（可能是小孩、无业或在睡觉）";
    }
    const list = villager.trades.map((t, i) => formatTrade(t, i)).join("；");
    return "村民（id " + entity.id + "）的交易：" + list + "。要交易按序号选";
  } finally {
    villager.close();
  }
}

/** 与村民执行交易（序号从 1 开始）。 */
async function villagerTradeSkill({ id, index, count }) {
  const idx = Number(index);
  if (!Number.isFinite(idx) || idx < 1) throw new Error("交易序号从 1 开始");
  const times = Math.min(Math.max(Number(count) || 1, 1), 16);
  const entity = await reachVillager(id);
  const villager = await bot.openVillager(entity);
  try {
    if (!villager.trades || villager.trades.length === 0) {
      throw new Error("这个村民没有可交易的项目");
    }
    const trade = villager.trades[idx - 1];
    if (!trade) throw new Error("没有第 " + idx + " 项交易，共有 " + villager.trades.length + " 项");
    if (trade.disabled) throw new Error("第 " + idx + " 项暂时不可用");
    await bot.trade(villager, idx - 1, times);
    return "完成了第 " + idx + " 项交易 x" + times + "：" + formatTrade(trade, idx - 1);
  } finally {
    villager.close();
  }
}

/** 宿主主动退出：断开连接并尽快退出进程。 */
function shutdown() {
  if (invTimer) {
    clearInterval(invTimer);
    invTimer = null;
  }
  if (bot) {
    try { bot.quit(); } catch { /* 连接已断开时退出会抛错，忽略即可 */ }
    bot = null;
  }
  // 留 300ms 让 stdout 缓冲落盘再退出
  setTimeout(() => process.exit(0), 300);
}

/** 长任务技能的统一包装：执行 → 成功/失败回 resp，同时清 currentTask。 */
async function runSkill(msg, fn) {
  if (!bot) {
    send({ type: "resp", reqId: msg.reqId, ok: false, error: "机器人未连接" });
    return;
  }
  skillAbort = false;
  try {
    const result = await fn(msg);
    send({ type: "resp", reqId: msg.reqId, ok: true, data: String(result) });
  } catch (err) {
    send({ type: "resp", reqId: msg.reqId, ok: false, error: err?.message ?? String(err) });
  } finally {
    currentTask = null;
  }
}

// stdin 逐行读取宿主指令
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    log(`无法解析宿主消息: ${trimmed.slice(0, 100)}`);
    return;
  }
  try {
    if (msg.type === "connect") {
      connect(msg);
    } else if (msg.type === "say") {
      if (!bot) {
        send({ type: "say_result", ok: false, error: "机器人未连接" });
      } else {
        bot.chat(String(msg.message ?? ""));
        send({ type: "say_result", ok: true });
      }
    } else if (msg.type === "move_to") {
      moveTo(msg);
    } else if (msg.type === "follow") {
      follow(msg);
    } else if (msg.type === "stop") {
      stopTask("用户停止");
    } else if (msg.type === "collect") {
      void collect(msg);
    } else if (msg.type === "inventory") {
      inventory(msg);
    } else if (msg.type === "players") {
      players(msg);
    } else if (msg.type === "consume") {
      void runSkill(msg, consumeFood);
    } else if (msg.type === "equip") {
      void runSkill(msg, equipItem);
    } else if (msg.type === "give") {
      void runSkill(msg, giveItem);
    } else if (msg.type === "sleep") {
      void runSkill(msg, sleepInBed);
    } else if (msg.type === "craft") {
      void runSkill(msg, craftItem);
    } else if (msg.type === "smelt") {
      void runSkill(msg, smeltItem);
    } else if (msg.type === "place") {
      void runSkill(msg, placeBlockAt);
    } else if (msg.type === "break") {
      void runSkill(msg, breakBlockAt);
    } else if (msg.type === "build_shelter") {
      void runSkill(msg, buildShelter);
    } else if (msg.type === "attack") {
      void runSkill(msg, attackNearest);
    } else if (msg.type === "pickup") {
      void runSkill(msg, pickupItems);
    } else if (msg.type === "use_door") {
      void runSkill(msg, useDoorSkill);
    } else if (msg.type === "goto_block") {
      void runSkill(msg, gotoBlockSkill);
    } else if (msg.type === "dig_down") {
      void runSkill(msg, digDownSkill);
    } else if (msg.type === "go_surface") {
      void runSkill(msg, goSurfaceSkill);
    } else if (msg.type === "stay") {
      void runSkill(msg, staySkill);
    } else if (msg.type === "discard") {
      void runSkill(msg, discardSkill);
    } else if (msg.type === "till_sow") {
      void runSkill(msg, tillSowSkill);
    } else if (msg.type === "use_tool_on") {
      void runSkill(msg, useToolOnSkill);
    } else if (msg.type === "chest_put") {
      void runSkill(msg, chestPutSkill);
    } else if (msg.type === "chest_take") {
      void runSkill(msg, chestTakeSkill);
    } else if (msg.type === "chest_view") {
      void runSkill(msg, chestViewSkill);
    } else if (msg.type === "activate_block") {
      void runSkill(msg, activateBlockSkill);
    } else if (msg.type === "villager_trades") {
      void runSkill(msg, villagerTradesSkill);
    } else if (msg.type === "villager_trade") {
      void runSkill(msg, villagerTradeSkill);
    } else if (msg.type === "set_cowardice") {
      // 胆小人格开关：modes 实例常驻，断线重连后设置仍生效
      modes.setCowardice(msg.enabled);
      send({ type: "resp", reqId: msg.reqId, ok: true, data: msg.enabled ? "胆小模式已开启：见怪就逃，不再反击" : "胆小模式已关闭：被攻击会反击" });
    } else if (msg.type === "shutdown") {
      shutdown();
    } else {
      log(`未知指令类型: ${msg.type}`);
    }
  } catch (err) {
    log(`处理指令出错: ${err?.message ?? err}`);
  }
});

// 宿主进程死亡会关闭 stdin，此时机器人也一并退出，不留孤儿进程
lines.on("close", () => shutdown());