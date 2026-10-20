"use strict";

/**
 * 技能归因分析（L2 延展层）
 *
 * 职责：
 *   1. 从真实运行数据里算出每个技能的健康度（成功率、耗时趋势、稳定性）
 *   2. 对失败的技能做归因，判断是「环境没满足」「参数不合适」还是「步骤本身有问题」
 *   3. 给出可执行的优化提案（收紧半径、缩小批量、加前置检查、降级为手写流程…）
 *
 * 设计纪律（这一层全是判断，最容易变成噪音）：
 *   - 只给数据支撑得起的结论。采样不足就说「样本不足」，不猜。
 *   - 提案必须可执行且有边界：每条都带 kind / target / change，能被上层直接落地或忽略。
 *   - 提案不是自动执行。L2 只出建议，改不改由调用方决定。
 *   - 不读网络、不写文件，纯函数式分析，方便测试。
 */

/** 至少跑这么多次才谈得上「成功率」 */
const MIN_RUNS_FOR_RATE = 3;

/** 至少跑这么多次才谈得上「耗时趋势」 */
const MIN_RUNS_FOR_TREND = 4;

/** 成功率低于这个值算「不稳」，值得提案 */
const LOW_SUCCESS_RATE = 0.8;

/** 成功率高到这个程度，才建议往 L3 沉淀 */
const L3_READY_RATE = 0.95;

/** 进入 L3 所需的最少运行次数 */
const L3_READY_RUNS = 20;

/** 耗时趋势的判定幅度：最近比早期慢 50% 以上算退化 */
const SLOWDOWN_RATIO = 1.5;

/**
 * 长尾判定阈值。
 *
 * 中位数生来抗异常值，所以它能回答「常态有没有漂移」，
 * 却回答不了「有没有偶发但极其严重的劣化」。
 *
 * 实测踩过这个坑：15 次里有两次 583 秒和 190 秒，
 * 中位数纹丝不动，趋势判定「基本稳定」，但实际用起来慢得离谱。
 * 所以长尾要单独一个指标，跟中位数趋势并行看。
 */
const MIN_SAMPLES_FOR_TAIL = 5;

/** 单次耗时超过中位数的这个倍数，算一次「异常慢」 */
const SLOW_RUN_MULTIPLE = 3;

/** p90 ÷ 中位数 超过这个值，判定存在长尾 */
const TAIL_RATIO_THRESHOLD = 2;

/** 异常慢出现这么多次，就算比例不高也值得报 */
const SLOW_RUNS_THRESHOLD = 2;

/** 搜索半径的合理上限，和编译器保持一致 */
const MAX_SEARCH_RADIUS = 16;

/* ---------------------------- 小工具 ---------------------------- */

function median(list) {
  const arr = (list || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : Math.round((arr[mid - 1] + arr[mid]) / 2);
}

function mean(list) {
  const arr = (list || []).filter((n) => Number.isFinite(n));
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * 百分位（线性插值）。
 * 用来表达「最差的那一档有多差」——中位数在这方面没有任何信息量。
 *
 * @param {number[]} list
 * @param {number} p 0~1，例如 0.9 表示 p90
 */
function percentile(list, p) {
  const arr = (list || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!arr.length) return null;
  if (arr.length === 1) return arr[0];

  const pos = (arr.length - 1) * Math.max(0, Math.min(1, p));
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return arr[lower];

  return Math.round(arr[lower] + (arr[upper] - arr[lower]) * (pos - lower));
}

/** 失败原因粗分类：把中文/英文报错归到几类可操作的方向 */
const FAILURE_PATTERNS = [
  {
    kind: "env_missing",
    test: /没有方块|区块可能未加载|not found|no block|out of range|太远|找不到/i,
    label: "环境不满足（附近没有目标方块 / 区块没加载）",
  },
  {
    kind: "path_blocked",
    test: /寻路|path|卡住|timeout|超时|cannot reach|无法到达/i,
    label: "移动或寻路失败（走不过去 / 超时）",
  },
  {
    kind: "inventory",
    test: /背包|inventory|没有物品|not enough|缺少|no item/i,
    label: "背包条件不满足",
  },
  {
    kind: "permission",
    test: /权限|permission|拒绝|denied|not allowed/i,
    label: "权限或规则拒绝",
  },
  {
    kind: "disconnected",
    test: /断线|disconnect|connection|连接/i,
    label: "连接中断",
  },
  {
    kind: "param_invalid",
    test: /参数|invalid|不认识|unknown|非法|不能为空/i,
    label: "参数不合法",
  },
];

/**
 * 把一条错误文本归到某一类。
 * 归不进去就返回 unknown，不硬套。
 */
function classifyFailure(text) {
  const s = String(text || "");
  if (!s) return { kind: "unknown", label: "没有拿到错误信息" };
  for (const p of FAILURE_PATTERNS) {
    if (p.test.test(s)) return { kind: p.kind, label: p.label };
  }
  return { kind: "unknown", label: "未归类的失败" };
}

/* ---------------------------- 单技能分析 ---------------------------- */

/**
 * 分析一个技能的运行数据。
 *
 * @param {object} skill 来自 SkillStore.get() 的规范化对象
 * @returns {object} 分析结果
 */
function analyzeSkill(skill) {
  const name = skill && skill.name ? skill.name : "(unknown)";
  const stats = (skill && skill.stats) || {};
  const runs = Number(stats.runs) || 0;
  const success = Number(stats.success) || 0;
  const fail = Number(stats.fail) || 0;
  const durations = Array.isArray(stats.durations) ? stats.durations.filter((n) => Number.isFinite(n)) : [];
  const failures = Array.isArray(stats.failures) ? stats.failures : [];

  const rate = runs > 0 ? success / runs : null;

  // 耗时趋势：把最近样本切成前后两半比中位数，比首尾单点稳
  let trend = null;
  if (durations.length >= MIN_RUNS_FOR_TREND) {
    const half = Math.floor(durations.length / 2);
    const early = median(durations.slice(0, half));
    const late = median(durations.slice(-half));
    if (early && late) {
      const ratio = late / early;
      trend = {
        earlyMedianMs: early,
        lateMedianMs: late,
        ratio: Math.round(ratio * 100) / 100,
        direction: ratio >= SLOWDOWN_RATIO ? "slower" : ratio <= 1 / SLOWDOWN_RATIO ? "faster" : "stable",
      };
    }
  }

  // 失败归因：按类别聚合，给出主要失败方向
  const buckets = new Map();
  for (const f of failures) {
    const c = classifyFailure(f && f.error);
    const cur = buckets.get(c.kind) || { kind: c.kind, label: c.label, count: 0, samples: [], steps: new Set() };
    cur.count += 1;
    if (f && f.error && cur.samples.length < 2) cur.samples.push(String(f.error).slice(0, 120));
    if (f && Number.isFinite(Number(f.step))) cur.steps.add(Number(f.step));
    buckets.set(c.kind, cur);
  }

  const causes = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .map((b) => ({
      kind: b.kind,
      label: b.label,
      count: b.count,
      steps: [...b.steps],
      samples: b.samples,
    }));

  // 长尾：中位数看不见「偶发但极严重」的劣化，得单独算
  const med = median(durations);
  let tail = null;
  if (durations.length >= MIN_SAMPLES_FOR_TAIL && med) {
    const sorted = [...durations].sort((a, b) => a - b);
    const p90 = percentile(sorted, 0.9);
    const slowThreshold = med * SLOW_RUN_MULTIPLE;
    const slowRuns = durations.filter((d) => d > slowThreshold).length;
    const worst = sorted[sorted.length - 1];

    const ratio = p90 && med ? p90 / med : null;

    // 两种任一成立就算长尾：最差一档明显放大，或者异常慢出现了不止一次
    const flagged =
      (ratio !== null && ratio >= TAIL_RATIO_THRESHOLD) || slowRuns >= SLOW_RUNS_THRESHOLD;

    tail = {
      p90Ms: p90,
      worstMs: worst,
      slowRuns,
      slowThresholdMs: Math.round(slowThreshold),
      ratio: ratio === null ? null : Math.round(ratio * 100) / 100,
      flagged,
    };
  }

  // 健康度：数据不足时不打分，避免用 0 或满分误导
  let health = "unknown";
  if (runs >= MIN_RUNS_FOR_RATE) {
    if (rate >= L3_READY_RATE && runs >= L3_READY_RUNS) health = "solid";
    else if (rate >= LOW_SUCCESS_RATE) health = "healthy";
    else if (rate > 0) health = "unstable";
    else health = "broken";
  }

  return {
    name,
    description: (skill && skill.description) || "",
    level: skill && skill.level ? skill.level : 1,
    steps: Array.isArray(skill && skill.steps) ? skill.steps.length : 0,
    runs,
    success,
    fail,
    successRate: rate === null ? null : Math.round(rate * 1000) / 1000,
    medianMs: med,
    meanMs: mean(durations),
    samples: durations.length,
    trend,
    tail,
    causes,
    health,
    l3Ready: runs >= L3_READY_RUNS && rate !== null && rate >= L3_READY_RATE,
  };
}

/* ---------------------------- 提案生成 ---------------------------- */

/**
 * 根据分析结果生成优化提案。
 *
 * 每条提案结构固定：
 *   { kind, target, severity, title, detail, change }
 *
 * kind 取值：
 *   tighten_radius  收紧搜索半径
 *   reduce_count    降低单次批量
 *   add_precondition 增加前置检查
 *   split_skill     拆成更小的技能
 *   demote          降级为手写流程（别再用这个技能）
 *   promote_l3      可以沉淀成自动行动
 *   investigate     数据不足或现象不明，先观察
 *
 * @param {object} analysis analyzeSkill 的返回值
 * @param {object} [skill] 原始技能对象，用来读 steps / params
 * @returns {Array<object>}
 */
function proposeForSkill(analysis, skill = null) {
  const out = [];
  const a = analysis;
  if (!a) return out;

  const base = { skill: a.name };

  /* ---- 数据不足：先别下结论 ---- */
  if (a.runs < MIN_RUNS_FOR_RATE) {
    out.push({
      ...base,
      kind: "investigate",
      target: a.name,
      severity: "info",
      title: `样本不足（${a.runs}/${MIN_RUNS_FOR_RATE} 次），暂不判断好坏`,
      detail: "跑够次数再看成功率，否则容易被一次偶然失败带偏。",
      change: null,
    });
    return out;
  }

  /* ---- 长尾：偶发但极严重的耗时尖峰 ----
   *
   * 这一项跟 trend 是两件事，不能互相替代：
   *   trend 靠中位数，回答「常态有没有整体漂移」
   *   tail  靠 p90 与异常计数，回答「有没有偶发的灾难」
   *
   * 实测遇到过：15 次里两次 583 秒 / 190 秒，中位数判定「基本稳定」，
   * 但用起来慢得离谱。只看中位数的分析等于没说。
   */
  if (a.tail && a.tail.flagged) {
    const t = a.tail;
    const worstSec = (t.worstMs / 1000).toFixed(1);
    const p90Sec = (t.p90Ms / 1000).toFixed(1);
    const medSec = ((a.medianMs || 0) / 1000).toFixed(1);
    const slowSec = (t.slowThresholdMs / 1000).toFixed(1);

    out.push({
      ...base,
      kind: "long_tail",
      target: `${a.name}:tail`,
      severity: t.slowRuns >= 3 || (t.ratio || 0) >= 4 ? "high" : "medium",
      title: `耗时存在长尾：中位数 ${medSec}s，但最慢一次 ${worstSec}s（p90 ${p90Sec}s）`,
      detail:
        `${a.samples} 次运行里有 ${t.slowRuns} 次超过 ${slowSec}s（中位数的 ${SLOW_RUN_MULTIPLE} 倍）。` +
        `常态看着没问题，但偶发尖峰会把等待时间拉长好几倍。` +
        `常见原因是目标资源变远或枯竭后仍在范围内绕行搜索。`,
      change: {
        action: "bound_search",
        suggest: ["tighten_radius", "add_distance_limit", "add_precondition"],
      },
    });
  }

  /* ---- 半径过大：最常见的性能与失败来源 ---- */
  const steps = (skill && Array.isArray(skill.steps) ? skill.steps : []) || [];
  const wideRadius = steps.filter((s) => {
    const r = Number(s && s.args && s.args.radius);
    return Number.isFinite(r) && r > MAX_SEARCH_RADIUS;
  });

  if (wideRadius.length) {
    const maxR = Math.max(...wideRadius.map((s) => Number(s.args.radius)));
    out.push({
      ...base,
      kind: "tighten_radius",
      target: `${a.name}:${wideRadius[0].cmd}.radius`,
      severity: a.trend && a.trend.direction === "slower" ? "high" : "medium",
      title: `搜索半径 ${maxR} 偏大，每次都要跑去远处`,
      detail:
        (a.medianMs ? `当前耗时中位数 ${(a.medianMs / 1000).toFixed(1)} 秒。` : "") +
        `半径收进 ${MAX_SEARCH_RADIUS} 格后，绝大多数目标都能在附近找到，技能更像「就地干活」。`,
      change: { cmd: wideRadius[0].cmd, key: "radius", from: maxR, to: MAX_SEARCH_RADIUS },
    });
  }

  /* ---- 环境类失败：加前置检查，别硬撞 ---- */
  const envCause = a.causes.find((c) => c.kind === "env_missing");
  if (envCause && a.fail > 0) {
    out.push({
      ...base,
      kind: "add_precondition",
      target: `${a.name}:preconditions.nearbyBlock`,
      severity: envCause.count >= Math.max(2, a.fail * 0.5) ? "high" : "medium",
      title: `失败主因是「附近没有目标」（${envCause.count} 次）`,
      detail:
        (envCause.samples[0] ? `典型报错：${envCause.samples[0]}。` : "") +
        "执行前先用 scan 确认附近有目标，确认不到就换个位置或换个技能，比硬跑一遍再失败省事。",
      change: { precondition: "nearbyBlock", requireScanFirst: true },
    });
  }

  /* ---- 寻路/超时类失败：多半是距离导致的 ---- */
  const pathCause = a.causes.find((c) => c.kind === "path_blocked");
  if (pathCause && a.fail > 0) {
    out.push({
      ...base,
      kind: "tighten_radius",
      target: `${a.name}:distance`,
      severity: "medium",
      title: `有 ${pathCause.count} 次因寻路失败/超时`,
      detail:
        (pathCause.samples[0] ? `典型报错：${pathCause.samples[0]}。` : "") +
        "先把搜索范围收小，让目标落在能走过去的距离内，再考虑加大超时。",
      change: { cmd: steps[0] ? steps[0].cmd : null, key: "radius", from: null, to: MAX_SEARCH_RADIUS },
    });
  }

  /* ---- 批量过大：降 count ---- */
  const countDef = (skill && skill.params && skill.params.count) || null;
  if (countDef && Number(countDef.default) > 16) {
    out.push({
      ...base,
      kind: "reduce_count",
      target: `${a.name}:params.count`,
      severity: "low",
      title: `默认批量 ${countDef.default} 偏大`,
      detail: "单次批量越大，中途被打断或背包满的概率越高，失败一次就整批白跑。",
      change: { param: "count", from: Number(countDef.default), to: Math.min(16, Number(countDef.default)) },
    });
  }

  /* ---- 成功率低：拆开看 ---- */
  if (a.successRate !== null && a.successRate < LOW_SUCCESS_RATE && a.runs >= MIN_RUNS_FOR_RATE) {
    const dominant = a.causes[0];
    out.push({
      ...base,
      kind: "split_skill",
      target: a.name,
      severity: a.successRate < 0.5 ? "high" : "medium",
      title: `成功率 ${Math.round(a.successRate * 100)}%，低于 ${Math.round(LOW_SUCCESS_RATE * 100)}%`,
      detail:
        (dominant ? `主要失败方向：${dominant.label}（${dominant.count} 次）。` : "失败原因还没归到明确的类别。") +
        "步骤越多，整体成功率是各步相乘；拆成能独立成功的小技能，再组合使用更稳。",
      change: { splitAt: a.steps > 2 ? Math.ceil(a.steps / 2) : null },
    });
  }

  /* ---- 一直失败：别再用了 ---- */
  if (a.runs >= MIN_RUNS_FOR_RATE && a.success === 0) {
    out.push({
      ...base,
      kind: "demote",
      target: a.name,
      severity: "high",
      title: `连续 ${a.runs} 次全部失败`,
      detail: "这个技能目前不可用。继续调用只会浪费时间和上下文，建议先删掉或改由手写步骤完成。",
      change: { action: "disable", suggest: "fallback_manual" },
    });
  }

  /* ---- 稳定到可以沉淀 ---- */
  if (a.l3Ready) {
    out.push({
      ...base,
      kind: "promote_l3",
      target: a.name,
      severity: "info",
      title: `已满足 L3 条件（${a.runs} 次，成功率 ${Math.round(a.successRate * 100)}%）`,
      detail: "可以进入 L3 沉淀层：由本能层在合适条件下自动触发，不再需要每次显式调用。",
      change: { action: "promote", level: 3 },
    });
  }

  return out;
}

/* ---------------------------- 汇总入口 ---------------------------- */

/**
 * 分析整个技能库。
 *
 * @param {object} store SkillStore 实例
 * @param {object} [opts]
 * @param {number} [opts.top] 只返回最值得看的几个技能（不传返回全部）
 * @returns {{summary:object, skills:Array, proposals:Array}}
 */
function analyzeStore(store, opts = {}) {
  const names = store.listNames();
  const skills = [];
  const proposals = [];

  for (const name of names) {
    const skill = store.get(name);
    if (!skill) continue;
    const analysis = analyzeSkill(skill);
    const props = proposeForSkill(analysis, skill);
    skills.push({ ...analysis, proposals: props.map((p) => p.kind) });
    for (const p of props) proposals.push(p);
  }

  // 排序：问题大的排前面。severity 优先级 + 失败次数
  const sevRank = { high: 0, medium: 1, low: 2, info: 3 };
  proposals.sort((x, y) => {
    const d = (sevRank[x.severity] ?? 9) - (sevRank[y.severity] ?? 9);
    if (d !== 0) return d;
    const ax = skills.find((s) => s.name === x.skill);
    const ay = skills.find((s) => s.name === y.skill);
    return (ay ? ay.fail : 0) - (ax ? ax.fail : 0);
  });

  const graded = skills.filter((s) => s.health !== "unknown");
  const summary = {
    skillCount: skills.length,
    graded: graded.length,
    totalRuns: skills.reduce((n, s) => n + s.runs, 0),
    totalFail: skills.reduce((n, s) => n + s.fail, 0),
    // 整体成功率按总量算，不用各技能平均值，避免小样本技能拉偏
    overallRate: (() => {
      const runs = skills.reduce((n, s) => n + s.runs, 0);
      if (!runs) return null;
      const ok = skills.reduce((n, s) => n + s.success, 0);
      return Math.round((ok / runs) * 1000) / 1000;
    })(),
    unhealthy: skills.filter((s) => s.health === "unstable" || s.health === "broken").map((s) => s.name),
    l3Ready: skills.filter((s) => s.l3Ready).map((s) => s.name),
    proposalCount: proposals.length,
  };

  const top = Number(opts.top);
  return {
    summary,
    skills: Number.isFinite(top) && top > 0 ? skills.slice(0, top) : skills,
    proposals,
  };
}

/**
 * 把分析结果渲染成给人看的短文本。
 * 控制长度：技能多的时候只列有问题的，稳的只给一行统计。
 */
function formatReport(result, opts = {}) {
  const maxProposals = Math.max(1, Math.min(Number(opts.maxProposals) || 8, 30));
  const s = result.summary;
  const lines = [];

  if (!s.skillCount) {
    return "技能库还是空的，没有可分析的数据。先跑几次任务并编译技能。";
  }

  const rateText = s.overallRate === null ? "还没跑过" : `${Math.round(s.overallRate * 100)}%`;
  lines.push(`技能 ${s.skillCount} 个（可评估 ${s.graded} 个）｜累计运行 ${s.totalRuns} 次，失败 ${s.totalFail} 次｜整体成功率 ${rateText}`);

  if (s.l3Ready.length) lines.push(`可沉淀到 L3：${s.l3Ready.join("、")}`);
  if (s.unhealthy.length) lines.push(`需要关注：${s.unhealthy.join("、")}`);

  const props = result.proposals.slice(0, maxProposals);
  if (!props.length) {
    lines.push("没有需要处理的提案。");
    return lines.join("\n");
  }

  lines.push("");
  lines.push(`优化提案 ${result.proposals.length} 条${result.proposals.length > maxProposals ? `（列前 ${maxProposals} 条）` : ""}：`);
  for (const p of props) {
    const tag = p.severity === "high" ? "高" : p.severity === "medium" ? "中" : p.severity === "low" ? "低" : "提示";
    lines.push(`[${tag}] ${p.skill} · ${p.title}`);
    lines.push(`      ${p.detail}`);
    if (p.change) {
      const c = p.change;
      const brief = Object.entries(c)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
        .join(" ");
      if (brief) lines.push(`      改动：${brief}`);
    }
  }

  return lines.join("\n");
}

module.exports = {
  analyzeSkill,
  analyzeStore,
  proposeForSkill,
  classifyFailure,
  formatReport,
  percentile,
  MIN_RUNS_FOR_RATE,
  MIN_RUNS_FOR_TREND,
  LOW_SUCCESS_RATE,
  L3_READY_RATE,
  L3_READY_RUNS,
  SLOWDOWN_RATIO,
  MAX_SEARCH_RADIUS,
  MIN_SAMPLES_FOR_TAIL,
  SLOW_RUN_MULTIPLE,
  TAIL_RATIO_THRESHOLD,
  SLOW_RUNS_THRESHOLD,
};
