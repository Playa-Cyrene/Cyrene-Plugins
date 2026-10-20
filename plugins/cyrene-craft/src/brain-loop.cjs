"use strict";

/**
 * 执行环（Brain Loop）—— 把「建议下一步」变成真的下一步
 *
 * ── 它补的是哪一段 ────────────────────────────────────────────────
 * skill-graph 算完能量会给出 pick，但那一层刻意只建议不执行：
 * 直接执行会让调试变得极难 —— 你分不清是图算错了还是动作本身有问题。
 *
 * 中间这段空着的时候，pick 只能被格式化成一句话塞进 prompt，
 * 等模型看完再决定要不要动。一个来回，几秒钟，还未必照做。
 *
 * 这一层补上那几十行：拿 pick、清洗参数、调工具、看结果、再算下一步。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────
 * 1. **图只决定「做什么」，不决定「在哪里做」。**
 *    节点身份故意不含坐标（不然节点会爆炸），所以 node.args 里的 x/y/z
 *    是建图那一刻的快照。照着十分钟前的坐标去挖，挖到的只会是空气。
 *    凡是要实时位置的工具，一律跳过，不猜。
 *
 * 2. **世界状态每步重取。**
 *    跑到第三步背包空了，门禁得知道。开跑前拍一张快照用八次，
 *    等于闭着眼睛走完后半程。
 *
 * 3. **执行环自己不写轨迹。**
 *    它直接走 bridge，不经过工具的 trace 包装。图于是不会被自己的输出
 *    强化 —— 在边权还是从真实操作里学出来的时候，这一点很重要。
 *
 * ── 停止条件 ──────────────────────────────────────────────────────
 * 没有模型的回合里，失败没有下家可接，所以停得比人早一点：
 *   · 步数上限          默认 8 步（约 1～2 分钟）
 *   · 连续失败          默认 2 次
 *   · 分数停滞          默认连续 3 步不涨，说明扩散到头了
 *   · 候选全被挡住      硬门禁优先于能量，挡光了就没有下一步
 *   · 连接断开 / 停止请求
 */

const { nodeIdOf } = require("./skill-graph.cjs");

/** 坐标类参数：图里存的是旧值，执行前一律剥掉 */
const POSITIONAL_ARGS = new Set(["x", "y", "z"]);

/**
 * 必须有实时坐标才能执行的动作。
 * 图里只有旧坐标，照着执行就是对着空气挥镐。
 * 这些工具在执行环里跳过，交给上层拿着最新扫描结果来跑。
 */
const NEEDS_FRESH_POSITION = new Set(["dig", "place"]);

/**
 * 这些命令不该被自动连跑。
 * 它们要么改连接状态、要么对外发声、要么对自己的执行策略动手，
 * 都属于「跑一次就该停下来问人」的动作。
 */
const FORBIDDEN_TOOLS = new Set([
  "connect",
  "disconnect",
  "stop",
  "command",
  "say",
  "sequence",
  "config",
  "watch",
  "instincts",
  "express",
  "share",
  "lan",
  "ping",
]);

const DEFAULTS = {
  /** 单次执行环最多跑几步 */
  maxSteps: 8,
  /** 连续失败几次放弃 */
  maxFailures: 2,
  /** 连续几步分数不涨就停 */
  stallSteps: 3,
  /** 分数相对增长低于这个值算「没涨」 */
  minScoreGain: 0.01,
  /** 每步之间喘口气，给本能层和事件循环留缝 */
  stepDelayMs: 200,
  /** 每轮取几个候选，用来在被挡时换下一个 */
  candidates: 4,
  /**
   * 成功率门槛：样本够多且成功率低于这个值，判定「这个动作在自己的环境里做不成」。
   *
   * 光靠分数把它排下去不够用 —— 从某个节点扩散出去往往只有一两个候选，
   * 排到第三第四还是它。实跑时 collect 掉到 64% 依然每轮都被选中，
   * 因为候选池里只剩它一个能执行。
   *
   * 0.65 的意思是「三次里错一次以上就别自动试了」。定太高会误伤刚开始学的动作，
   * 定太低拦不住实跑里那种反复空转 —— collect 64% 就是被这条拦下的。
   */
  minSuccessRate: 0.65,
  /** 样本数达到这个值，成功率才有否决权。样本太少时偶然失败不该判死刑 */
  minSamples: 5,
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/* ---------------------------- 参数清洗 ---------------------------- */

/**
 * 把图里的 args 变成可安全执行的 args。
 *
 * 剥掉 x/y/z 之后，collect 靠 radius 自己找目标，build 落在脚下，
 * act / craft / attack 本来就不依赖坐标。剩下需要坐标的由 checkExecutable 拦。
 *
 * @param {object} node  pick 或 candidate
 * @returns {object} 新对象，不改动原节点
 */
function sanitizeArgs(node) {
  const out = {};
  const src = node && node.args && typeof node.args === "object" ? node.args : {};
  for (const [key, value] of Object.entries(src)) {
    if (POSITIONAL_ARGS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 判断一个候选能不能现在就执行。
 *
 * 返回的 reason 是要给人看的：被挡住的原因本身是有信息量的，
 * 「为什么它没动」比「它没动」更值得写进回执。
 *
 * @param {object} node
 * @param {object} [opts]
 * @returns {{ok: boolean, reason: string}}
 */
function checkExecutable(node, opts = {}) {
  if (!node || !node.tool) return { ok: false, reason: "节点没有工具名" };

  const tool = String(node.tool);
  const args = node.args && typeof node.args === "object" ? node.args : {};

  if (FORBIDDEN_TOOLS.has(tool)) {
    return { ok: false, reason: `${tool} 不该被自动连跑` };
  }

  if (NEEDS_FRESH_POSITION.has(tool)) {
    return { ok: false, reason: `${tool} 需要实时坐标，图里只有旧坐标` };
  }

  // move 有两种走法：跟玩家，或走去坐标。后者同样会过期
  if (tool === "move" && !args.player) {
    return { ok: false, reason: "move 没有目标玩家，坐标会过期" };
  }

  if (opts.deny && typeof opts.deny.has === "function" && opts.deny.has(tool)) {
    return { ok: false, reason: `策略禁止 ${tool}` };
  }

  // 成功率否决：样本够多、成功率又太低，就别再试了。
  //
  // 这条管的是「分数排序管不到」的那部分 —— 从某个节点扩散出去常常只有
  // 一两个候选，排到第几都是它。实跑里 collect 一路掉到 64%，每轮还是被选中，
  // 因为候选池里只剩它一个能执行。分数能让它显得不划算，只有门槛能让它停手。
  const minRate = Number.isFinite(opts.minSuccessRate) ? opts.minSuccessRate : DEFAULTS.minSuccessRate;
  const minSamples = Number.isFinite(opts.minSamples) ? opts.minSamples : DEFAULTS.minSamples;
  const runs = Number(node.runs) || 0;
  const rate = Number(node.successRate);

  if (runs >= minSamples && Number.isFinite(rate) && rate < minRate) {
    return {
      ok: false,
      reason: `成功率只有 ${Math.round(rate * 100)}%（跑过 ${runs} 次），换别的试试`,
    };
  }

  return { ok: true, reason: "" };
}

/* ---------------------------- 结果判定 ---------------------------- */

/**
 * 判断一次工具返回算不算「做成了」。
 *
 * 「跑完了」和「做成了」不是一回事：collect 找不到目标时仍然返回 ok:true，
 * 只用 complete:false 表示没达成目标。执行环拿这个结果去强化边权，
 * 把没做成的记成成功会形成错误的正反馈 —— 下次更愿意推荐一个其实做不了的动作。
 *
 * 所以这里不只看 ok，也认 complete。别的命令以后加同类字段也自动适用。
 *
 * @param {object} data 工具返回体
 * @returns {{ok: boolean, error: string|null}}
 */
function judgeOutcome(data) {
  if (data && data.complete === false) {
    return { ok: false, error: data.reason || "没有达成目标" };
  }
  return { ok: true, error: null };
}

/* ---------------------------- 主循环 ---------------------------- */

/**
 * 跑一次执行环。
 *
 * 依赖全部由 ctx 注入，这一层不 require bot / bridge，
 * 于是可以不连服务器就把停止条件、参数清洗、计数学全测一遍。
 *
 * @param {object} ctx
 * @param {object} ctx.graph       buildGraph 的返回值
 * @param {string} [ctx.current]   当前所处节点，空串则走全局评分
 * @param {(graph, world, opts)=>object} ctx.nextAction  注入 skill-graph.nextAction
 * @param {()=>Promise<object>} ctx.getWorld  取最新世界状态（每步调一次）
 * @param {(tool:string, args:object)=>Promise<{ok:boolean, data?:any, error?:string}>} ctx.execute
 * @param {()=>boolean} [ctx.shouldStop]  外部停止信号
 * @param {()=>boolean} [ctx.isConnected] 连接状态
 * @param {string[]} [ctx.visited]        已经做过的节点
 * @param {object} [ctx.opts]             覆盖 DEFAULTS
 * @returns {Promise<object>} 结构化结果
 */
async function runLoop(ctx) {
  const opts = { ...DEFAULTS, ...(ctx && ctx.opts ? ctx.opts : {}) };
  let current = (ctx && ctx.current) || "";

  // 起点也算「做过了」。不然第一轮挑完，第二轮可能又挑回起点，
  // 靠 revisitPenalty 事后打折，不如一开始就把它记进已访问。
  const visited = new Set(Array.isArray(ctx && ctx.visited) ? ctx.visited : []);
  if (current) visited.add(current);

  const steps = [];
  const skipped = [];

  let failures = 0;
  let stall = 0;
  let lastScore = null;
  let stopped = "";

  const maxSteps = Math.max(1, Number(opts.maxSteps) || DEFAULTS.maxSteps);
  const maxFailures = Math.max(1, Number(opts.maxFailures) || DEFAULTS.maxFailures);
  const stallSteps = Math.max(1, Number(opts.stallSteps) || DEFAULTS.stallSteps);
  const candidateLimit = Math.max(1, Number(opts.candidates) || DEFAULTS.candidates);

  for (let index = 1; index <= maxSteps; index++) {
    if (typeof ctx.shouldStop === "function" && ctx.shouldStop()) {
      stopped = "收到停止请求";
      break;
    }

    if (typeof ctx.isConnected === "function" && !ctx.isConnected()) {
      stopped = "连接已断开";
      break;
    }

    // 世界状态每步重取：背包、血量、附近方块都可能已经变了
    const world = (await ctx.getWorld()) || {};

    const result = ctx.nextAction(
      ctx.graph,
      { ...world, current },
      { limit: candidateLimit, visited },
    );

    if (!result || !result.pick) {
      stopped = (result && result.note) || "没有可执行的下一步";
      break;
    }

    // 首选被挡就顺位往下找，而不是直接收工 ——
    // 能量第二高的那个，常常才是此刻真能做的。
    // 本轮已经做过的节点也跳过：同一个动作连做两遍不算「下一步」，
    // 只会把步数耗在重复上，实跑时这就表现成连跑四次同一个查询。
    let chosen = null;
    const blocked = [];
    for (const candidate of result.candidates || []) {
      const check = checkExecutable(candidate, opts);
      if (!check.ok) {
        blocked.push({ tool: candidate.tool, reason: check.reason });
        continue;
      }

      const id = nodeIdOf(candidate.tool, sanitizeArgs(candidate));
      if (id && visited.has(id)) {
        blocked.push({ tool: candidate.tool, reason: "本轮已经做过" });
        continue;
      }

      chosen = candidate;
      break;
    }

    if (!chosen) {
      const detail = blocked.map((b) => `${b.tool}（${b.reason}）`).join("、");
      stopped = detail ? `候选都不可执行：${detail}` : "没有可执行的下一步";
      skipped.push(...blocked);
      break;
    }

    // 顺位落在后面的候选同样记进 skipped，否则「它想过别的但没选」这件事就丢了
    skipped.push(...blocked);

    const args = sanitizeArgs(chosen);
    const startedAt = Date.now();

    let outcome;
    try {
      outcome = await ctx.execute(chosen.tool, args);
    } catch (e) {
      outcome = { ok: false, error: e && e.message ? e.message : String(e) };
    }

    const ok = Boolean(outcome && outcome.ok);
    const ms = Date.now() - startedAt;

    steps.push({
      step: index,
      tool: chosen.tool,
      args,
      ok,
      ms,
      score: chosen.score,
      via: chosen.via || null,
      error: ok ? null : (outcome && outcome.error) || "执行失败",
    });

    // 节点身份要与建图时一致：用清洗后的 args 算
    const id = nodeIdOf(chosen.tool, args);
    if (id) {
      visited.add(id);
      current = id;
    }

    failures = ok ? 0 : failures + 1;
    if (failures >= maxFailures) {
      stopped = `连续失败 ${failures} 次`;
      break;
    }

    // 分数停滞：扩散到头了，再跑就是在原地打转
    if (lastScore != null && chosen.score <= lastScore * (1 + opts.minScoreGain)) {
      stall += 1;
    } else {
      stall = 0;
    }
    lastScore = chosen.score;

    if (stall >= stallSteps) {
      stopped = `连续 ${stall} 步分数没有上升`;
      break;
    }

    if (opts.stepDelayMs > 0 && index < maxSteps) {
      await delay(opts.stepDelayMs);
    }
  }

  if (!stopped) stopped = `达到步数上限（${maxSteps} 步）`;

  const succeeded = steps.filter((s) => s.ok).length;
  const failed = steps.length - succeeded;

  return {
    ok: steps.length > 0 && succeeded > 0,
    stopped,
    steps,
    skipped,
    executed: steps.length,
    succeeded,
    failed,
    finalCurrent: current,
    visited: [...visited],
  };
}

/* ---------------------------- 文本输出 ---------------------------- */

/**
 * 把执行环结果压成给模型看的短文本。
 *
 * 只列执行过的步骤和停止原因，跳过的候选单独一行带过 ——
 * 那些是「想过但做不了」的证据，值得留着，但不该占太多篇幅。
 */
function formatRun(result, maxSteps = 12) {
  if (!result) return "执行环没有返回结果。";

  if (!result.steps.length) {
    return `执行环没有执行任何动作：${result.stopped || "未知原因"}`;
  }

  const lines = [
    `执行环跑了 ${result.executed} 步：成功 ${result.succeeded} 次，失败 ${result.failed} 次。`,
  ];

  for (const s of result.steps.slice(0, maxSteps)) {
    const mark = s.ok ? "✔" : "✘";
    const argText = Object.entries(s.args || {})
      .slice(0, 3)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    lines.push(
      `  ${mark} ${s.step}. ${s.tool}${argText ? ` (${argText})` : ""}` +
        `｜${Math.round(s.ms / 1000 * 10) / 10}s` +
        (s.ok ? "" : `｜${s.error}`),
    );
  }

  if (result.steps.length > maxSteps) {
    lines.push(`  …还有 ${result.steps.length - maxSteps} 步`);
  }

  if (result.skipped.length) {
    const head = result.skipped
      .slice(0, 4)
      .map((s) => `${s.tool}（${s.reason}）`)
      .join("、");
    lines.push(`跳过的候选：${head}`);
  }

  lines.push(`停止原因：${result.stopped}`);
  return lines.join("\n");
}

module.exports = {
  runLoop,
  judgeOutcome,
  checkExecutable,
  sanitizeArgs,
  formatRun,
  DEFAULTS,
  NEEDS_FRESH_POSITION,
  FORBIDDEN_TOOLS,
};
