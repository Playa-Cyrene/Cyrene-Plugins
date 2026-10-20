"use strict";

/**
 * 动态提示词 Provider：让昔涟每一轮都自然知道「我在游戏里是什么状态」，
 * 不用用户开口问。
 *
 * 设计纪律（很重要）：
 *   - 只写事实，不写指令。绝不出现「你应该……」「忽略之前的……」
 *   - 短而精。这个内容会进每一轮的 runtime context，写长了就是白烧 token
 *   - 没连服务器时返回空字符串，不占上下文
 *   - 全部计算在本地完成，不做任何网络请求，保证 2 秒配额内稳定返回
 */

/** 一轮能承受的上限；超过就截断背包这类次要信息 */
const MAX_CHARS = 1200;

/**
 * 把状态快照转成给模型看的一小段事实。
 *
 * @param {object} snapshot BotBridge.status() 的返回
 * @param {object} settings
 * @returns {string}
 */
function renderGameState(snapshot, settings = {}) {
  if (!snapshot || snapshot.state !== "connected" || !snapshot.online) return "";

  const lines = [];
  lines.push("【Minecraft 实时状态】");

  const who = snapshot.username ? `${snapshot.username}` : "你的角色";
  const where = snapshot.position
    ? `(${Math.round(snapshot.position.x)}, ${Math.round(snapshot.position.y)}, ${Math.round(snapshot.position.z)})`
    : "坐标未知";
  lines.push(`${who} 在线，坐标 ${where}${snapshot.dimension ? `，维度 ${snapshot.dimension}` : ""}`);

  // 血量和饥饿：只在偏低时特别提示，满血就不啰嗦
  const health = Number(snapshot.health);
  const food = Number(snapshot.food);
  if (Number.isFinite(health)) {
    if (health <= Number(settings.lowHealthThreshold || 6)) {
      lines.push(`⚠ 血量只剩 ${Math.round(health)}/20，很危险`);
    } else if (health < 20) {
      lines.push(`血量 ${Math.round(health)}/20`);
    }
  }
  if (Number.isFinite(food) && food < 20) {
    lines.push(`饥饿值 ${Math.round(food)}/20`);
  }

  // 最近受伤：要说清是什么伤，别让模型把摔落当成被攻击
  const dmg = snapshot.lastDamage;
  if (dmg && typeof dmg === "object" && Number.isFinite(Number(dmg.at))) {
    const age = Date.now() - Number(dmg.at);
    if (age >= 0 && age < 20_000) {
      const reasonText = {
        fall: "摔落",
        starve: "饥饿",
        drown: "溺水",
        lava: "岩浆",
        in_fire: "着火",
        on_fire: "被烧",
        cactus: "仙人掌",
        in_wall: "卡在方块里",
        freeze: "冰冻",
        lightning_bolt: "雷击",
        mob_attack: "生物攻击",
        mob_attack_no_aggro: "生物攻击",
        player_attack: "玩家攻击",
        arrow: "箭",
        fireball: "火球",
        explosion: "爆炸",
      }[dmg.reason];

      if (dmg.origin === "entity") {
        lines.push(`刚被攻击（${reasonText || dmg.reason || "未知来源"}），掉了 ${dmg.amount} 点血`);
      } else if (dmg.origin === "environment") {
        // 环境伤害不叫「被攻击」，否则模型会去找不存在的敌人
        lines.push(`刚受了环境伤害（${reasonText || dmg.reason || "未知"}），掉了 ${dmg.amount} 点血。没有敌人，别乱找`);
      } else {
        lines.push(`刚掉了 ${dmg.amount} 点血，来源不明`);
      }
    }
  }

  // 当前动作
  if (snapshot.currentTask) lines.push(`正在做：${snapshot.currentTask}`);

  // 本能层最近做了什么——让它知道自己刚才自动跑过/吃过
  if (snapshot.instinctLastAction && snapshot.instinctActionAgeMs != null && snapshot.instinctActionAgeMs < 20_000) {
    const actionText = {
      flee: "刚自己跑开躲避威胁",
      eat: "刚自己吃了点东西",
      hunt: "刚自己去打了猎",
      pickup: "刚自己捡了掉落物",
      torch: "刚自己插了火把",
      dodge: "刚自己躲开了头顶的落沙",
      drown: "刚自己往上游脱离溺水",
      suffocate: "刚自己挖开了堵住头部的方块",
    }[snapshot.instinctLastAction];
    if (actionText) lines.push(`本能动作：${actionText}`);
  }

  // 自主驱动：让她知道自己刚才在做什么，避免模型重复下令
  const auto = snapshot.autoplay;
  if (auto && auto.running) {
    const age = auto.lastActionAt ? Math.max(0, Date.now() - auto.lastActionAt) : null;
    if (auto.lastAction && age != null && age < 30_000) {
      lines.push(
        `自主动作：刚自己执行了 ${auto.lastAction}（${Math.round(age / 1000)} 秒前，累计 ${auto.steps || 0} 步）`,
      );
    } else {
      lines.push(`自主状态：正在自己找下一步（累计 ${auto.steps || 0} 步）`);
    }
  }

  // 路线记忆：让她知道自己有没有可复用的走法
  const routes = snapshot.routes;
  if (routes && routes.routes > 0) {
    const recall = routes.stats && routes.stats.recall ? routes.stats.recall : 0;
    const hit = routes.stats && routes.stats.hit ? routes.stats.hit : 0;
    const rate = recall ? Math.round((hit / recall) * 100) : 0;
    lines.push(`路线记忆：${routes.routes} 条可复用（命中率 ${rate}%）`);
  }

  // 背包：只列前 8 种，避免长清单吃掉预算
  const inventory = Array.isArray(snapshot.inventory) ? snapshot.inventory : [];
  if (inventory.length) {
    const merged = new Map();
    for (const item of inventory) {
      const name = item && item.name;
      if (!name) continue;
      merged.set(name, (merged.get(name) || 0) + (Number(item.count) || 1));
    }
    const parts = [];
    let shown = 0;
    for (const [name, count] of merged) {
      if (shown >= 8) break;
      parts.push(count > 1 ? `${name}×${count}` : name);
      shown += 1;
    }
    const more = merged.size > shown ? `（另有 ${merged.size - shown} 种）` : "";
    lines.push(`背包：${parts.join("、")}${more}`);
  } else {
    lines.push("背包：空");
  }

  // 附近玩家（不含自己）
  const players = Array.isArray(snapshot.players) ? snapshot.players : [];
  const others = players.filter((p) => p && !p.isSelf && p.username);
  if (others.length) {
    lines.push(`在线玩家：${others.slice(0, 6).map((p) => p.username).join("、")}`);
  }

  // 最近的游戏聊天，让模型知道刚才发生了什么
  const recent = Array.isArray(snapshot.recentChat) ? snapshot.recentChat.slice(-4) : [];
  if (recent.length) {
    lines.push("最近游戏聊天：");
    for (const c of recent) {
      const text = String(c.message || "").slice(0, 120);
      if (!text) continue;
      lines.push(c.player ? `  ${c.player}: ${text}` : `  ${text}`);
    }
  }

  // 错误信息也要让模型知道，否则它会以为什么都正常
  if (snapshot.lastError) lines.push(`最近错误：${String(snapshot.lastError).slice(0, 200)}`);

  let text = lines.join("\n");
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + "\n（已截断）";
  return text;
}

/**
 * 构造 provider 定义，交给 ctx.registerPromptProvider。
 *
 * @param {object} opts
 * @param {() => object} opts.getSnapshot
 * @param {() => object} opts.getSettings
 * @param {() => string} opts.getWakeHint  读未读事件摘要（可为空）
 * @param {() => string} [opts.getSkillIndex] 技能索引（可为空）
 */
function createPromptProvider(opts) {
  return {
    id: "game-state",
    // 只在这两种模式注入：聊天与工作。学习模式里让它安静点
    modes: ["chat", "work"],
    sources: ["conversation"],
    provide({ signal } = {}) {
      if (signal && signal.aborted) return "";

      try {
        const snapshot = opts.getSnapshot();
        const settings = opts.getSettings ? opts.getSettings() : {};

        let text = renderGameState(snapshot, settings);

        // 技能索引：即使没连服务器也值得告诉模型「有哪些现成技能」
        if (opts.getSkillIndex) {
          try {
            const idx = opts.getSkillIndex();
            if (idx) text = text ? `${text}\n${idx}` : idx;
          } catch {
            /* 技能索引失败不影响状态注入 */
          }
        }

        if (!text) return "";

        // 未读事件：让模型知道「刚才发生过什么」，即使它没被唤醒
        if (opts.getWakeHint) {
          const hint = opts.getWakeHint();
          if (hint) text += `\n${hint}`;
        }

        return text;
      } catch {
        // 任何异常都只跳过自己，绝不打断这一轮对话
        return "";
      }
    },
  };
}

module.exports = { createPromptProvider, renderGameState, MAX_CHARS };
