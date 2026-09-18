"use strict";
/**
 * 小米运动健康（CN 区）插件 —— Cyrene Plugin API v1
 *
 * 验证目标：在不改动 agent 核心的前提下，用一个纯插件跑通「扫码连接 + 定时同步入库 +
 * 对话查询」三件事，并让 UI 与 agent 主题一致。
 *
 * 结构：
 *   lib/xiaomi.cjs  —— 自包含的 CN 区小米客户端（登录 / STS / RC4·AES / 取数）
 *   index.cjs       —— 本文件，插件装配（工具 / IPC / 定时 / 窗口）
 *   ui.html         —— 连接与数据查看窗口（pearl-white 主题，frameless）
 *
 * 契约要点（对齐 api.ts）：
 *   - token 只经 ctx.deps.secrets 存，绝不明文落盘；
 *   - registerTool 收完整 PluginTool 对象；工具 id 以插件 id 前缀；
 *   - registerIpc 通道宿主自动补前缀为 plugin:xiaomi-health:<channel>，窗口用
 *     nodeIntegration 直接 ipcRenderer.invoke 该全名；
 *   - open() 里 require("electron") 自建 BrowserWindow（与官方 system-status 同法）；
 *   - 后台定时器受 ctx.signal 约束，onDispose 兜底清理。
 */

const path = require("node:path");
const {
  XiaomiAuth,
  MiHealthClient,
  DataNotSharedError,
  TokenExpiredError,
  FamilyMemberNotFoundError,
} = require("./lib/xiaomi.cjs");

const PLUGIN_ID = "xiaomi-health";
const TOKEN_SECRET_KEY = "token";
// 走 electron 原生 ipcMain/webContents 的裸通道：不经过 ctx.registerIpc 的自动命名空间，
// 必须自己写全名，且与 ui.html 里 `plugin:xiaomi-health:` 前缀逐字对齐。
const CHANNEL_NS = "plugin:xiaomi-health:";
const LOGIN_POLL_CHANNEL = `${CHANNEL_NS}login`;
const WIN_MIN_CHANNEL = `${CHANNEL_NS}win-minimize`;
const WIN_CLOSE_CHANNEL = `${CHANNEL_NS}win-close`;
const DEFAULT_SYNC_INTERVAL_MIN = 30;
const PREFS_KEY = "prefs";
const MORNING_ACK_KEY = "morningNoticeAck";
// 本插件创建的宿主定时任务统一以此前缀命名，便于 reconcile 时按标题匹配/清理（不再依赖单个 taskId）。
const TASK_PREFIX = "小米健康 · ";
const TASK_TITLE_RECURRING = "小米健康 · 主动播报";
const TASK_TITLE_MORNING = "小米健康 · 早安播报";
const TASK_TITLE_MEMORY = "小米健康 · 健康记忆";
const ALL_PER_DAY = 0; // timesPerDay=0 → 「所有/每条」：≈每小时一次
const WAKING_START = "08:00";

// 单次注册内复用的运行时状态（宿主会在启用/停用时重新实例化插件）。
let ctxRef = null;
let auth = null;
let client = null;
let cachedUid = 0;
const cache = { summary: null, fetchedAt: 0 };
const login = { state: "idle", qr: "", loginUrl: "", error: "" };
let pluginWin = null;
let syncTimer = null;
let winControlsInstalled = false;

// ── token / 客户端 ──────────────────────────────────────────────
function uidOf(token) {
  return Number(token && (token.target_relative_uid ?? token.user_id)) || 0;
}

async function loadToken() {
  if (!ctxRef || !ctxRef.deps.secrets) return null;
  const raw = await ctxRef.deps.secrets.get(TOKEN_SECRET_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function ensureClient() {
  const token = await loadToken();
  if (!token || !token.service_token || !token.ssecurity) return null;
  const uid = uidOf(token);
  if (!uid) return null;
  if (!auth) auth = new XiaomiAuth(token);
  if (!client) client = new MiHealthClient(auth);
  cachedUid = uid;
  return client;
}

// 扫码/刷新后 token 会变化，落盘并让客户端按新 token 重建。
async function persistToken(token) {
  if (!token || !ctxRef || !ctxRef.deps.secrets) return;
  await ctxRef.deps.secrets.set(TOKEN_SECRET_KEY, JSON.stringify(token));
  auth = null;
  client = null;
  cachedUid = uidOf(token);
}

// ── 用户偏好（存 ctx.storage.prefs；宿主每个键写独立 <key>.json）──────
function sanitizePrefs(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const p = src.proactive && typeof src.proactive === "object" ? src.proactive : {};
  const metrics = Array.isArray(p.metrics)
    ? p.metrics.filter((m) => ["steps", "sleep", "heart"].includes(m))
    : [];
  return {
    syncIntervalMin:
      Number.isFinite(src.syncIntervalMin) && src.syncIntervalMin > 0
        ? Math.min(Math.floor(src.syncIntervalMin), 24 * 60)
        : DEFAULT_SYNC_INTERVAL_MIN,
    chatInject: src.chatInject !== false,
    proactive: {
      enabled: Boolean(p.enabled),
      timesPerDay:
        Number.isInteger(p.timesPerDay) &&
        (p.timesPerDay === ALL_PER_DAY || (p.timesPerDay >= 1 && p.timesPerDay <= 12))
          ? p.timesPerDay
          : 2,
      style: p.style === "detail" || p.style === "natural" ? p.style : "natural",
      metrics: metrics.length ? metrics : ["steps", "sleep", "heart"],
      morning: Boolean(p.morning),
      morningTime:
        typeof p.morningTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(p.morningTime)
          ? p.morningTime
          : WAKING_START,
      morningCarriesInfo: p.morningCarriesInfo !== false,
      // 健康→长期记忆（方案 A：只写 L2，纯追加、零覆盖、同步 RAG）；默认关，需用户主动开启。
      remember: Boolean(p.remember),
      rememberTimesPerDay:
        Number.isInteger(p.rememberTimesPerDay) && p.rememberTimesPerDay >= 1 && p.rememberTimesPerDay <= 6
          ? p.rememberTimesPerDay
          : 1,
    },
  };
}

function readPrefs() {
  return sanitizePrefs(ctxRef ? ctxRef.storage.get(PREFS_KEY) : null);
}

function writePrefs(prefs) {
  if (ctxRef) ctxRef.storage.set(PREFS_KEY, sanitizePrefs(prefs));
}

// ── 每轮对话上下文注入（受 prefs.chatInject 控制；不联网，2s 超时安全）──
// source 区分场景：conversation/scheduler 有工具循环→强调“必须调用”；
// moments-post 无工具循环→只供新鲜数据作为发帖灵感。
function buildHealthContext(source) {
  if (!ctxRef || !readPrefs().chatInject) return "";
  if (!client) return ""; // 未连接或已退出登录：不提示工具，避免误导模型
  const fresh = cache.summary && cache.fetchedAt && Date.now() - cache.fetchedAt < 6 * 3600 * 1000;
  if (source === "moments-post") {
    // 发帖轮不跑工具，只把当日数据作为背景参考（无新鲜数据则不注入）。
    return fresh ? describeSummary(cache.summary) : "";
  }
  const lines = [
    "[小米健康] 机主已连接小米运动健康（CN 区）。只要对话涉及身体状态、运动、步数、睡眠、心率、作息、疲劳、减脂或健康建议等话题，就必须先调用 xiaomi-health_query 工具查真实数据再回答，不得猜测，也不得以「无法获取实时数据」之类推脱。",
    "用法：metric=today 取今日三合一摘要；steps/sleep/heart 取最近 days 天单项；range 取多项汇总。回答时用自然口吻转述，不要把工具名或「查询」这类字眼暴露给机主。",
  ];
  if (fresh) lines.push(describeSummary(cache.summary));
  return lines.join("\n");
}

// ── 主动播报：经宿主 deps.scheduler 维护「周期播报」+「早安播报」两类任务 ──
const METRIC_LABEL = { steps: "步数与活动", sleep: "睡眠", heart: "心率" };

function intervalForTimesPerDay(n) {
  // timesPerDay=0 → 「所有/每条」≈每小时；否则把一天 24h 均分成 n 次。
  if (n === ALL_PER_DAY) return { kind: "interval", every: 1, unit: "hours" };
  const minutes = Math.max(30, Math.round((24 * 60) / n));
  if (minutes >= 1440) return { kind: "interval", every: 24, unit: "hours" };
  if (minutes % 60 === 0) return { kind: "interval", every: minutes / 60, unit: "hours" };
  return { kind: "interval", every: minutes, unit: "minutes" };
}

function metricsText(p) {
  const t = p.metrics.map((m) => METRIC_LABEL[m] || m).join("、");
  return t || "步数、睡眠与心率";
}

function styleText(p) {
  return p.style === "detail"
    ? "消息里请带上具体数字（例如步数、睡眠时长或心率），并温柔关心或提醒（如步数不足、睡得太晚）。"
    : "消息里不要复述具体数字，只把数据当作你判断当天状态的依据，自然地关心：比如问睡得/休息如何、走路或运动累不累、要不要活动一下，语气贴合当天情况即可。";
}

function recurringTaskSpec(prefs) {
  const p = prefs.proactive;
  return {
    title: TASK_TITLE_RECURRING,
    schedule: intervalForTimesPerDay(p.timesPerDay),
    prompt:
      `【小米健康·主动播报】请先用 xiaomi-health_query 工具查询机主今天的${metricsText(p)}，` +
      `然后以昔涟的口吻生成一条自然、简短（不超过 50 字）的主动消息。${styleText(p)}` +
      `不要提及工具、插件、系统或数据来源；若查询失败或今日无数据，就发一条与数据无关的自然关心消息。`,
    mode: "chat",
    allowedToolIds: [`${PLUGIN_ID}_query`, `${PLUGIN_ID}_status`],
  };
}

function morningTaskSpec(prefs) {
  const p = prefs.proactive;
  if (!p.morningCarriesInfo) {
    return {
      title: TASK_TITLE_MORNING,
      schedule: { kind: "daily", timeOfDay: p.morningTime },
      prompt:
        `以昔涟的口吻向机主发一条自然、简短、温暖的早安问候。` +
        `这次不查询、也不提及任何健康数据或工具，只像日常醒来的第一句问候。`,
      mode: "chat",
      allowedToolIds: [],
    };
  }
  return {
    title: TASK_TITLE_MORNING,
    schedule: { kind: "daily", timeOfDay: p.morningTime },
    prompt:
      `【小米健康·早安播报】现在是早晨。请先用 xiaomi-health_query 查询机主昨晚睡眠与今天的数据。` +
      `若能查到昨晚较完整的睡眠记录（说明机主已醒且睡眠已同步），就${
        p.style === "detail" ? "结合具体数字" : "根据睡眠/活动情况（不要复述具体数字）"
      }发一条温暖简短的早安问候；` +
      `若实时查询失败或今天暂无数据（可能还没醒或还没同步），再用 user_memory 工具检索最近的健康记录（query 用“健康记录 步数 睡眠 心率”）；` +
      `若检索到当天或前一天的健康记录，就${
        p.style === "detail" ? "结合其中的具体数字" : "参考其中的状态（不要复述具体数字）"
      }自然地问候，并把它当作“最近一次记录”而非实时数据；` +
      `若连记忆也没有，只发一条简单的早安问候，不要提任何数据。` +
      `不要提及工具、插件、系统或数据来源。`,
    mode: "chat",
    // user_memory：实时查不到时回退参考最近一条健康记忆（L2 不会自动注入定时任务轮，需显式给工具）。
    allowedToolIds: [`${PLUGIN_ID}_query`, `${PLUGIN_ID}_status`, "user_memory"],
  };
}

function memoryTaskSpec(prefs) {
  const p = prefs.proactive;
  return {
    title: TASK_TITLE_MEMORY,
    schedule: intervalForTimesPerDay(p.rememberTimesPerDay),
    prompt:
      `【小米健康·写入长期记忆】你的唯一任务是把机主当前的健康数据记入长期记忆，全程不要给机主发送任何消息或对话内容。\n` +
      `第一步：调用 xiaomi-health_query 工具（metric=today）查询机主今天的步数、睡眠、心率。\n` +
      `第二步：若查到至少一项真实数据，调用 write_memory 工具写一条记忆——layer 必须填 "L2"（不要写 L0 或 L1），` +
      `content 用一句客观中文健康快照并带上当天日期（例如“健康记录 2026-09-16：步数约 8000 步，睡眠约 6 小时 20 分，心率平均 72”），` +
      `slug 用“健康记录 · 月-日”；只陈述事实，不要加主观评价或情绪。\n` +
      `若查询失败或今天完全没有任何数据，则不要调用 write_memory，直接结束本次任务。`,
    mode: "chat",
    // write_memory 是宿主自带工具；createTask 只校验白名单是字符串数组、不限制须为插件自有工具，
    // filterToolsForTask 从宿主全量工具表按 id 过滤 → 该工具会正常给到这轮 agent，零改 agent。
    allowedToolIds: [`${PLUGIN_ID}_query`, `${PLUGIN_ID}_status`, "write_memory"],
  };
}

function desiredTaskSpecs(prefs) {
  const p = prefs.proactive;
  const out = [];
  if (p.enabled) out.push(recurringTaskSpec(prefs));
  if (p.morning) out.push(morningTaskSpec(prefs));
  if (p.remember) out.push(memoryTaskSpec(prefs));
  return out;
}

async function deleteAllTasks() {
  if (!ctxRef) return;
  const sched = ctxRef.deps.scheduler;
  if (!sched) return;
  try {
    const tasks = await sched.listTasks();
    for (const t of tasks) {
      if (t.title && t.title.startsWith(TASK_PREFIX)) {
        try {
          await sched.deleteTask(t.id);
        } catch {
          /* 忽略 */
        }
      }
    }
  } catch {
    /* 忽略 */
  }
}

function specChanged(mine, spec) {
  const norm = (o) =>
    JSON.stringify({ s: o.schedule, p: o.prompt, m: o.mode, t: o.allowedToolIds });
  return norm(mine) !== norm({ schedule: spec.schedule, prompt: spec.prompt, mode: spec.mode, allowedToolIds: spec.allowedToolIds });
}

async function reconcileSchedulerTasks() {
  const sched = ctxRef && ctxRef.deps.scheduler;
  if (!sched) return;
  const desired = desiredTaskSpecs(readPrefs());
  try {
    const existing = (await sched.listTasks()).filter((t) => t.title && t.title.startsWith(TASK_PREFIX));
    const byTitle = new Map(existing.map((t) => [t.title, t]));
    for (const t of existing) {
      if (!desired.some((d) => d.title === t.title)) {
        try {
          await sched.deleteTask(t.id);
        } catch {
          /* 忽略 */
        }
      }
    }
    for (const spec of desired) {
      const mine = byTitle.get(spec.title);
      if (mine) {
        if (specChanged(mine, spec)) await sched.updateTask(mine.id, spec);
      } else {
        await sched.createTask(spec);
      }
    }
  } catch (err) {
    if (ctxRef) ctxRef.log(`主动播报任务维护失败：${err && err.message ? err.message : err}`);
  }
}

// ── 退出登录 + 清空本地数据 ─────────────────────────────────────
async function logoutAndClear() {
  resetLogin();
  if (ctxRef && ctxRef.deps.secrets) {
    try {
      await ctxRef.deps.secrets.delete(TOKEN_SECRET_KEY);
    } catch {
      /* 忽略 */
    }
  }
  auth = null;
  client = null;
  cachedUid = 0;
  cache.summary = null;
  cache.fetchedAt = 0;
  if (ctxRef) {
    ctxRef.storage.set("lastSync", null);
    const prefs = readPrefs();
    let changed = false;
    if (prefs.proactive.enabled) {
      prefs.proactive.enabled = false;
      changed = true;
    }
    if (prefs.proactive.morning) {
      prefs.proactive.morning = false;
      changed = true;
    }
    if (prefs.proactive.remember) {
      prefs.proactive.remember = false;
      changed = true;
    }
    if (changed) writePrefs(prefs);
    await deleteAllTasks();
  }
  broadcastLoginState();
  if (ctxRef) ctxRef.log("已退出登录并清空本地健康数据");
  return { ok: true, connected: false };
}

// ── 同步 ──────────────────────────────────────────────────────
async function syncNow() {
  const c = await ensureClient();
  if (!c) return { ok: false, error: "尚未连接，请先在插件窗口扫码登录" };
  try {
    const summary = await c.getDailySummary(cachedUid, new Date());
    cache.summary = summary;
    cache.fetchedAt = Date.now();
    if (ctxRef) ctxRef.storage.set("lastSync", { at: cache.fetchedAt, date: summary.date });
    if (ctxRef) ctxRef.log(`健康数据同步完成：${summary.date}`);
    return { ok: true, summary };
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      // 401 已在客户端内部尝试 passToken 刷新；刷新后 auth.token 已更新，落盘复用。
      await persistToken(auth ? auth.token : null);
    }
    const message = err && err.message ? err.message : String(err);
    if (ctxRef) ctxRef.log(`健康数据同步失败：${message}`);
    return { ok: false, error: message };
  }
}

function startBackgroundSync() {
  if (syncTimer) return;
  const minutes = ctxRef ? readPrefs().syncIntervalMin : DEFAULT_SYNC_INTERVAL_MIN;
  syncTimer = setInterval(() => {
    void syncNow();
  }, minutes * 60 * 1000);
  if (syncTimer.unref) syncTimer.unref();
  if (ctxRef) ctxRef.log(`健康数据后台同步已启动（每 ${minutes} 分钟）`);
}

function restartBackgroundSync() {
  stopBackgroundSync();
  startBackgroundSync();
}

function stopBackgroundSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

// ── 文本格式化（供 AI 工具消费）──────────────────────────────────
function fmtMin(min) {
  if (!min) return "0 分钟";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} 小时 ${String(m).padStart(2, "0")} 分` : `${m} 分钟`;
}
function dayStr(epochSec) {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}
function describeSummary(summary) {
  const lines = [`【小米健康 · ${summary.date}】`];
  const s = summary.steps;
  const sl = summary.sleep;
  const hr = summary.heart_rate;
  if (s) lines.push(`步数：${s.steps} 步，约 ${(s.distance / 1000).toFixed(2)} 公里，消耗 ${s.calories} 千卡`);
  if (sl)
    lines.push(
      `睡眠：总计 ${fmtMin(sl.total_duration)}，评分 ${sl.sleep_score}，` +
        `深睡 ${fmtMin(sl.sleep_deep_duration)}，浅睡 ${fmtMin(sl.sleep_light_duration)}，REM ${fmtMin(sl.sleep_rem_duration)}`,
    );
  if (hr) lines.push(`心率：平均 ${hr.avg_hr}，最高 ${hr.max_hr}，最低 ${hr.min_hr}，静息 ${hr.avg_rhr}` + (hr.latest_hr ? `，最新 ${hr.latest_hr.bpm} bpm` : ""));
  if (lines.length === 1) lines.push("（今日暂无同步到的数据）");
  return lines.join("\n");
}
function describeSeries(items, kind) {
  if (!items || !items.length) return "（该区间暂无数据，可能设备未同步或未共享）";
  const lines = [`【小米健康 · ${kind} · 最近 ${items.length} 天】`];
  for (const it of items) {
    if (kind === "步数") lines.push(`${dayStr(it.time)}：${it.steps} 步，${(it.distance / 1000).toFixed(2)} 公里，${it.calories} 千卡`);
    else if (kind === "睡眠") lines.push(`${dayStr(it.time)}：总计 ${fmtMin(it.total_duration)}，评分 ${it.sleep_score}，深睡 ${fmtMin(it.sleep_deep_duration)}`);
    else if (kind === "心率") lines.push(`${dayStr(it.time)}：平均 ${it.avg_hr}，最高 ${it.max_hr}，最低 ${it.min_hr}，静息 ${it.avg_rhr}`);
  }
  return lines.join("\n");
}

// ── 扫码登录 ────────────────────────────────────────────────────
function resetLogin() {
  login.state = "idle";
  login.qr = "";
  login.loginUrl = "";
  login.error = "";
}

function startLogin() {
  if (login.state === "scanning" || login.state === "connecting") {
    return { ok: true, state: login.state, alreadyRunning: true };
  }
  resetLogin();
  auth = new XiaomiAuth();
  login.state = "connecting";
  void (async () => {
    try {
      const token = await auth.loginQr(async (qrImageUrl, loginUrl) => {
        login.qr = qrImageUrl || "";
        login.loginUrl = loginUrl || "";
        login.state = "scanning";
        broadcastLoginState();
      }, 300);
      await persistToken(token);
      login.state = "connected";
      broadcastLoginState();
      if (ctxRef) ctxRef.log(`小米健康扫码登录成功：user_id=${token.user_id}`);
      void syncNow();
    } catch (err) {
      login.state = "error";
      login.error = err && err.message ? err.message : String(err);
      broadcastLoginState();
      if (ctxRef) ctxRef.log(`小米健康扫码登录失败：${login.error}`);
    }
  })();
  return { ok: true, state: login.state };
}

function cancelLogin() {
  resetLogin();
  broadcastLoginState();
  return { ok: true, state: login.state };
}

function broadcastLoginState() {
  if (pluginWin && !pluginWin.isDestroyed()) {
    try {
      pluginWin.webContents.send(LOGIN_POLL_CHANNEL, snapshotLogin());
    } catch {
      /* 窗口正在关闭，忽略 */
    }
  }
}

function snapshotLogin() {
  return { state: login.state, qr: login.qr, loginUrl: login.loginUrl, error: login.error };
}

// ── UI 状态快照 ─────────────────────────────────────────────────
async function readStatus() {
  const token = await loadToken();
  const connected = Boolean(token && token.service_token && token.ssecurity);
  const lastSync = ctxRef ? ctxRef.storage.get("lastSync") : undefined;
  const prefs = readPrefs();
  const hasScheduler = Boolean(ctxRef && ctxRef.deps.scheduler);
  const tasks = [];
  if (hasScheduler) {
    try {
      const all = await ctxRef.deps.scheduler.listTasks();
      for (const t of all) {
        if (t.title && t.title.startsWith(TASK_PREFIX)) {
          tasks.push({ title: t.title, enabled: Boolean(t.enabled), nextFireAt: t.nextFireAt || null });
        }
      }
    } catch {
      /* 忽略 */
    }
  }
  return {
    connected,
    userId: token ? String(token.user_id || "") : "",
    canRefresh: Boolean(token && token.pass_token && token.user_id),
    loginState: login.state,
    qr: login.qr,
    loginUrl: login.loginUrl,
    loginError: login.error,
    lastSyncAt: lastSync && lastSync.at ? lastSync.at : cache.fetchedAt || 0,
    summary: cache.summary,
    prefs,
    hasScheduler,
    tasks,
    morningNoticeAck: Boolean(ctxRef && ctxRef.storage.get(MORNING_ACK_KEY)),
  };
}

// ── 工具执行封装：统一错误 → 友好文案 ────────────────────────────
async function runQuery(metric, days) {
  const c = await ensureClient();
  if (!c) return "尚未连接小米健康。请在「设置 · 插件」里打开小米健康窗口扫码登录后再试。";
  const n = Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 30) : 1;
  const today = new Date();
  try {
    if (metric === "today" || !metric) {
      const summary = await c.getDailySummary(cachedUid, today);
      cache.summary = summary;
      cache.fetchedAt = Date.now();
      return describeSummary(summary);
    }
    if (metric === "steps") return describeSeries(await c.getSteps(cachedUid, n), "步数");
    if (metric === "sleep") return describeSeries(await c.getSleep(cachedUid, n), "睡眠");
    if (metric === "heart") return describeSeries(await c.getHeartRate(cachedUid, n), "心率");
    if (metric === "range") {
      const [hr, sl, st] = await Promise.all([
        c.getHeartRate(cachedUid, n).catch(() => null),
        c.getSleep(cachedUid, n).catch(() => null),
        c.getSteps(cachedUid, n).catch(() => null),
      ]);
      return [describeSeries(st, "步数"), describeSeries(sl, "睡眠"), describeSeries(hr, "心率")].join("\n\n");
    }
    return `未知查询类型：${metric}`;
  } catch (err) {
    if (err instanceof DataNotSharedError) return `该项数据未在小米运动健康中共享（${err.dataType || metric}）。`;
    if (err instanceof FamilyMemberNotFoundError) return "未找到该健康数据成员，请确认扫码账号与设备归属一致。";
    if (err instanceof TokenExpiredError) return "小米登录已过期，请在插件窗口重新扫码登录。";
    return `查询小米健康数据失败：${err && err.message ? err.message : String(err)}`;
  }
}

// ── 窗口控制（frameless）──────────────────────────────────────────
function installWindowControls() {
  if (winControlsInstalled) return;
  const { ipcMain } = require("electron");
  ipcMain.on(WIN_MIN_CHANNEL, () => {
    if (pluginWin && !pluginWin.isDestroyed()) pluginWin.minimize();
  });
  ipcMain.on(WIN_CLOSE_CHANNEL, () => {
    if (pluginWin && !pluginWin.isDestroyed()) pluginWin.close();
  });
  winControlsInstalled = true;
}

const xiaomiHealthPlugin = {
  register(ctx) {
    ctxRef = ctx;

    ctx.registerTool({
      id: `${PLUGIN_ID}_query`,
      name: "小米健康数据查询",
      description:
        "查询机主小米运动健康（CN 区）的步数、睡眠、心率数据。当用户问「今天走了多少步」「昨晚睡得怎么样」「最近心率多少」等身体健康/运动数据相关问题时使用。metric=today 返回今天三合一摘要；steps/sleep/heart 返回最近 days 天该指标；range 返回最近 days 天三项汇总。",
      enabled: true,
      risk: "network",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          metric: {
            type: "string",
            enum: ["today", "steps", "sleep", "heart", "range"],
            description: "查询内容：today=今天摘要(默认) steps=步数 sleep=睡眠 heart=心率 range=多项汇总",
          },
          days: {
            type: "number",
            description: "回看天数，1-30，默认 1；metric=today 时忽略",
          },
        },
        required: [],
      },
      async execute(args) {
        const metric = typeof args.metric === "string" ? args.metric : "today";
        const days = typeof args.days === "number" ? args.days : 1;
        return runQuery(metric, days);
      },
    });

    ctx.registerTool({
      id: `${PLUGIN_ID}_status`,
      name: "小米健康连接状态",
      description: "查询小米运动健康插件的连接与同步状态（是否已登录、上次同步时间、今日摘要是否已缓存）。用于判断能否查询健康数据。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        const s = await readStatus();
        const lines = [];
        lines.push(`已连接：${s.connected ? "是" : "否"}`);
        if (s.connected) lines.push(`账号 user_id：${s.userId}`);
        lines.push(`上次同步：${s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString("zh-CN") : "从未"}`);
        if (s.summary) lines.push(describeSummary(s.summary));
        else lines.push("（缓存中暂无今日摘要）");
        return lines.join("\n");
      },
    });

    // 每轮上下文注入（受 chatInject 控制）：对话/播报轮强调用工具，发动态轮只供数据。
    ctx.registerPromptProvider({
      id: "health-context",
      modes: ["chat", "learn"],
      sources: ["conversation", "scheduler", "moments-post"],
      provide: (input) => buildHealthContext(input && input.source),
    });

    // UI IPC（宿主自动补前缀 → plugin:xiaomi-health:<channel>）
    ctx.registerIpc("status", () => readStatus());
    ctx.registerIpc("loginStart", () => startLogin());
    ctx.registerIpc("loginCancel", () => cancelLogin());
    ctx.registerIpc("sync", () => syncNow());
    ctx.registerIpc("getToday", async () => {
      const s = await readStatus();
      if (s.summary) return s.summary;
      const r = await syncNow();
      return r.ok ? r.summary : { error: r.error };
    });

    // 设置面板：读取 / 保存偏好（保存后重启后台同步 + 维护主动播报任务）
    ctx.registerIpc("getPrefs", () => readPrefs());
    ctx.registerIpc("setPrefs", async (prefs) => {
      const merged = sanitizePrefs(prefs);
      writePrefs(merged);
      restartBackgroundSync();
      await reconcileSchedulerTasks();
      const s = await readStatus();
      return { ok: true, prefs: merged, hasScheduler: s.hasScheduler, tasks: s.tasks, morningNoticeAck: s.morningNoticeAck };
    });
    // 首次看到「早安携带信息需醒后生效」提示后置位，不再重复弹。
    ctx.registerIpc("ackMorningNotice", () => {
      if (ctxRef) ctxRef.storage.set(MORNING_ACK_KEY, true);
      return { ok: true };
    });
    // 退出登录：清空 token + 缓存 + 主动播报任务
    ctx.registerIpc("logout", () => logoutAndClear());

    // 启动即尝试一次同步（若已登录）+ 维护主动播报任务 + 拉起后台定时；停止时清理。
    void (async () => {
      const c = await ensureClient();
      if (c) await syncNow();
      await reconcileSchedulerTasks();
      if (!ctx.signal.aborted) startBackgroundSync();
    })();
    ctx.onDispose(() => {
      stopBackgroundSync();
      void deleteAllTasks();
    });

    ctx.log("小米健康插件已注册：query / status 工具 + 对话注入 + 主动播报 + 健康记忆 + 连接窗口 IPC");
  },

  async open() {
    if (pluginWin && !pluginWin.isDestroyed()) {
      pluginWin.focus();
      return;
    }
    const { BrowserWindow } = require("electron");
    installWindowControls();
    pluginWin = new BrowserWindow({
      width: 460,
      height: 640,
      minWidth: 400,
      minHeight: 520,
      frame: false,
      resizable: true,
      autoHideMenuBar: true,
      backgroundColor: "#f5f5f7",
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });
    pluginWin.on("closed", () => {
      pluginWin = null;
    });
    await pluginWin.loadFile(path.join(__dirname, "ui.html"));
  },

  unregister() {
    stopBackgroundSync();
    if (pluginWin && !pluginWin.isDestroyed()) pluginWin.close();
    ctxRef = null;
    auth = null;
    client = null;
    cachedUid = 0;
    cache.summary = null;
    cache.fetchedAt = 0;
    resetLogin();
  },
};

module.exports = xiaomiHealthPlugin;
module.exports.default = xiaomiHealthPlugin;
