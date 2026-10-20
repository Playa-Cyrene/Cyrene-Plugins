"use strict";

/**
 * 技能编译器（L1 里层核心）
 *
 * 输入：一段成功的工具调用轨迹（episode）
 * 输出：可复用的技能，或 null（说明这段轨迹不值得编译）
 *
 * 编译规则（从保守到激进）：
 *   1. 只保留幂等、可重复执行的命令，排除查询/会话类（scan/status/players…）
 *   2. 连续重复的同 cmd + 同参数 → 合并成循环，重复次数抽成 count 参数
 *   3. 只出现一次的数值参数（坐标、距离）→ 相对化或去掉，避免绑死某个位置
 *   4. 编译不出至少一步 → 返回 null，不硬造
 *
 * 设计纪律：宁可少编，不可乱编。
 * 技能一旦被误用是在真实世界里执行动作，失败代价比多一次 LLM 调用高得多。
 */

/** 这些命令只读或只影响会话，不该进技能（技能要能改变世界或推动任务） */
const NON_ACTIONABLE = new Set([
  "status",
  "ping",
  "lan",
  "sessions",
  "capabilities",
  "context",
  "players",
  "entities",
  "scan",
  "map",
  "height",
  "inventory",
  "events",
  "rules",
  "admin",
  "diag",
  "accounts",
  "config",
  "watch",
  "express",
  "fs",
  "image",
  "connect",
  "disconnect",
  "say",
  "skill",
  "instincts",
  "stop",
  // sequence 是执行包装器，不是动作本身。真正的动作应该已经被 trace 摊平；
  // 万一还有残留的嵌套 sequence，编成技能只会包装套包装，跑起来等于没编。
  "sequence",
]);

/** 命令到中文描述，编译时生成技能说明用 */
const CMD_LABEL = {
  collect: "采集",
  dig: "挖掘",
  build: "建造",
  move: "移动",
  act: "动作",
  give: "给予",
  attack: "攻击",
  smelt: "熔炼",
  craft: "合成",
  pickup: "捡拾",
  command: "指令",
  sequence: "序列",
  place: "放置",
  drop: "丢弃",
  equip: "装备",
  eat: "进食",
  sleep: "睡觉",
  use: "使用",
  jump: "跳跃",
  sneak: "潜行",
  set_instincts: "本能设置",
};

/** 数值参数里，哪些是「位置相关」的，编译时要小心 */
const POSITION_KEYS = new Set(["x", "y", "z", "radius", "range", "maxDistance"]);

/**
 * 意图层生成器。
 * 技能存的是「怎么做」（steps），意图层记的是「想做什么」（Grounding）。
 * 失败时靠它区分「意图不成立」和「参数不合理」——这两件事的处置方式完全不同。
 */
const { renderIntent, INTENT_VERB } = require("./skill-intent.cjs");

/**
 * 采集类命令的搜索半径上限。
 *
 * 调用方常为了「先确认有这东西」把 radius 开得很大（48、128），
 * 但技能是要反复执行的：半径一大，每次都要去很远的方块那里，
 * 实测把一次 3.9 秒的采集拖成 44.9 秒。
 *
 * 所以编译时把半径收进这个范围；原值本来就小就保留原值。
 */
const SEARCH_RADIUS_COMMANDS = new Set(["collect", "dig", "scan", "attack", "pickup"]);
const MAX_SEARCH_RADIUS = 16;

/** 参数键 → 参数名（供 count 合并时使用） */
const COUNT_KEYS = ["count", "amount", "times"];

/**
 * 意图动词 → 中文同义词。
 *
 * 反射层要在模型之前匹配玩家的话，玩家说的是「砍点木头」，
 * 技能里存的是 Mine oak_log，中间必须有一层语言桥。
 * 这里只收常用说法，宁可少收，也不要把宽泛动词塞进来造成误触发。
 */
const VERB_SYNONYMS = {
  Mine: ["挖", "采集", "砍", "开采", "挖矿"],
  Place: ["放置", "建造", "盖"],
  Craft: ["合成", "制作", "做"],
  Approach: ["过去", "靠近", "前往"],
  Pick: ["捡", "拾取"],
  Give: ["给", "交给"],
  Kill: ["攻击", "打"],
  Smelt: ["熔炼", "烧"],
  Use: ["使用"],
  Equip: ["装备", "穿上"],
  Eat: ["吃", "进食"],
  Sleep: ["睡觉"],
  Drop: ["丢", "扔掉"],
  Jump: ["跳跃"],
  Sneak: ["潜行"],
  Command: ["指令"],
};

/**
 * 常见目标的中文别名。
 *
 * 只列真正高频、玩家真会挂在嘴边的说法。
 * 后缀规则（_log / _planks / _ore）在 expandTargetAliases 里统一处理，
 * 免得为一堆木头各写一行。
 */
const TARGET_ALIASES = {
  oak_log: ["橡木", "木头", "原木", "树"],
  spruce_log: ["云杉木", "木头", "原木", "树"],
  birch_log: ["白桦木", "木头", "原木", "树"],
  jungle_log: ["丛林木", "木头", "原木", "树"],
  acacia_log: ["金合欢木", "木头", "原木", "树"],
  dark_oak_log: ["深色橡木", "木头", "原木", "树"],
  mangrove_log: ["红树木", "木头", "原木", "树"],
  cherry_log: ["樱花木", "木头", "原木", "树"],
  stone: ["石头", "石料"],
  cobblestone: ["圆石"],
  deepslate: ["深板岩"],
  dirt: ["泥土"],
  sand: ["沙子"],
  gravel: ["砂砾"],
  iron_ore: ["铁矿", "铁矿石"],
  coal_ore: ["煤矿", "煤炭"],
  copper_ore: ["铜矿"],
  gold_ore: ["金矿"],
  diamond_ore: ["钻石", "钻石矿"],
  crafting_table: ["工作台", "合成台"],
  furnace: ["熔炉"],
  chest: ["箱子"],
  wheat: ["小麦"],
  carrot: ["胡萝卜"],
  potato: ["土豆", "马铃薯"],
  water: ["水"],
  lava: ["岩浆"],
};

/** 触发签名的硬上限，和 skill-store 保持一致 */
const TRIGGER_LIMITS = {
  words: 20,
  regex: 5,
  wordChars: 20,
};

/** 中文描述里没有分词库，按这些虚词/代词切开，剩下的就是实词 */
const STOP_WORD_RE =
  /(?:帮我|帮忙|一个|一下|一些|几个|然后|接着|还是|可以|能不能|想要|的|了|和|与|把|在|就|都|也|又|请|要|想|去|来|得|是|有|没|不|别|再|还|很|太|个|些|点|我|你|他|她|它|这|那)/;

/** 触发词里不该出现的纯虚词 */
const PURE_STOP_WORDS = new Set([
  "帮我",
  "帮忙",
  "一个",
  "一下",
  "一些",
  "几个",
  "然后",
  "接着",
  "可以",
  "想要",
]);

/**
 * 把目标 id 展开成中文别名。
 * 后缀规则覆盖木头/木板/矿石/羊毛/种子这些成片的方块族。
 */
function expandTargetAliases(target) {
  const w = String(target || "").toLowerCase();
  if (!w) return [];

  const out = [];
  if (TARGET_ALIASES[w]) out.push(...TARGET_ALIASES[w]);

  if (w.endsWith("_log") || w.endsWith("_stem")) out.push("木头", "原木", "树");
  if (w.endsWith("_planks")) out.push("木板");
  if (w.endsWith("_ore")) out.push("矿石", "矿");
  if (w.endsWith("_wool")) out.push("羊毛");
  if (w.endsWith("_seeds")) out.push("种子");

  return out;
}

/** 从 steps 里取可作为触发词的目标值 */
function targetsOfSteps(steps) {
  const out = [];
  for (const step of Array.isArray(steps) ? steps : []) {
    const args = step && step.args;
    if (!args || typeof args !== "object") continue;

    // command 故意不取：它是对外发声/执行指令的入口，
    // 不该因为技能里出现过一次 /msg 就让「msg」变成触发词。
    for (const key of ["block", "item", "action", "shape", "player"]) {
      const v = args[key];
      if (typeof v === "string" && v && v.length <= TRIGGER_LIMITS.wordChars) {
        out.push(v.toLowerCase());
      }
    }
  }
  return out;
}

/** 从意图层里认出动词，映射成中文同义词 */
function verbsOfIntent(intent) {
  const text = String(intent || "");
  if (!text) return [];

  const out = [];
  for (const [verb, synonyms] of Object.entries(VERB_SYNONYMS)) {
    if (new RegExp(`\\b${verb}\\b`).test(text)) out.push(...synonyms);
  }
  return out;
}

/**
 * 从命令本身映射动词同义词。
 *
 * 不能只靠意图层：旧技能可能没有 intent，手工 save 的技能也常常不填。
 * collect 本身就意味着「采集/砍/挖」，这层映射比意图更稳定。
 */
function verbsOfSteps(steps) {
  const out = [];
  for (const step of Array.isArray(steps) ? steps : []) {
    const verb = INTENT_VERB[step && step.cmd];
    if (verb && VERB_SYNONYMS[verb]) out.push(...VERB_SYNONYMS[verb]);
  }
  return out;
}

/**
 * 从描述里抽中文实词。
 * 没有分词库，就按标点和虚词切——够反射层用，也不需要额外依赖。
 */
function wordsOfDescription(description) {
  const text = String(description || "");
  if (!text) return [];

  const out = [];
  // 只保留中英文数字下划线，其余一律当分隔符
  for (const chunk of text.split(/[^\u4e00-\u9fa5A-Za-z0-9_]+/)) {
    if (!chunk) continue;

    for (const part of chunk.split(STOP_WORD_RE)) {
      const w = part.trim();
      if (!w || w.length < 2 || w.length > TRIGGER_LIMITS.wordChars) continue;
      if (PURE_STOP_WORDS.has(w)) continue;
      if (!/[\u4e00-\u9fa5A-Za-z]/.test(w)) continue;
      out.push(/^[A-Za-z0-9_]+$/.test(w) ? w.toLowerCase() : w);
    }
  }
  return out;
}

/**
 * 提取技能的触发签名。
 *
 * 触发词是反射层的唯一入口：玩家的话命中这些词，才可能不经过模型直接执行。
 * 所以这里的原则和编译器一致——宁可少给，不可乱给。
 * 泛词（例如单独的「树」「挖」）由匹配器按长度加权压分，不在这里删，
 * 否则「砍树」这种短指令会彻底失配。
 *
 * @param {Array} steps 技能步骤
 * @param {string} [description] 技能描述
 * @param {string|null} [intent] 意图层文本（renderIntent 的结果）
 * @returns {{words:string[], regex:string[], context:object}}
 */
function extractTriggers(steps, description, intent) {
  const raw = [];

  // 先放目标与别名：它们最能说明「这个技能对什么生效」
  for (const target of targetsOfSteps(steps)) {
    raw.push(target);
    raw.push(...expandTargetAliases(target));
  }

  // 再加动词同义词与描述里的实词。
  // 命令本身的映射放最前面：它不依赖 intent 是否存在，旧技能也能拿到「砍」。
  raw.push(...verbsOfSteps(steps));
  raw.push(...verbsOfIntent(intent));
  raw.push(...wordsOfDescription(description));

  const seen = new Set();
  const words = [];
  for (const item of raw) {
    const w = String(item || "").trim();
    if (!w || w.length > TRIGGER_LIMITS.wordChars) continue;
    if (!/[\u4e00-\u9fa5A-Za-z0-9_]/.test(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    words.push(w);
    if (words.length >= TRIGGER_LIMITS.words) break;
  }

  return { words, regex: [], context: {} };
}

/**
 * trace 压缩超深结构时留下的占位符。
 * 例如 "[deep]"、"[12 items]"、"[/9 chars]" 这类。
 *
 * 这些不是真实参数值。如果原样编进技能，技能跑起来会把 "[deep]" 当成方块 id
 * 或数量传给运行时，一定失败。与其编一个必然坏掉的技能，不如不编。
 */
const PLACEHOLDER_RE = /^\[(deep|\d+\s*(items|chars))\]$/i;

/** 判断某个参数值是否是 trace 留下的占位符 */
function isPlaceholder(value) {
  return typeof value === "string" && PLACEHOLDER_RE.test(value.trim());
}

/**
 * 命令执行完之后的固定缓冲（毫秒）。
 *
 * 这是「做完这个动作，物理世界还需要一点时间稳定」的经验值，
 * 不是「这个动作要花多久」。后者由命令自己内部的等待负责，
 * 写进 wait 只会让技能在已完成的工作上再白等一遍。
 *
 * 没有列在这里的命令不加 wait（它们要么瞬时完成，要么自带等待）。
 */
const SETTLE_MS = {
  dig: 200, // 方块破坏后掉落物要飞一下
  place: 200, // 放置后客户端要同步方块状态
  build: 300, // 连续放置之间留一点余地
  act: 150, // 吃东西 / 装备之类
  give: 200, // 物品扔出去后要落地
  drop: 150,
};

/** 深拷贝，避免共享引用 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 把数值钳到区间内 */
function clampTo(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/** 判断两个参数对象是否等价（键值浅比较，数组/对象走序列化） */
function sameArgs(a, b) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  if (ka.length !== kb.length) return false;
  if (ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

/**
 * 从一次工具调用里提取「主对象」——最关键的那个参数。
 * 比如 collect 的 block、build 的 block、act 的 action。
 */
function primaryObject(args) {
  if (!args || typeof args !== "object") return null;
  for (const key of ["block", "item", "action", "shape", "player", "command"]) {
    if (typeof args[key] === "string" && args[key]) return { key, value: args[key] };
  }
  return null;
}

/**
 * 编译一段轨迹。
 *
 * @param {Array<object>} episode 成功轨迹（trace 记录数组）
 * @param {object} opts
 * @param {string} opts.name 技能名（调用方保证合法）
 * @param {string} [opts.description] 自定义描述
 * @returns {object|null} 技能对象，或 null 表示不值得编译
 */
function compileEpisode(episode, opts = {}) {
  if (!Array.isArray(episode) || !episode.length) return null;

  // 1. 过滤掉不可复用命令
  const usable = episode.filter((row) => {
    if (!row || typeof row.tool !== "string") return false;
    if (row.origin === "skill") return false;
    if (!row.ok) return false;
    if (NON_ACTIONABLE.has(row.tool)) return false;
    return true;
  });

  if (!usable.length) return null;

  // 2. 合并连续重复的同命令
  /** @type {Array<{cmd:string,args:object,repeat:number,waits:number[]}>} */
  const merged = [];
  for (const row of usable) {
    const args = clone(row.args && typeof row.args === "object" ? row.args : {});
    const last = merged[merged.length - 1];

    if (last && last.cmd === row.tool && sameArgs(last.args, args)) {
      last.repeat += 1;
    } else {
      merged.push({ cmd: row.tool, args, repeat: 1 });
    }
  }

  // 3. 生成参数化步骤
  const params = {};
  const steps = [];

  for (const m of merged) {
    const stepArgs = clone(m.args);

    // 参数里带 trace 占位符（[deep] / [12 items] 之类）→ 这段轨迹信息不全，
    // 编出来的技能必然跑不通。宁可返回 null，也不产出注定失败的技能。
    if (Object.values(stepArgs).some(isPlaceholder)) {
      return null;
    }

    // 位置类参数不进技能：换个地方就失效，还容易把角色带偏
    for (const key of Object.keys(stepArgs)) {
      if (POSITION_KEYS.has(key) && m.cmd === "move") delete stepArgs[key];
    }

    // 搜索半径收紧：技能要能在原地附近跑完，不能每次都去 48 格外那棵树
    if (SEARCH_RADIUS_COMMANDS.has(m.cmd)) {
      const r = Number(stepArgs.radius);
      if (Number.isFinite(r) && r > MAX_SEARCH_RADIUS) stepArgs.radius = MAX_SEARCH_RADIUS;
    }

    // 必达距离：技能里显式写死「目标超过这么远就别去」。
    // 这是长尾的直接来源——半径 16 的目标可能要走很久，收益却一样。
    // 技能是重复执行的，必须自己带上这条界线，不能靠调用方每次记得传。
    if (SEARCH_RADIUS_COMMANDS.has(m.cmd) && "block" in stepArgs) {
      const r = Number(stepArgs.radius);
      const effectiveRadius = Number.isFinite(r) ? r : MAX_SEARCH_RADIUS;
      const maxDistance = Math.min(effectiveRadius, MAX_SEARCH_RADIUS);
      stepArgs.maxDistance = clampTo(Number(stepArgs.maxDistance) || maxDistance, 2, 128);
    }

    // 重复多次 → 抽成 count 参数
    if (m.repeat > 1) {
      const countKey = COUNT_KEYS.find((k) => k in stepArgs) || "count";
      // 如果原来就有 count 且与重复次数一致，说明是同一个语义，直接参数化
      const originalCount = Number(stepArgs[countKey]);
      const effective = Number.isFinite(originalCount) && originalCount > 0 ? originalCount : m.repeat;

      stepArgs[countKey] = `\${${countKey}}`;
      params[countKey] = {
        default: effective,
        min: 1,
        max: Math.max(64, effective * 4),
      };
    }

    const step = { cmd: m.cmd, args: stepArgs };

    // wait 的语义是「这一步做完后还要再等多久」，不是「这一步本身花了多久」。
    // 之前直接把工具调用的总耗时写进 wait，导致技能执行时在已经完成的工作上
    // 再白等一遍——实测让一次采集从 4.5 秒变成 15.8 秒。
    //
    // 正确做法：只对「动作完成后还需要缓冲」的命令给一个固定小间隔，
    // 剩下的时间交给命令自身内部的等待逻辑。
    const settle = SETTLE_MS[m.cmd];
    if (settle) step.wait = settle;

    steps.push(step);
  }

  if (!steps.length) return null;

  // 4. 生成描述与技能名建议
  const objects = merged
    .map((m) => primaryObject(m.args))
    .filter(Boolean)
    .map((o) => o.value);

  const verbs = merged.map((m) => CMD_LABEL[m.cmd] || m.cmd);
  const uniqueVerbs = [...new Set(verbs)];
  const uniqueObjects = [...new Set(objects)];

  const autoDesc =
    uniqueObjects.length > 0
      ? `${uniqueVerbs.join("+")} ${uniqueObjects.join("/")}`
      : uniqueVerbs.join("+");

  const description = opts.description || autoDesc;
  // 意图层：从 steps 推导，推不出就 null。不参与执行，只用于解释与归因。
  const intent = renderIntent(steps, params);

  return {
    description,
    level: 1,
    steps,
    params,
    intent,
    // 触发签名：反射层靠它把玩家的话对上技能，没有它就只能回去烧 token。
    triggers: extractTriggers(steps, description, intent),
    preconditions: buildPreconditions(merged),
    safety: {
      idempotent: false,
      whitelist: true,
      maxDurationMs: 30000,
    },
    source: {
      episodeLength: episode.length,
      usableLength: usable.length,
      compiledAt: new Date().toISOString(),
      commands: merged.map((m) => m.cmd),
    },
  };
}

/** 同一次「意图」：工具名相同、目标/物品/动作相同，允许 tool 参数不同。 */
function sameActionSubject(a, b) {
  if (!a || !b) return false;
  if (a.tool !== b.tool) return false;

  const aa = a.args && typeof a.args === "object" ? a.args : {};
  const bb = b.args && typeof b.args === "object" ? b.args : {};
  const keys = ["block", "item", "action", "shape", "player"];

  return keys.every((key) => {
    const av = aa[key];
    const bv = bb[key];
    if (av == null && bv == null) return true;
    return String(av) === String(bv);
  });
}

/** 失败和成功之间，哪些步骤算「修复证据」。 */
function lessonFixSteps(rows) {
  const out = [];
  for (const row of rows) {
    if (!row || !row.ok) continue;
    if (row.tool === "act" && row.args && row.args.action === "equip" && row.args.item) {
      out.push({
        cmd: "act",
        args: { action: "equip", item: String(row.args.item), destination: "hand" },
      });
      continue;
    }
    if (row.tool === "craft" && row.args && row.args.item) {
      out.push({ cmd: "craft", args: { ...row.args } });
      continue;
    }
    if (row.tool === "place" && row.args && row.args.block) {
      out.push({ cmd: "place", args: { ...row.args } });
    }
  }
  return out.slice(-3);
}

/**
 * 失败 → 纠正 → 成功 的经验编译器。
 *
 * 和 compileEpisode 的分工：
 *   compileEpisode 只编成功段，负责「已经会做」；
 *   compileLesson 编「上次为什么没做成、这次靠什么做成了」，负责「学会」。
 *
 * 纪律：没有成功、没有修复证据，就返回 null。宁可少编，不可乱编。
 */
function compileLesson(episode, opts = {}) {
  if (!Array.isArray(episode) || !episode.length) return null;

  for (let i = 0; i < episode.length; i += 1) {
    const failed = episode[i];
    if (!failed || failed.ok !== false || !failed.tool) continue;
    if (NON_ACTIONABLE.has(failed.tool)) continue;

    for (let j = i + 1; j < episode.length; j += 1) {
      const success = episode[j];
      if (!success || success.ok !== true) continue;
      if (!sameActionSubject(failed, success)) continue;

      const between = episode.slice(i + 1, j);
      const fixes = lessonFixSteps(between);
      const explicitTool = String((success.args && success.args.tool) || opts.tool || "").trim();

      // 没有修复步骤，也没有显式工具 → 这次成功不归因于「纠正」，不编。
      if (!fixes.length && !explicitTool) continue;

      const block =
        (success.args && (success.args.block || success.args.item)) ||
        (success.detail && success.detail.block) ||
        (success.data && success.data.block) ||
        (failed.args && (failed.args.block || failed.args.item)) ||
        (failed.detail && failed.detail.block) ||
        opts.block ||
        "";
      if (!block) continue;

      const tool =
        explicitTool ||
        (fixes.find((s) => s.cmd === "act" && s.args.action === "equip") || {}).args?.item ||
        "";
      if (!tool) continue;

      const count = Math.max(1, Number(opts.count) || Number(success.args && success.args.count) || 1);
      const steps = [
        ...fixes,
        {
          cmd: "collect",
          args: { block: String(block), count, tool },
        },
      ];

      return {
        name: opts.name || null,
        description:
          opts.description ||
          `吸取教训：${failed.tool} ${block} 失败后，先用 ${tool} 再采集`,
        level: 1,
        steps,
        params: {},
        intent: renderIntent(steps, {}),
        triggers: extractTriggers(steps, `${failed.tool} ${block}`),
        preconditions: {
          nearbyBlock: String(block),
          maxDistance: 16,
          requiresTool: tool,
        },
        safety: {
          idempotent: false,
          whitelist: true,
          maxDurationMs: 60000,
        },
        source: {
          kind: "lesson",
          episodeLength: episode.length,
          failed: {
            tool: failed.tool,
            args: failed.args && typeof failed.args === "object" ? { ...failed.args } : {},
            error: failed.error || null,
          },
          fixSteps: fixes,
          success: {
            tool: success.tool,
            args: success.args && typeof success.args === "object" ? { ...success.args } : {},
          },
          compiledAt: new Date().toISOString(),
        },
      };
    }
  }

  return null;
}

/** lesson 的技能名：mine_stone_with_wooden_pickaxe */
function suggestLessonName(lesson) {
  if (!lesson || !Array.isArray(lesson.steps) || !lesson.steps.length) return null;

  const last = lesson.steps[lesson.steps.length - 1];
  const block = last && last.args && String(last.args.block || "");
  const tool = last && last.args && String(last.args.tool || "");
  if (!block) return null;

  const verb = /_ore$|stone|deepslate|cobblestone/.test(block) ? "mine" : "collect";
  const name = `${verb}_${block}${tool ? `_with_${tool}` : ""}`;
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
}

/**
 * 从合并后的步骤推导前置条件。
 * 这一版只推导「背包缺少什么」这一种，够 L3 沉淀层用。
 */
function buildPreconditions(merged) {
  const pre = {};

  // collect/dig 的目标方块 → 附近需要有什么
  const collectStep = merged.find((m) => m.cmd === "collect");
  if (collectStep && typeof collectStep.args.block === "string") {
    pre.nearbyBlock = collectStep.args.block;
    pre.maxDistance = 16;
    pre.inventoryLacks = collectStep.args.block;
  }

  // build 需要背包里有方块
  const buildStep = merged.find((m) => m.cmd === "build");
  if (buildStep && typeof buildStep.args.block === "string") {
    pre.inventoryHas = buildStep.args.block;
  }

  pre.noPlayersWithin = 16;
  return pre;
}

/**
 * 按参数表给步骤填值。
 * 支持 args 里的 "${name}" 占位符。
 *
 * @param {Array} steps 技能步骤
 * @param {object} params 参数定义
 * @param {object} overrides 调用时传入的覆盖值
 * @returns {Array} 展开后的步骤（可直接交给 sequence）
 */
function resolveSteps(steps, params, overrides = {}) {
  const values = {};

  for (const [key, def] of Object.entries(params || {})) {
    let value = Number(overrides[key]);
    if (!Number.isFinite(value)) value = Number(def && def.default);
    if (!Number.isFinite(value)) value = 1;

    const min = Number(def && def.min);
    const max = Number(def && def.max);
    if (Number.isFinite(min)) value = Math.max(min, value);
    if (Number.isFinite(max)) value = Math.min(max, value);

    values[key] = value;
  }

  return (steps || []).map((step) => {
    const args = clone(step.args || {});

    for (const [key, val] of Object.entries(args)) {
      if (typeof val === "string" && val.startsWith("${") && val.endsWith("}")) {
        const paramName = val.slice(2, -1);
        args[key] = values[paramName] !== undefined ? values[paramName] : 1;
      }
    }

    const out = { cmd: step.cmd, args };
    if (typeof step.wait === "number" && step.wait > 0) out.wait = step.wait;
    return out;
  });
}

/**
 * 根据 episode 猜一个技能名。
 * 形如 chop_oak / collect_stone，猜不出返回 null。
 */
function suggestName(episode, opts = {}) {
  const compiled = compileEpisode(episode, opts);
  if (!compiled) return null;

  const steps = compiled.steps || [];
  const collect = steps.find((s) => s.cmd === "collect");
  if (collect && typeof collect.args.block === "string") {
    const block = collect.args.block.replace(/_log$/, "");
    return `chop_${block}`.slice(0, 48);
  }

  const build = steps.find((s) => s.cmd === "build");
  if (build && typeof build.args.block === "string") {
    return `build_${build.args.block}`.slice(0, 48);
  }

  const firstCmd = steps[0] ? steps[0].cmd : "do";
  const obj = primaryObject(steps[0] && steps[0].args);
  if (obj) return `${firstCmd}_${obj.value}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);

  return `${firstCmd}_skill`.slice(0, 48);
}

module.exports = {
  compileEpisode,
  resolveSteps,
  suggestName,
  buildPreconditions,
  compileLesson,
  suggestLessonName,
  extractTriggers,
  NON_ACTIONABLE,
  CMD_LABEL,
  VERB_SYNONYMS,
  TARGET_ALIASES,
  TRIGGER_LIMITS,
};
