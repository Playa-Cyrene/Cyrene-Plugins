"use strict";

/**
 * 解锁限流。
 *
 * 阶梯：1 小时 → 1 天 → 1 周 → 1 个月 → 1 季度 → 1 年 → 4 年 → 8 年，
 * 每档 5 次。某一档用完，必须等这个窗口走完，才进入下一档。
 *
 * 计时不信任系统时间：
 * - lastSeen 记录见过的最晚时间，永远只增不减
 * - 时钟跳动（往前拨、往回拨都算）超过容差，一律当作可疑事件：
 *   当前窗口直接耗完，锚点落在跳变后的那一刻
 * - 所以拨钟换不来新的尝试次数，只会让自己多锁一个窗口
 * - 如果锚点被推到比当前时间还超前一个月以上（有人把日期拨到几十年后），
 *   就拉回当前时间并升一档，避免把库永久锁死
 * - 窗口锚点一旦写下就不再往回改
 *
 * 边界要说清楚：guard 存在库文件头部的明文区，能被读到也能被改。
 * 它挡的是「有人坐在这台电脑前反复猜密码」，挡不住「把库文件复制走离线爆破」。
 * 后者只能靠主密码本身足够长、以及 scrypt 的计算成本。
 */

const STAGES = Object.freeze([
  { stage: 0, label: "1 小时", ms: 60 * 60 * 1000 },
  { stage: 1, label: "1 天", ms: 24 * 60 * 60 * 1000 },
  { stage: 2, label: "1 周", ms: 7 * 24 * 60 * 60 * 1000 },
  { stage: 3, label: "1 个月", ms: 30 * 24 * 60 * 60 * 1000 },
  { stage: 4, label: "1 个季度", ms: 91 * 24 * 60 * 60 * 1000 },
  { stage: 5, label: "1 年", ms: 365 * 24 * 60 * 60 * 1000 },
  { stage: 6, label: "4 年", ms: 4 * 365 * 24 * 60 * 60 * 1000 },
  { stage: 7, label: "8 年", ms: 8 * 365 * 24 * 60 * 60 * 1000 },
]);

const LIMIT_PER_STAGE = 5;
const HELLO_FAILS_PER_ATTEMPT = 3;
const CLOCK_TOLERANCE_MS = 2 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_GUARD = Object.freeze({
  version: 1,
  stage: 0,
  used: 0,
  windowStart: 0,
  lastSeen: 0,
  helloFails: 0,
  tamper: 0,
  jumpDir: "",
  jumpMs: 0,
  jumpAt: 0,
  unlockMode: "hello",
});

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function intOf(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function stageOf(stage) {
  return STAGES[intOf(stage, 0, 0, STAGES.length - 1)];
}

/** 把外部读到的 guard 收敛成合法形状。 */
function normalize(raw, now = Date.now()) {
  const source = isRecord(raw) ? raw : {};
  const guard = {
    version: 1,
    stage: intOf(source.stage, 0, 0, STAGES.length - 1),
    used: intOf(source.used, 0, 0, LIMIT_PER_STAGE),
    windowStart: Math.max(0, Number(source.windowStart) || 0),
    lastSeen: Math.max(0, Number(source.lastSeen) || 0),
    helloFails: intOf(source.helloFails, 0, 0, HELLO_FAILS_PER_ATTEMPT - 1),
    tamper: intOf(source.tamper, 0, 0, 9999),
    jumpDir: source.jumpDir === "back" || source.jumpDir === "forward" ? source.jumpDir : "",
    jumpMs: Number.isFinite(Number(source.jumpMs)) ? Math.trunc(Number(source.jumpMs)) : 0,
    jumpAt: Math.max(0, Number(source.jumpAt) || 0),
    unlockMode: source.unlockMode === "both" ? "both" : "hello",
  };
  if (!guard.windowStart) {
    const base = Number(now);
    guard.windowStart = Number.isFinite(base) ? base : Date.now();
  }
  return guard;
}

/**
 * 记一次时钟跳变：耗完当前窗口，锚点落在 anchor。
 * anchor 比当前时间超前一个月以上时拉回来，并升一档，避免把库锁到几十年后。
 */
function markJump(guard, now, direction, delta, anchor, bumpStage) {
  guard.tamper += 1;
  guard.jumpDir = direction;
  guard.jumpMs = delta;
  guard.jumpAt = now;

  if (anchor - now > MAX_FUTURE_SKEW_MS) {
    anchor = now;
    bumpStage = true;
  }
  if (guard.used > 0) guard.used = LIMIT_PER_STAGE;
  if (bumpStage) guard.stage = Math.min(guard.stage + 1, STAGES.length - 1);

  guard.windowStart = anchor;
  guard.lastSeen = anchor;
  return { tampered: true, direction, jumpMs: delta };
}

/**
 * 看钟。时间只能平滑地往前走。
 *
 * 回拨：不管窗口有没有结束，都算可疑。
 * 前跳：只有当它足以让当前窗口提前结束、并且已经用过配额时才算可疑。
 * 正常操作之间的间隔（几分钟、几小时）碰不到这条线，不会被误判。
 * 所以拨钟换不来新的尝试次数，只会让自己多锁一个窗口。
 */
function observeClock(guard, now) {
  if (!guard.lastSeen) {
    guard.lastSeen = now;
    return { tampered: false, direction: "", jumpMs: 0 };
  }

  const delta = now - guard.lastSeen;

  if (delta < -CLOCK_TOLERANCE_MS) {
    const anchor = Math.max(now, guard.lastSeen);
    return markJump(guard, now, "back", delta, anchor, false);
  }

  const stage = stageOf(guard.stage);
  const windowEnd = guard.windowStart + stage.ms;
  if (delta > CLOCK_TOLERANCE_MS && guard.used > 0 && now >= windowEnd) {
    return markJump(guard, now, "forward", delta, now, false);
  }

  if (now > guard.lastSeen) guard.lastSeen = now;
  return { tampered: false, direction: "", jumpMs: 0 };
}

/** 窗口走完了就翻页。用完的进下一档，没用完的原档重开。 */
function rollWindow(guard, now) {
  const stage = stageOf(guard.stage);
  const end = guard.windowStart + stage.ms;
  if (now < end) return guard;

  if (guard.used >= LIMIT_PER_STAGE) {
    guard.stage = Math.min(guard.stage + 1, STAGES.length - 1);
  }
  guard.used = 0;
  guard.windowStart = now - end > stage.ms ? now : end;
  return guard;
}

/** 读当前状态给面板看。会就地推进窗口。 */
function status(raw, now = Date.now()) {
  const guard = normalize(raw, now);
  observeClock(guard, now);
  rollWindow(guard, now);

  const stage = stageOf(guard.stage);
  const locked = guard.used >= LIMIT_PER_STAGE;
  const retryAt = locked ? guard.windowStart + stage.ms : 0;

  return {
    guard,
    stage: guard.stage,
    stageLabel: stage.label,
    limit: LIMIT_PER_STAGE,
    used: guard.used,
    remaining: Math.max(0, LIMIT_PER_STAGE - guard.used),
    locked,
    retryAt,
    waitMs: retryAt ? Math.max(0, retryAt - now) : 0,
    windowEndsAt: guard.windowStart + stage.ms,
    unlockMode: guard.unlockMode,
    helloFails: guard.helloFails,
    tamper: guard.tamper,
    jumpDir: guard.jumpDir,
    jumpMs: guard.jumpMs,
    jumpAt: guard.jumpAt,
  };
}

/**
 * 申请一次尝试。配额够就当场扣掉，返回 ok。
 * 扣配额先于验证，所以中途崩了也算用过一次——偏保守。
 */
function beginAttempt(raw, now = Date.now()) {
  const state = status(raw, now);
  const guard = state.guard;
  if (state.locked) {
    return { ok: false, ...state, guard };
  }
  guard.used += 1;
  const next = status(guard, now);
  return { ok: true, ...next, guard: next.guard };
}

/** 用对了，全部清零。 */
function recordSuccess(raw, now = Date.now()) {
  const guard = normalize(raw, now);
  const tamper = guard.tamper;
  const unlockMode = guard.unlockMode;
  Object.assign(guard, {
    stage: 0,
    used: 0,
    windowStart: now,
    lastSeen: Math.max(guard.lastSeen, now),
    helloFails: 0,
    tamper,
    unlockMode,
  });
  return status(guard, now);
}

/**
 * Hello 没通过：连续 3 次折算一次主密码尝试。
 * 返回 state，若折算发生会带上 folded=true。
 */
function recordHelloFailure(raw, now = Date.now()) {
  const guard = normalize(raw, now);
  observeClock(guard, now);
  guard.helloFails += 1;

  let folded = false;
  if (guard.helloFails >= HELLO_FAILS_PER_ATTEMPT) {
    guard.helloFails = 0;
    folded = true;
    if (guard.used < LIMIT_PER_STAGE) guard.used += 1;
  }

  const state = status(guard, now);
  return { ...state, folded };
}

function describeWait(waitMs) {
  const ms = Math.max(0, Number(waitMs) || 0);
  if (ms <= 0) return "现在就可以再试";
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return "约 " + minutes + " 分钟";
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return "约 " + hours + " 小时";
  const days = Math.ceil(hours / 24);
  if (days < 60) return "约 " + days + " 天";
  const months = Math.ceil(days / 30);
  if (months < 24) return "约 " + months + " 个月";
  return "约 " + Math.ceil(months / 12) + " 年";
}

module.exports = {
  STAGES,
  LIMIT_PER_STAGE,
  HELLO_FAILS_PER_ATTEMPT,
  CLOCK_TOLERANCE_MS,
  MAX_FUTURE_SKEW_MS,
  DEFAULT_GUARD,
  normalize,
  status,
  beginAttempt,
  recordSuccess,
  recordHelloFailure,
  describeWait,
};
