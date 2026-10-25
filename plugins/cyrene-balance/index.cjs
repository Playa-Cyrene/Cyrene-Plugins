"use strict";

/**
 * 昔涟 · 余额提醒 v2
 * 借鉴 dsh-cost-meter / dsh-whale-widget 的观测式记账与峰谷定价，重写为 Cyrene 插件。
 *
 * 记账口径：每次读到余额就和上一次比较，下降记作今日消费，上升记作充值；
 * 充值不会冲掉已经记下的消费。跨天自动归档，保留 7 天。
 */

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const os = require("node:os");
const { execFile } = require("node:child_process");

let BrowserWindowClass = null;
try {
  BrowserWindowClass = require("electron").BrowserWindow;
} catch {
  BrowserWindowClass = null;
}

const DEFAULT_THRESHOLD = 20;
const DEFAULT_REFRESH_SEC = 60;
const HISTORY_DAYS = 7;
const SETTINGS_KEY = "settings";
const LEDGER_KEY = "ledger";

const WIDGET_WIDTH = 203;
const WIDGET_HEIGHT = 250;

/** 高峰时段（北京时间，分钟） */
const PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
];

let ctxRef = null;
let timer = null;
let disposed = false;
let cached = null;
let win = null;
let mainWin = null;
let followMode = true;
let openTimer = null;
let lastError = "";
let tray = null;
let petReloading = false;
const SECRET_API_KEY = "deepseekApiKey";

/* ------------------------------ 设置 ------------------------------ */

const defaultSettings = () => ({
  threshold: DEFAULT_THRESHOLD,
  budget: 0,
  apiKey: "",
  enabled: true,
  refreshSec: DEFAULT_REFRESH_SEC,
  widgetScale: 1,
  autoOpen: true,
  followMain: true,
  widgetX: null,
  widgetY: null,
  stickerDuration: 3.4,
  stickerPlacement: "inside",
  stickerSize: 42,
  bubbleSize: "normal",
  bubbleWidth: 0,
  bubbleHeight: 0,
  bubbleMode: "rotate",
  bubblePlace: "top",
  bubbleFont: 1,
  talkFont: 12,
  rotateSec: 12,
  poseRotate: true,
  poseSec: 45,
  // 任务气泡 / 状态面板
  taskFont: 12,
  taskListHeight: 150,
  hudEnabled: false,
  hudDetail: "full",
  // 统一桌宠
  catchAsk: true,
  catchApproval: true,
  // 默认不藏原生卡：桌宠没接住时至少还有一处能答，避免两边都空着
  hideNativeCard: false,
  hideNativeTask: false,
  showTaskBubble: true,
  taskDetail: "auto",
});

async function getSettings() {
  if (!ctxRef) return defaultSettings();
  try {
    const raw = await ctxRef.storage.get(SETTINGS_KEY);
    if (!raw || typeof raw !== "object") return defaultSettings();
    return {
      threshold: Number.isFinite(Number(raw.threshold)) ? Number(raw.threshold) : DEFAULT_THRESHOLD,
      budget: Number.isFinite(Number(raw.budget)) ? Number(raw.budget) : 0,
      apiKey: "",
      enabled: raw.enabled !== false,
      refreshSec:
        Number.isFinite(Number(raw.refreshSec)) && Number(raw.refreshSec) >= 30
          ? Number(raw.refreshSec)
          : DEFAULT_REFRESH_SEC,
      widgetScale:
        Number.isFinite(Number(raw.widgetScale)) && Number(raw.widgetScale) >= 0.5 && Number(raw.widgetScale) <= 2
          ? Number(raw.widgetScale)
          : 1,
      autoOpen: raw.autoOpen !== false,
      followMain: raw.followMain !== false,
      widgetX: Number.isFinite(Number(raw.widgetX)) ? Number(raw.widgetX) : null,
      widgetY: Number.isFinite(Number(raw.widgetY)) ? Number(raw.widgetY) : null,
      stickerDuration:
        Number.isFinite(Number(raw.stickerDuration)) &&
        Number(raw.stickerDuration) >= 0.8 &&
        Number(raw.stickerDuration) <= 15
          ? Number(raw.stickerDuration)
          : 3.4,
      // 小表情固定在台词气泡里，忽略历史配置里的角落位置
      stickerPlacement: "inside",
      stickerSize: [32, 42, 52, 62].includes(Number(raw.stickerSize)) ? Number(raw.stickerSize) : 42,
      bubbleSize: ["compact", "normal", "roomy", "xlarge"].includes(raw.bubbleSize)
        ? raw.bubbleSize
        : "normal",
      bubbleWidth:
        Number.isFinite(Number(raw.bubbleWidth)) && Number(raw.bubbleWidth) >= 0 && Number(raw.bubbleWidth) <= 1400
          ? Math.round(Number(raw.bubbleWidth))
          : 0,
      bubbleHeight:
        Number.isFinite(Number(raw.bubbleHeight)) && Number(raw.bubbleHeight) >= 0 && Number(raw.bubbleHeight) <= 1400
          ? Math.round(Number(raw.bubbleHeight))
          : 0,
      bubbleMode: ["rotate", "info", "talk", "today", "balance"].includes(raw.bubbleMode)
        ? raw.bubbleMode
        : "rotate",
      bubblePlace: ["top", "middle", "bottom"].includes(raw.bubblePlace) ? raw.bubblePlace : "top",
      bubbleFont: [0.8, 1, 1.3, 1.6].includes(Number(raw.bubbleFont)) ? Number(raw.bubbleFont) : 1,
      talkFont: [10, 12, 14, 16, 18].includes(Number(raw.talkFont)) ? Number(raw.talkFont) : 12,
      rotateSec:
        Number.isFinite(Number(raw.rotateSec)) && Number(raw.rotateSec) >= 5 && Number(raw.rotateSec) <= 90
          ? Number(raw.rotateSec)
          : 12,
      poseRotate: raw.poseRotate !== false,
      poseSec: [20, 45, 90, 180].includes(Number(raw.poseSec)) ? Number(raw.poseSec) : 45,
      taskFont: [10, 12, 14, 16].includes(Number(raw.taskFont)) ? Number(raw.taskFont) : 12,
      taskListHeight: [100, 150, 220].includes(Number(raw.taskListHeight)) ? Number(raw.taskListHeight) : 150,
      hudEnabled: raw.hudEnabled === true,
      hudDetail: ["full", "simple", "simple2"].includes(raw.hudDetail) ? raw.hudDetail : "full",
      catchAsk: raw.catchAsk !== false,
      catchApproval: raw.catchApproval !== false,
      hideNativeCard: raw.hideNativeCard === true,
      hideNativeTask: raw.hideNativeTask === true,
      showTaskBubble: raw.showTaskBubble !== false,
      taskDetail: ["auto", "always", "hidden"].includes(raw.taskDetail) ? raw.taskDetail : "auto",
    };
  } catch {
    return defaultSettings();
  }
}

async function saveSettings(next) {
  if (!ctxRef) return;
  await ctxRef.storage.set(SETTINGS_KEY, next);
}

/** 读写宿主加密密钥存储；旧版本写在普通存储里的 Key 会自动迁移过去 */
async function getKey() {
  try {
    if (ctxRef && ctxRef.deps && ctxRef.deps.secrets) {
      const value = await ctxRef.deps.secrets.get(SECRET_API_KEY);
      if (value) return String(value);
    }
  } catch {
    /* 安全存储不可用时走下面的旧数据迁移 */
  }
  try {
    const raw = ctxRef ? await ctxRef.storage.get(SETTINGS_KEY) : null;
    const legacy = raw && typeof raw.apiKey === "string" ? raw.apiKey : "";
    if (legacy) {
      await setKey(legacy);
      const clean = Object.assign({}, raw);
      delete clean.apiKey;
      await ctxRef.storage.set(SETTINGS_KEY, clean);
      return legacy;
    }
  } catch {
    /* 忽略迁移失败 */
  }
  return "";
}

async function setKey(key) {
  if (!ctxRef || !ctxRef.deps || !ctxRef.deps.secrets) return false;
  await ctxRef.deps.secrets.set(SECRET_API_KEY, key);
  return true;
}

async function clearKey() {
  if (!ctxRef || !ctxRef.deps || !ctxRef.deps.secrets) return false;
  await ctxRef.deps.secrets.delete(SECRET_API_KEY);
  return true;
}

function readKeyFromModelSettings() {
  try {
    const file = path.join(process.env.APPDATA || "", "Cyrene", "model-settings.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const profiles = Array.isArray(data.modelProfiles) ? data.modelProfiles : [];
    const hit = profiles.find(
      (p) => p && typeof p.baseUrl === "string" && p.baseUrl.indexOf("api.deepseek.com") >= 0 && p.apiKey
    );
    return hit ? String(hit.apiKey) : "";
  } catch {
    return "";
  }
}

/* ------------------------------ 网络 ------------------------------ */

function httpGetJson(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = https.get(url, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 200000) req.destroy(new Error("响应体过大"));
      });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          /* 保留原文用于报错 */
        }
        done(resolve, { status: res.statusCode || 0, body: parsed, raw: body.slice(0, 300) });
      });
    });
    req.setTimeout(timeoutMs || 15000, () => {
      req.destroy(new Error("请求超时"));
    });
    req.on("error", (error) => done(reject, error));
  });
}

async function fetchBalance(apiKey, signal) {
  if (signal && signal.aborted) throw new Error("已取消");
  const res = await httpGetJson(
    "https://api.deepseek.com/user/balance",
    { Authorization: "Bearer " + apiKey, Accept: "application/json" },
    15000
  );
  if (res.status === 401 || res.status === 403) {
    throw new Error("API Key 无效或没有权限（HTTP " + res.status + "）");
  }
  if (res.status !== 200 || !res.body) {
    throw new Error("余额接口返回异常（HTTP " + res.status + "）" + (res.raw ? "：" + res.raw : ""));
  }
  const list = Array.isArray(res.body.balance_infos) ? res.body.balance_infos : [];
  const info = list[0] || {};
  return {
    available: Boolean(res.body.is_available),
    currency: String(info.currency || "CNY"),
    total: Number(info.total_balance || 0),
    granted: Number(info.granted_balance || 0),
    toppedUp: Number(info.topped_up_balance || 0),
  };
}

/* ------------------------------ 记账 ------------------------------ */

function todayKey(now) {
  const d = now || new Date();
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const y = bj.getUTCFullYear();
  const m = String(bj.getUTCMonth() + 1).padStart(2, "0");
  const day = String(bj.getUTCDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

const emptyLedger = (day) => ({
  day,
  spent: 0,
  recharge: 0,
  lastTotal: null,
  lastAt: 0,
  history: {},
});

async function readLedger() {
  try {
    const raw = await ctxRef.storage.get(LEDGER_KEY);
    if (raw && typeof raw === "object") {
      return {
        day: typeof raw.day === "string" ? raw.day : "",
        spent: Number(raw.spent) || 0,
        recharge: Number(raw.recharge) || 0,
        lastTotal: Number.isFinite(Number(raw.lastTotal)) ? Number(raw.lastTotal) : null,
        lastAt: Number(raw.lastAt) || 0,
        history: raw.history && typeof raw.history === "object" ? raw.history : {},
      };
    }
  } catch {
    /* 落到空账本 */
  }
  return emptyLedger(todayKey());
}

/**
 * 观测式记账：余额下降记消费，上升记充值，充值不冲掉消费。
 * 跨天时把前一天结果写入 history，保留最近 7 天。
 */
async function observe(balance) {
  const day = todayKey();
  let ledger = await readLedger();

  if (ledger.day !== day) {
    // 先把旧账本的 history 接过来，再重置当天计数，否则跨天会丢掉历史
    const history = ledger.history && typeof ledger.history === "object" ? ledger.history : {};
    if (ledger.day && ledger.spent > 0) {
      history[ledger.day] = Math.round(ledger.spent * 100) / 100;
    }
    const keys = Object.keys(history).sort();
    while (keys.length > HISTORY_DAYS) {
      delete history[keys.shift()];
    }
    // 跨天第一次观测不把隔夜差额算成今天的消费
    ledger = emptyLedger(day);
    ledger.history = history;
    ledger.lastTotal = balance.total;
    ledger.lastAt = Date.now();
    await saveLedger(ledger);
    return ledger;
  }

  if (ledger.lastTotal !== null && Number.isFinite(ledger.lastTotal)) {
    const diff = ledger.lastTotal - balance.total;
    if (diff > 0) {
      ledger.spent += diff;
    } else if (diff < 0) {
      ledger.recharge += -diff;
    }
  }

  ledger.lastTotal = balance.total;
  ledger.lastAt = Date.now();

  // 只保留 7 天
  const keys = Object.keys(ledger.history).sort();
  while (keys.length > HISTORY_DAYS) {
    delete ledger.history[keys.shift()];
  }

  await saveLedger(ledger);
  return ledger;
}

async function saveLedger(ledger) {
  if (!ctxRef) return;
  try {
    await ctxRef.storage.set(LEDGER_KEY, ledger);
  } catch (error) {
    if (ctxRef) ctxRef.log("账本写入失败：" + ((error && error.message) || error));
  }
}

/* ------------------------------ 峰谷 ------------------------------ */

function bjParts(date) {
  const d = new Date(date.getTime() + 8 * 3600 * 1000);
  return { day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

const isWeekend = (day) => day === 0 || day === 6;

function inPeak(day, minutes) {
  if (isWeekend(day)) return false;
  return PEAK_WINDOWS.some(([start, end]) => minutes >= start && minutes < end);
}

/** 距离下一次峰↔谷切换还有多少分钟 */
function minutesToTransition(now) {
  const { day, minutes } = bjParts(now);
  const peakNow = inPeak(day, minutes);
  for (let d = 0; d < 8; d++) {
    for (const mark of [540, 720, 840, 1080, 1440]) {
      const abs = d * 1440 + mark - minutes;
      if (abs <= 0) continue;
      const crossed = d + (mark === 1440 ? 1 : 0);
      const m2 = mark === 1440 ? 0 : mark;
      const d2 = (day + crossed) % 7;
      if (inPeak(d2, m2) !== peakNow) return abs;
    }
  }
  return null;
}

function peakState(now) {
  const { day, minutes } = bjParts(now);
  const peak = inPeak(day, minutes);
  const left = minutesToTransition(now);
  let next = "";
  if (left !== null) {
    if (left >= 1440) {
      next = Math.round(left / 1440) + " 天后";
    } else if (left >= 60) {
      next = Math.floor(left / 60) + " 小时 " + (left % 60) + " 分后";
    } else {
      next = left + " 分钟后";
    }
  }
  return {
    peak,
    label: peak ? "高峰价" : "谷价 · 半价",
    short: peak ? "峰" : "谷",
    nextLabel: peak ? "转谷" : "转峰",
    next,
  };
}

/* ------------------------------ 查询 ------------------------------ */

function money(value) {
  return Number(value || 0).toFixed(2);
}

function viewLabel(mode) {
  return (
    {
      rotate: "余额 / 台词 交替",
      info: "只显示余额",
      talk: "只显示台词",
      today: "只看今日额度",
      balance: "只看余额",
    }[mode] || mode
  );
}

async function query(options) {
  const opts = options || {};
  const settings = await getSettings();
  const key = (await getKey()) || readKeyFromModelSettings();
  if (!key) {
    return { ok: false, error: "还没拿到 DeepSeek 的 API Key，请在插件里设置一次。" };
  }
  try {
    const balance = await fetchBalance(key, ctxRef ? ctxRef.signal : null);
    const ledger = await observe(balance);
    const now = new Date();
    const peak = peakState(now);
    cached = {
      total: balance.total,
      currency: balance.currency,
      granted: balance.granted,
      toppedUp: balance.toppedUp,
      spent: ledger.spent,
      recharge: ledger.recharge,
      threshold: settings.threshold,
      budget: settings.budget,
      remain: settings.budget > 0 ? Math.max(0, settings.budget - ledger.spent) : null,
      limitRatio: settings.budget > 0 ? ledger.spent / settings.budget : 0,
      warnLimit: settings.budget > 0 && ledger.spent >= settings.budget * 0.8,
      low: balance.total < settings.threshold,
      overBudget: settings.budget > 0 && ledger.spent >= settings.budget,
      peak,
      at: now.toLocaleString("zh-CN", { hour12: false }),
      stale: false,
    };
    return { ok: true, balance, ledger, peak, settings };
  } catch (error) {
    // 网络抖动时沿用上一次成功的数据，只标记 stale
    if (cached) {
      cached.stale = true;
      return { ok: true, stale: true, error: (error && error.message) || "查询失败" };
    }
    return { ok: false, error: (error && error.message) || "查询失败" };
  }
}

async function tick() {
  if (disposed) return null;
  const settings = await getSettings();
  if (!settings.enabled) return null;
  const result = await query();
  lastError = result && !result.ok ? result.error : "";
  if (result.ok && result.stale && ctxRef) {
    ctxRef.log("余额刷新失败，沿用上次数据：" + result.error);
  }
  updateTrayTip();
  return result;
}

function formatReport(result, view) {
  if (!result.ok) return result.error;
  if (result.stale) {
    return "刚刚刷新失败，先给你看上次的数字：\n" + formatCached(view);
  }
  return formatCached(view);
}

function formatCached(view) {
  if (!cached) return "还没有余额数据。";
  const c = cached;
  const mode = view || "all";
  const limit = Number(c.budget) || 0;

  if (mode === "balance") {
    return (
      "DeepSeek 余额：" +
      c.currency +
      " " +
      money(c.total) +
      (c.stale ? "\n（数据可能不是最新）" : "")
    );
  }

  const todayLines = [
    "今日已用 " +
      money(c.spent) +
      " 元" +
      (limit > 0
        ? " / 额度 " + money(limit) + " 元，剩余 " + money(Math.max(0, limit - c.spent)) + " 元"
        : "，今日额度还没设置"),
    limit > 0 ? "额度已用 " + Math.round((c.spent / limit) * 100) + "%" : "额度已用 —",
  ];
  if (c.recharge > 0) todayLines.push("今日充值 " + money(c.recharge) + " 元");
  if (c.overBudget) todayLines.push("今天已经超过额度上限啦");
  else if (c.warnLimit) todayLines.push("已经用掉额度的八成，收着点呀");
  if (mode === "today") {
    if (c.stale) todayLines.push("（数据可能不是最新）");
    return todayLines.join("\n");
  }

  const lines = [
    "DeepSeek 余额：" + c.currency + " " + money(c.total),
    "今日消费 " + money(c.spent) + (c.recharge > 0 ? " · 今日充值 " + money(c.recharge) : ""),
  ];
  if (limit > 0) {
    lines.push(
      "今日额度 " +
        money(limit) +
        " 元，剩余 " +
        money(Math.max(0, limit - c.spent)) +
        " 元（已用 " +
        Math.round((c.spent / limit) * 100) +
        "%）"
    );
  }
  if (c.granted > 0) lines.push("其中赠金 " + money(c.granted));
  lines.push("当前" + c.peak.label + (c.peak.next ? "，" + c.peak.next + c.peak.nextLabel : ""));
  if (c.low) lines.push("已低于提醒阈值 " + money(c.threshold) + " 元");
  if (c.overBudget) lines.push("今日已超出额度上限 " + money(limit) + " 元");
  else if (c.warnLimit) lines.push("今日额度已用 " + Math.round((c.spent / limit) * 100) + "%，留意一下");
  if (c.stale) lines.push("（数据可能不是最新）");
  return lines.join("\n");
}

function historyLines(ledger) {
  const entries = Object.keys(ledger.history || {})
    .sort()
    .slice(-HISTORY_DAYS);
  if (!entries.length) return "还没有历史记录，明天开始会有。";
  return entries
    .map((date) => {
      const value = Number(ledger.history[date]) || 0;
      const barLen = Math.min(12, Math.round(value * 2));
      return date.slice(5) + "  " + money(value).padStart(6) + " 元 " + "▍".repeat(barLen);
    })
    .join("\n");
}

/* ------------------------------ 挂件 ------------------------------ */

async function buildWidgetPayload() {
  const settings = await getSettings();
  if (!cached) {
    return {
      ok: false,
      error: lastError || "还没查到余额",
      currency: "CNY",
      total: 0,
      spent: 0,
      recharge: 0,
      threshold: settings.threshold,
      budget: settings.budget,
      remain: null,
      limitRatio: 0,
      warnLimit: false,
      bubbleMode: settings.bubbleMode,
      low: false,
      overBudget: false,
      peak: peakState(new Date()),
      at: "",
      stale: false,
      scale: settings.widgetScale,
    };
  }
  return {
    ok: true,
    currency: cached.currency,
    total: cached.total,
    spent: cached.spent,
    recharge: cached.recharge,
    threshold: cached.threshold,
    budget: cached.budget,
    remain: cached.remain,
    limitRatio: cached.limitRatio,
    warnLimit: cached.warnLimit,
    bubbleMode: settings.bubbleMode,
    low: cached.low,
    overBudget: cached.overBudget,
    peak: cached.peak,
    at: cached.at,
    stale: cached.stale,
    scale: settings.widgetScale,
  };
}

function findMainWindow() {
  if (!BrowserWindowClass) return null;
  const all = BrowserWindowClass.getAllWindows();
  let best = null;
  let bestArea = 0;
  for (const w of all) {
    if (!w || w.isDestroyed() || w === win) continue;
    try {
      if (!w.isVisible()) continue;
      const b = w.getBounds();
      const area = b.width * b.height;
      if (area > bestArea) { bestArea = area; best = w; }
    } catch {
      /* 跳过异常窗口 */
    }
  }
  return best;
}

function mainContentBounds() {
  if (!mainWin || mainWin.isDestroyed()) return null;
  try {
    // getPosition 返回屏幕坐标，getContentSize 只给尺寸，必须把原点带上
    const pos = mainWin.getPosition();
    const size = mainWin.getContentSize();
    return { x: pos[0], y: pos[1], w: size[0], h: size[1] };
  } catch {
    return null;
  }
}

// 把挂件限制在主窗口内（超出就拉回右下角）
function keepInsideMain() {
  if (!win || win.isDestroyed() || !mainWin || mainWin.isDestroyed()) return;
  try {
    const size = mainContentBounds();
    if (!size) return;
    const b = win.getBounds();
    const margin = 12;
    let x = b.x;
    let y = b.y;
    const minX = size.x + margin;
    const minY = size.y + margin;
    const maxX = size.x + size.w - b.width - margin;
    const maxY = size.y + size.h - b.height - margin;
    x = Math.min(Math.max(x, minX), Math.max(minX, maxX));
    y = Math.min(Math.max(y, minY), Math.max(minY, maxY));
    if (x !== b.x || y !== b.y) win.setPosition(Math.round(x), Math.round(y));
  } catch {
    /* 忽略 */
  }
}

function snapToEdge() {
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.getBounds();
    const gap = 16;
    let x = bounds.x;
    let y = bounds.y;
    if (followMode) {
      if (!mainWin || mainWin.isDestroyed()) return;
      const size = mainContentBounds();
      if (!size) return;
      if (Math.abs(bounds.x - size.x) < gap) x = size.x;
      if (Math.abs(size.x + size.w - (bounds.x + bounds.width)) < gap) x = size.x + size.w - bounds.width;
      if (Math.abs(bounds.y - size.y) < gap) y = size.y;
      if (Math.abs(size.y + size.h - (bounds.y + bounds.height)) < gap) y = size.y + size.h - bounds.height;
      // 主窗口移动或缩放后，挂件不能留在窗口外
      x = Math.min(Math.max(x, size.x), size.x + size.w - bounds.width);
      y = Math.min(Math.max(y, size.y), size.y + size.h - bounds.height);
    } else {
      const { screen } = require("electron");
      const area = screen.getDisplayMatching(bounds).workArea;
      if (Math.abs(bounds.x - area.x) < gap) x = area.x;
      if (Math.abs(area.x + area.width - (bounds.x + bounds.width)) < gap) x = area.x + area.width - bounds.width;
      if (Math.abs(bounds.y - area.y) < gap) y = area.y;
      if (Math.abs(area.y + area.height - (bounds.y + bounds.height)) < gap) y = area.y + area.height - bounds.height;
    }
    if (x !== bounds.x || y !== bounds.y) win.setPosition(Math.round(x), Math.round(y));
  } catch {
    /* 吸附失败不影响主流程 */
  }
}

async function saveWidgetPosition() {
  // 独立模式下保存屏幕坐标；跟随模式下位置随主窗口走，不持久化
  if (!win || win.isDestroyed() || !ctxRef || followMode) return;
  try {
    const bounds = win.getBounds();
    const settings = await getSettings();
    settings.widgetX = bounds.x;
    settings.widgetY = bounds.y;
    await saveSettings(settings);
  } catch {
    /* 忽略 */
  }
}

function placeWidget(settings) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const margin = 16;
  if (followMode) {
    const size = mainContentBounds();
    if (!size) return;
    win.setPosition(
      Math.round(size.x + size.w - b.width - margin),
      Math.round(size.y + size.h - b.height - margin),
    );
  } else {
    const { screen } = require("electron");
    const area = screen.getPrimaryDisplay().workArea;
    const savedX = settings ? settings.widgetX : null;
    const savedY = settings ? settings.widgetY : null;
    let x = Number.isFinite(savedX) ? savedX : area.x + area.width - b.width - 28;
    let y = Number.isFinite(savedY) ? savedY : area.y + area.height - b.height - 28;
    x = Math.min(Math.max(x, area.x), area.x + area.width - b.width);
    y = Math.min(Math.max(y, area.y), area.y + area.height - b.height);
    win.setPosition(Math.round(x), Math.round(y));
  }
}

/* ------------------------------ 托盘 / 一键归位 ------------------------------ */

function trayIconImage() {
  try {
    const { nativeImage } = require("electron");
    const candidates = ["assets/mimi.png", "assets/frame-01.png", "assets/DSniang1.png"];
    for (const rel of candidates) {
      const file = path.join(__dirname, rel);
      if (!fs.existsSync(file)) continue;
      const image = nativeImage.createFromPath(file);
      if (image.isEmpty()) continue;
      const size = image.getSize();
      if (!size.width || !size.height) return image;
      // 托盘只显示 16~20px，大图先等比缩下来，常驻内存也小
      const target = 20;
      const ratio = Math.min(target / size.width, target / size.height);
      if (ratio >= 1) return image;
      return image.resize({
        width: Math.max(1, Math.round(size.width * ratio)),
        height: Math.max(1, Math.round(size.height * ratio)),
        quality: "best",
      });
    }
    return nativeImage.createEmpty();
  } catch {
    return null;
  }
}

function updateTrayTip() {
  if (!tray) return;
  try {
    const tip =
      cached && Number.isFinite(Number(cached.total))
        ? "昔涟 · 余额 " + money(cached.total) + " " + (cached.currency || "CNY")
        : "昔涟 · 桌面桌宠";
    tray.setToolTip(tip);
  } catch {
    /* 忽略 */
  }
}

function wakeMainWindow() {
  if (!mainWin || mainWin.isDestroyed()) return;
  try {
    if (mainWin.isMinimized()) mainWin.restore();
    if (!mainWin.isVisible()) mainWin.showInactive();
  } catch {
    /* 忽略 */
  }
}

function recenterPet(options) {
  const opts = options || {};
  if (!win || win.isDestroyed()) {
    if (opts.reopen === false) return false;
    void openWidget()
      .then(() => {
        setTimeout(() => recenterPet({ reopen: false, save: opts.save }), 150);
      })
      .catch((error) => petLog("归位时打开桌宠失败：" + ((error && error.message) || error)));
    return false;
  }
  try {
    const { screen } = require("electron");
    wakeMainWindow();
    const b = win.getBounds();
    let x = null;
    let y = null;
    if (followMode && mainWin && !mainWin.isDestroyed()) {
      const size = mainContentBounds();
      if (size) {
        const margin = 16;
        x = size.x + size.w - b.width - margin;
        y = size.y + size.h - b.height - margin;
      }
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const area = screen.getPrimaryDisplay().workArea;
      x = area.x + area.width - b.width - 28;
      y = area.y + area.height - b.height - 28;
    }
    // 主窗口在副屏边缘或分辨率变化时，目标点也可能越界，最后再夹一次
    const area = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea;
    const finalX = Math.min(Math.max(x, area.x), Math.max(area.x, area.x + area.width - b.width));
    const finalY = Math.min(Math.max(y, area.y), Math.max(area.y, area.y + area.height - b.height));
    win.setPosition(Math.round(finalX), Math.round(finalY));
    if (!win.isVisible()) win.showInactive();
    try { win.moveTop(); } catch { /* 忽略 */ }
    if (!followMode) {
      try { win.setAlwaysOnTop(true, "floating"); } catch { /* 忽略 */ }
    }
    if (opts.save !== false && !followMode) void saveWidgetPosition();
    petLog("归位 -> " + Math.round(finalX) + "," + Math.round(finalY));
    return true;
  } catch (error) {
    petLog("归位失败：" + ((error && error.message) || error));
    return false;
  }
}

function togglePet() {
  if (!win || win.isDestroyed()) {
    void openWidget().catch((error) => petLog("打开桌宠失败：" + ((error && error.message) || error)));
    return;
  }
  try {
    if (win.isVisible()) {
      win.hide();
    } else {
      wakeMainWindow();
      win.showInactive();
      try { win.moveTop(); } catch { /* 忽略 */ }
    }
  } catch {
    /* 忽略 */
  }
}

function reloadPet() {
  petReloading = true;
  closeWidget();
  setTimeout(() => {
    petReloading = false;
    if (disposed) return;
    void openWidget()
      .then(() => setTimeout(() => recenterPet({ save: true }), 150))
      .catch((error) => petLog("重新加载桌宠失败：" + ((error && error.message) || error)));
  }, 260);
}

function buildTrayMenu() {
  const { Menu } = require("electron");
  return Menu.buildFromTemplate([
    { label: "♡ 一键归位", click: () => recenterPet() },
    { label: "显示 / 隐藏桌宠", click: () => togglePet() },
    { label: "重新加载桌宠", click: () => reloadPet() },
    { type: "separator" },
    { label: "立即刷新余额", click: () => { void tick(); } },
    { type: "separator" },
    { label: "桌宠不显示时，点这里把她找回来", enabled: false },
  ]);
}

function ensureTray() {
  if (tray || disposed) return;
  let TrayClass = null;
  try {
    TrayClass = require("electron").Tray;
  } catch {
    TrayClass = null;
  }
  if (!TrayClass) return;
  const image = trayIconImage();
  if (!image) return;
  try {
    tray = new TrayClass(image);
    tray.setToolTip("昔涟 · 桌面桌宠");
    tray.setContextMenu(buildTrayMenu());
    // Windows 上左键单击直接归位；双击会再触发一次，归位是幂等的
    tray.on("click", () => recenterPet());
    tray.on("double-click", () => recenterPet());
    petLog("托盘图标已就绪");
  } catch (error) {
    tray = null;
    petLog("托盘创建失败：" + ((error && error.message) || error));
  }
}

function destroyTray() {
  if (!tray) return;
  try { tray.destroy(); } catch { /* 忽略 */ }
  tray = null;
}

/* ------------------------------ 状态面板 ------------------------------ */

let hudTimer = null;
let cpuSnapshot = os.cpus();
let widgetHeightCache = WIDGET_HEIGHT;
let widgetWidthCache = WIDGET_WIDTH;

function cpuUsagePercent() {
  const now = os.cpus();
  let idleDiff = 0;
  let totalDiff = 0;
  now.forEach((core, index) => {
    const prev = cpuSnapshot[index] ? cpuSnapshot[index].times : core.times;
    const cur = core.times;
    const prevTotal = prev.user + prev.nice + prev.sys + prev.idle + prev.irq;
    const curTotal = cur.user + cur.nice + cur.sys + cur.idle + cur.irq;
    idleDiff += cur.idle - prev.idle;
    totalDiff += curTotal - prevTotal;
  });
  cpuSnapshot = now;
  if (totalDiff <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idleDiff / totalDiff) * 100));
}

function readModelInfo() {
  try {
    const file = path.join(process.env.APPDATA || "", "Cyrene", "model-settings.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const profiles = Array.isArray(data.modelProfiles) ? data.modelProfiles : [];
    const active =
      profiles.find((p) => p && p.id === data.defaultModelProfileId) ||
      profiles.find((p) => p && typeof p.baseUrl === "string" && p.baseUrl.indexOf("api.deepseek.com") >= 0) ||
      profiles[0] ||
      null;
    if (!active) return { model: "未配置", detail: "模型设置里没有可用配置" };
    const name = active.model || active.displayName || "未命名模型";
    const provider = active.displayName || active.provider || "";
    return { model: name, detail: provider ? provider + " · " + name : name };
  } catch {
    return { model: "未配置", detail: "读不到 model-settings.json" };
  }
}

function moodSnapshot() {
  // 桌宠心情的用词：在忙 / 担心 / 困 / 早安 / 轻松 / 平静
  const hour = new Date().getHours();
  if (petWorking) return { label: "在忙", tone: "busy" };
  if (cached && (cached.low || cached.overBudget)) return { label: "有点担心", tone: "low" };
  if (hour >= 23 || hour < 6) return { label: "有点困", tone: "quiet" };
  if (hour >= 6 && hour < 10) return { label: "早安", tone: "calm" };
  if (petTodos.length > 0 && petTodos.every((t) => t.status === "completed")) {
    return { label: "轻松", tone: "calm" };
  }
  return { label: "平静", tone: "calm" };
}

/* GPU / 网速 / 电量：一次 PowerShell 拿齐，缓存六秒，失败后三十秒再试 */
const SYS_PROBE_PS = [
  "$r=[ordered]@{}",
  "$net=@(Get-NetAdapterStatistics -ErrorAction SilentlyContinue)",
  "if($net.Count){$r.net=@{r=[double](($net|Measure-Object ReceivedBytes -Sum).Sum);s=[double](($net|Measure-Object SentBytes -Sum).Sum)}}else{$r.net=$null}",
  "$b=Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue|Select-Object -First 1",
  "if($b){$r.bat=@{p=[int]$b.EstimatedChargeRemaining;charging=[bool]($b.BatteryStatus -eq 2 -or $b.BatteryStatus -ge 6)}}else{$r.bat=$null}",
  "$g=Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue|Measure-Object -Property UtilizationPercentage -Sum",
  "if($g.Sum -ne $null){$r.gpu=[math]::Round([double]$g.Sum,1)}else{$r.gpu=$null}",
  "ConvertTo-Json -InputObject $r -Compress -Depth 4",
].join("; ");

let sysProbeRaw = null;
let sysProbeAt = 0;
let sysProbePending = null;
let sysProbeRetryAt = 0;
let lastNetSample = null;

function runPowerShell(script, timeout) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout, windowsHide: true },
      (error, stdout) => resolve(error ? "" : String(stdout || "")),
    );
  });
}

async function probeSystem() {
  const now = Date.now();
  if (sysProbeRaw && now - sysProbeAt < 6000) return sysProbeRaw;
  if (now < sysProbeRetryAt) return sysProbeRaw;
  if (!sysProbePending) {
    sysProbePending = runPowerShell(SYS_PROBE_PS, 8000)
      .then((out) => {
        if (!out.trim()) {
          sysProbeRetryAt = Date.now() + 30000;
          return sysProbeRaw;
        }
        try {
          sysProbeRaw = JSON.parse(out);
          sysProbeAt = Date.now();
        } catch {
          sysProbeRetryAt = Date.now() + 30000;
        }
        return sysProbeRaw;
      })
      .finally(() => {
        sysProbePending = null;
      });
  }
  return sysProbePending;
}

function netSpeed(probe, sampleAt) {
  const empty = { down: null, up: null };
  if (!probe || !probe.net) return empty;
  const received = Number(probe.net.r);
  const sent = Number(probe.net.s);
  if (!Number.isFinite(received) || !Number.isFinite(sent)) return empty;
  const current = { r: received, s: sent, at: sampleAt || Date.now() };
  const previous = lastNetSample;
  lastNetSample = current;
  if (!previous || current.at <= previous.at || current.r < previous.r || current.s < previous.s) {
    return empty;
  }
  const seconds = (current.at - previous.at) / 1000;
  if (seconds <= 0) return empty;
  return { down: (current.r - previous.r) / seconds, up: (current.s - previous.s) / seconds };
}

async function hudSnapshot() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = Math.max(0, total - free);
  const memPercent = total > 0 ? (used / total) * 100 : 0;
  const model = readModelInfo();
  const probe = await probeSystem();
  const net = netSpeed(probe, sysProbeAt);
  const gpuRaw = Number(probe && probe.gpu);
  const gpu = Number.isFinite(gpuRaw) ? Math.min(100, Math.max(0, Math.round(gpuRaw))) : null;
  const batteryRaw = Number(probe && probe.bat && probe.bat.p);
  const battery = Number.isFinite(batteryRaw) && batteryRaw >= 0 && batteryRaw <= 100 ? Math.round(batteryRaw) : null;
  return {
    cpu: Math.round(cpuUsagePercent() * 10) / 10,
    memPercent: Math.round(memPercent * 10) / 10,
    memText:
      (used / 1073741824).toFixed(1) + " GB / " + (total / 1073741824).toFixed(1) + " GB",
    gpu,
    netDown: net.down,
    netUp: net.up,
    battery,
    charging: Boolean(probe && probe.bat && probe.bat.charging),
    mood: moodSnapshot(),
    model: model.model,
    modelDetail: model.detail + (petWorking ? " · 生成中" : " · 待命"),
    working: Boolean(petWorking),
    at: Date.now(),
  };
}

async function pushHud() {
  if (!win || win.isDestroyed()) return;
  let data;
  try {
    data = await hudSnapshot();
  } catch {
    return;
  }
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send("balance-pet-hud", data);
  } catch {
    /* 忽略 */
  }
}

function startHud() {
  if (hudTimer) clearInterval(hudTimer);
  hudTimer = setInterval(pushHud, 3000);
  setTimeout(pushHud, 700);
}

function stopHud() {
  if (hudTimer) clearInterval(hudTimer);
  hudTimer = null;
}

function setWidgetHeight(cssHeight) {
  if (!win || win.isDestroyed()) return;
  const scale = widgetScaleCache || 1;
  const css = Math.max(200, Math.min(780, Number(cssHeight) || WIDGET_HEIGHT));
  widgetHeightCache = css;
  const height = Math.round(css * scale);
  const bounds = win.getBounds();
  if (Math.abs(bounds.height - height) < 2) return;
  const bottom = bounds.y + bounds.height;
  win.setBounds(
    { x: bounds.x, y: Math.round(bottom - height), width: bounds.width, height },
    false,
  );
  keepInsideMain();
}

/** 气泡要求更宽时，窗口以右边缘为锚点向左长，不遮挡立绘 */
function setWidgetWidth(cssWidth) {
  if (!win || win.isDestroyed()) return;
  const scale = widgetScaleCache || 1;
  const css = Math.max(WIDGET_WIDTH, Math.min(1400, Number(cssWidth) || WIDGET_WIDTH));
  widgetWidthCache = css;
  const width = Math.round(css * scale);
  const bounds = win.getBounds();
  if (Math.abs(bounds.width - width) < 2) return;
  const right = bounds.x + bounds.width;
  win.setBounds(
    { x: Math.round(right - width), y: bounds.y, width, height: bounds.height },
    false,
  );
  keepInsideMain();
}

function resizeWidget(scale) {
  if (!win || win.isDestroyed()) return;
  const width = Math.round(widgetWidthCache * scale);
  const height = Math.round((widgetHeightCache || WIDGET_HEIGHT) * scale);
  const bounds = win.getBounds();
  // 底边 + 水平中心为锚点：缩小/放大时角色留在原地，不会被推出可视区
  const centerX = bounds.x + bounds.width / 2;
  const bottom = bounds.y + bounds.height;
  win.setBounds(
    { x: Math.round(centerX - width / 2), y: Math.round(bottom - height), width, height },
    false,
  );
  keepInsideMain();
}

function attachMainListeners() {
  if (!mainWin || mainWin.isDestroyed()) return;
  const reposition = () => {
    try { keepInsideMain(); } catch { /* 忽略 */ }
  };
  mainWin.on("move", reposition);
  mainWin.on("resize", reposition);
  mainWin.on("minimize", () => { if (win && !win.isDestroyed()) win.hide(); });
  mainWin.on("restore", () => { if (win && !win.isDestroyed()) win.show(); });
  mainWin.on("closed", () => { mainWin = null; });
}

async function openWidget() {
  if (!BrowserWindowClass) {
    throw new Error("当前环境拿不到 BrowserWindow，无法打开挂件");
  }
  if (win && !win.isDestroyed()) {
    win.show();
    return;
  }
  const settings = await getSettings();
  const scale = settings.widgetScale || 1;
  widgetScaleCache = scale;
  const width = Math.round(widgetWidthCache * scale);
  const baseHeight = settings.hudEnabled ? WIDGET_HEIGHT + 78 : WIDGET_HEIGHT;
  widgetHeightCache = baseHeight;
  const height = Math.round(baseHeight * scale);

  followMode = settings.followMain !== false;
  mainWin = followMode ? findMainWindow() : null;

  win = new BrowserWindowClass({
    parent: mainWin || undefined,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: !followMode,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      nodeIntegration: true,
      // 卡片是 iframe 里的独立文档，不开这个它连 ipcRenderer 都拿不到
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });
  if (!followMode) {
    try { win.setAlwaysOnTop(true, "floating"); } catch { /* 忽略 */ }
  }
  win.loadFile(path.join(__dirname, "widget.html"));
  win.webContents.on("did-finish-load", () => {
    pushPetTodo();
    startHud();
    if (petMode === "card" && petCardPayload) {
      try {
        win.webContents.send(PET_CARD_SHOW, petCardPayload);
      } catch {
        /* 忽略 */
      }
    }
  });
  // 渲染进程偶尔会因为显卡 / 内存被系统收走，窗口还在但内容空白；自动重载一次
  win.webContents.on("render-process-gone", (_event, details) => {
    petLog("渲染进程退出：" + ((details && details.reason) || "unknown"));
    if (disposed || petReloading) return;
    setTimeout(() => {
      if (disposed || petReloading || !win || win.isDestroyed()) return;
      try { win.reload(); } catch { /* 忽略 */ }
    }, 800);
  });
  placeWidget(settings);
  if (followMode) attachMainListeners();

  let moveTimer = null;
  win.on("moved", () => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      snapToEdge();
      void saveWidgetPosition();
    }, 220);
  });

  win.once("ready-to-show", () => {
    if (win && !win.isDestroyed() && (!followMode || !mainWin || mainWin.isDestroyed() || mainWin.isVisible())) {
      win.show();
    }
  });
  win.on("closed", () => {
    if (moveTimer) clearTimeout(moveTimer);
    win = null;
  });
}

function closeWidget() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  stopHud();
  mainWin = null;
}

/* ------------------------------ 统一桌宠：提问 / 审批 / 任务 ------------------------------ */

const CARD_WIDTH = 420;
const CARD_HEIGHT = 580;
const CH_AGUI = "agui:event";
const CH_ASK = "cyrene.choice";
const CH_ASK_DISMISS = "cyrene.choice.dismiss";
const CH_APPROVAL_REQUEST = "permission:approval-request";
const CH_APPROVAL_SETTLED = "permission:approval-settled";
const PET_CARD_SHOW = "balance-card:show";
const PET_CARD_HIDE = "balance-card:hide";
const PET_TODO = "balance-todo";
const PET_STATE = "balance-pet-state";

let widgetScaleCache = 1;
let petMode = "idle";
let petCard = null;
let petCardPayload = null;
// 重载会重建窗口，内存里的卡片会丢；把没答完的卡记一份，回来还能接着答
const PENDING_CARD_KEY = "pendingPetCard";
let petTodos = [];
let petWorking = false;
let petHooked = [];
let petHookTimer = null;
let petFlags = {
  catchAsk: true,
  catchApproval: true,
  hideNativeCard: false,
  hideNativeTask: false,
  showTaskBubble: true,
  taskDetail: "auto",
};

function petLog(message) {
  if (!ctxRef || disposed) return;
  try {
    ctxRef.log("[桌宠] " + message);
  } catch {
    /* 忽略 */
  }
}

// 提问链路诊断：ctx.log 不方便回读，这里再落一份文件，方便确认"拦到没有 / 桌宠收没收到"
function debugLog(message) {
  petLog(message);
  try {
    const fs = require("fs");
    const path = require("path");
    const { app } = require("electron");
    const dir = path.join(app.getPath("userData"), "plugin-data", "cyrene-balance");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "ask-debug.log");
    try {
      if (fs.statSync(file).size > 64 * 1024) fs.writeFileSync(file, "");
    } catch {
      /* 文件还不存在 */
    }
    fs.appendFileSync(file, new Date().toISOString() + " " + message + "\n", "utf8");
  } catch {
    /* 诊断日志失败不影响主流程 */
  }
}

function detectPetKind(card) {
  if (!card || typeof card !== "object") return null;
  if (Array.isArray(card.questions)) return "ask";
  if (typeof card.id === "string" && typeof card.question === "string") return "choice";
  return null;
}

function petCardId(kind, card) {
  if (!card || typeof card !== "object") return null;
  if (kind === "ask") return typeof card.interactionId === "string" ? card.interactionId : null;
  return typeof card.id === "string" ? card.id : null;
}

function isOwnWidget(target) {
  if (!win || win.isDestroyed()) return false;
  try {
    return win.webContents === target;
  } catch {
    return false;
  }
}

// 展开/收起时保持右下角锚点不变，卡片向左上方生长
function applyPetSize(expanded) {
  if (!win || win.isDestroyed()) return;
  const width = Math.round((expanded ? CARD_WIDTH : widgetWidthCache) * widgetScaleCache);
  const baseH = expanded ? CARD_HEIGHT : (widgetHeightCache || WIDGET_HEIGHT);
  const height = Math.round(baseH * widgetScaleCache);
  try {
    const bounds = win.getBounds();
    let x = bounds.x + bounds.width - width;
    let y = bounds.y + bounds.height - height;
    try {
      const { screen } = require("electron");
      const area = screen.getDisplayMatching(bounds).workArea;
      x = Math.min(Math.max(x, area.x), area.x + area.width - width);
      y = Math.min(Math.max(y, area.y), area.y + area.height - height);
    } catch {
      /* 忽略 */
    }
    win.setBounds({ x, y, width, height });
  } catch (error) {
    petLog("调整窗口尺寸失败：" + ((error && error.message) || error));
  }
}

function normalizePetTodos(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item === "object" && typeof item.content === "string")
    .slice(0, 30)
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : String(item.id || ""),
      content: item.content,
      status: ["pending", "in_progress", "completed", "cancelled"].includes(item.status)
        ? item.status
        : "pending",
      priority: typeof item.priority === "string" ? item.priority : undefined,
    }));
}

function pushPetTodo() {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(PET_TODO, {
      items: petTodos,
      working: petWorking,
      flags: petFlags,
      mode: petMode,
    });
  } catch {
    /* 忽略 */
  }
}

async function presentPetCard(kind, card, options) {
  const id = petCardId(kind, card);
  if (!id) return false;
  if (!win || win.isDestroyed()) {
    try {
      await openWidget();
    } catch (error) {
      petLog("打开桌宠失败：" + ((error && error.message) || error));
      return false;
    }
  }
  if (!win || win.isDestroyed()) return false;

  petCard = { kind, id };
  petCardPayload = { kind, card };
  petMode = "card";
  if (ctxRef && !(options && options.restoring)) {
    try {
      void Promise.resolve(ctxRef.storage.set(PENDING_CARD_KEY, { kind, card, at: Date.now() })).catch(() => {});
    } catch {
      /* 存不下也不影响当前展示 */
    }
  }
  applyPetSize(true);
  try {
    if (typeof win.isVisible === "function" && !win.isVisible()) win.show();
    win.webContents.send(PET_CARD_SHOW, { kind, card });
    debugLog("卡片已下发 kind=" + kind + " id=" + id + " 窗口=" + (win && !win.isDestroyed() ? "可用" : "缺失"));
  } catch (error) {
    debugLog("下发卡片失败：" + ((error && error.message) || error));
  }
  return true;
}

function collapsePetCard(settlement) {
  if (petMode !== "card") return;
  const id = settlement && typeof settlement === "object" ? settlement.id : undefined;
  if (typeof id === "string" && petCard && id !== petCard.id) return;
  const reason = settlement && typeof settlement.reason === "string" ? settlement.reason : "closed";
  petMode = "idle";
  petCard = null;
  petCardPayload = null;
  if (ctxRef) {
    try {
      void Promise.resolve(ctxRef.storage.set(PENDING_CARD_KEY, null)).catch(() => {});
    } catch {
      /* 忽略 */
    }
  }
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send(PET_CARD_HIDE, reason);
    } catch {
      /* 忽略 */
    }
  }
  setTimeout(() => {
    if (petMode === "idle") applyPetSize(false);
  }, 400);
}

// 重载/重启会丢掉内存里的 payload，把最近十分钟没答完的卡从存储里捞回来
async function restorePendingCard() {
  if (!ctxRef) return;
  if (petFlags.catchAsk === false) return;
  let saved = null;
  try {
    saved = await ctxRef.storage.get(PENDING_CARD_KEY);
  } catch {
    return;
  }
  if (!saved || typeof saved !== "object" || !saved.card || !saved.kind) return;

  const age = Date.now() - Number(saved.at || 0);
  if (!(age >= 0 && age <= 10 * 60 * 1000)) {
    try {
      await ctxRef.storage.set(PENDING_CARD_KEY, null);
    } catch {
      /* 忽略 */
    }
    return;
  }
  if (petMode === "card" && petCardPayload) return;

  debugLog("恢复未回答卡片 kind=" + saved.kind + " id=" + (petCardId(saved.kind, saved.card) || ""));
  await presentPetCard(saved.kind, saved.card, { restoring: true });
}

/**
 * @returns {boolean} true = 拦下这一条，不再发给原窗口
 */
function interceptPet(target, channel, args) {
  if (!ctxRef || disposed) return false;
  if (isOwnWidget(target)) return false;

  if (channel === CH_AGUI) {
    const event = args[0];
    if (!event || typeof event !== "object") return false;

    if (event.type === "RUN_STARTED") {
      petWorking = true;
      pushPetTodo();
      return false;
    }
    if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
      petWorking = false;
      pushPetTodo();
      return false;
    }
    if (event.type !== "CUSTOM") return false;

    if (event.name === CH_ASK) {
      const kind = detectPetKind(event.value);
      const count = event.value && Array.isArray(event.value.questions) ? event.value.questions.length : 0;
      debugLog(
        "收到提问 kind=" +
          (kind || "未识别") +
          " questions=" +
          count +
          " catchAsk=" +
          petFlags.catchAsk +
          " hideNative=" +
          petFlags.hideNativeCard,
      );
      if (!petFlags.catchAsk) return false;
      if (!kind) return false;
      // 窗口不在或卡片没有 id 时，宁可让原生卡照常显示，也不要把两边都藏掉
      if (!win || win.isDestroyed()) {
        debugLog("桌宠窗口不在，先放行原生卡");
        return false;
      }
      if (!petCardId(kind, event.value)) {
        debugLog("卡片缺少 id，先放行原生卡");
        return false;
      }
      void presentPetCard(kind, event.value);
      return petFlags.hideNativeCard;
    }
    if (event.name === CH_ASK_DISMISS) {
      collapsePetCard(event.value);
      return false;
    }
    if (event.name === "cyrene.todo") {
      petTodos = normalizePetTodos(event.value && event.value.items);
      pushPetTodo();
      return petFlags.hideNativeTask;
    }
    return false;
  }

  if (channel === CH_APPROVAL_REQUEST) {
    if (!petFlags.catchApproval) return false;
    const payload = args[0];
    if (!payload || typeof payload.id !== "string") return false;
    void presentPetCard("approval", payload);
    return true;
  }

  if (channel === CH_APPROVAL_SETTLED) {
    if (!petFlags.catchApproval) return false;
    collapsePetCard(args[0]);
    return false;
  }

  return false;
}

function hookPetWebContents(target) {
  if (!target || typeof target.send !== "function") return;
  // 顶层已经是我们的包装就不再套一层，避免重载后层层堆叠
  if (target.send.__cyreneBalanceHook === true) return;

  const original = target.send;
  const wrapped = function send(channel, ...args) {
    try {
      if (interceptPet(target, channel, args)) return undefined;
    } catch (error) {
      petLog("事件拦截失败：" + ((error && error.message) || error));
    }
    return original.apply(target, [channel, ...args]);
  };
  wrapped.__cyreneBalanceHook = true;

  try {
    Object.defineProperty(target, "send", {
      configurable: true,
      writable: true,
      value: wrapped,
    });
    petHooked.push({ target, original, wrapped });
  } catch (error) {
    petLog("挂载失败：" + ((error && error.message) || error));
  }
}

function hookAllPetWebContents() {
  try {
    const { webContents } = require("electron");
    if (webContents && typeof webContents.getAllWebContents === "function") {
      for (const item of webContents.getAllWebContents()) hookPetWebContents(item);
    }
  } catch (error) {
    petLog("枚举窗口失败：" + ((error && error.message) || error));
  }
}

function unhookPetWebContents() {
  for (const entry of petHooked.splice(0)) {
    try {
      // 如果当前 send 已经被更新实例重新包过，就不要硬恢复成旧 original，
      // 否则会把新一代的拦截一起拆掉（重启后"收到提问"不再出现就是这个原因）
      if (entry.target.send !== entry.wrapped) continue;
      Object.defineProperty(entry.target, "send", {
        configurable: true,
        writable: true,
        value: entry.original,
      });
    } catch {
      /* 忽略 */
    }
  }
}

async function startPet() {
  const settings = await getSettings();
  petFlags = {
    catchAsk: settings.catchAsk,
    catchApproval: settings.catchApproval,
    hideNativeCard: settings.hideNativeCard,
    hideNativeTask: settings.hideNativeTask,
    showTaskBubble: settings.showTaskBubble,
    taskDetail: settings.taskDetail,
  };
  hookAllPetWebContents();
  if (!petHookTimer) {
    petHookTimer = setInterval(hookAllPetWebContents, 2500);
    if (typeof petHookTimer.unref === "function") petHookTimer.unref();
  }
  const caught = webContentsCount();
  debugLog("桌宠提问接管已启动 build=ask-debug-1 已挂窗口=" + caught + " catchAsk=" + petFlags.catchAsk);
}

// 统计已挂上拦截的窗口数，便于确认 hook 是否生效
function webContentsCount() {
  try {
    const { webContents } = require("electron");
    if (!webContents || typeof webContents.getAllWebContents !== "function") return petHooked.length;
    return webContents.getAllWebContents().length;
  } catch {
    return petHooked.length;
  }
}

function stopPet() {
  unhookPetWebContents();
  if (petHookTimer) {
    clearInterval(petHookTimer);
    petHookTimer = null;
  }
  petMode = "idle";
  petCard = null;
  petCardPayload = null;
}

/* ------------------------------ 生命周期 ------------------------------ */

module.exports = {
  async open() {
    await openWidget();
  },

  async register(ctx) {
    ctxRef = ctx;
    disposed = false;

    ctx.registerTool({
      id: "cyrene-balance_query",
      name: "查询 DeepSeek 余额",
      description:
        "查询 DeepSeek API 账户余额、今日消费、今日充值、今日额度与当前峰谷时段。可用 view 只看其中一部分：all 全部、today 只看今日已用和额度、balance 只看余额。用户问「还有多少钱」用 balance，「今天用了多少 / 额度还剩多少」用 today。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          view: {
            type: "string",
            enum: ["all", "today", "balance"],
            description: "显示范围：all 全部（默认）、today 只看今日额度、balance 只看余额",
          },
        },
        required: [],
      },
      async execute(args) {
        const view = args && ["all", "today", "balance"].includes(args.view) ? args.view : "all";
        return formatReport(await query(), view);
      },
    });

    ctx.registerTool({
      id: "cyrene-balance_set_threshold",
      name: "设置余额阈值与今日额度",
      description:
        "设置余额提醒阈值，也可以单独调节今日额度上限。用户说「余额低于 X 提醒我」「今天额度改成 Y 元」「今日额度关掉」时使用。dailyLimit 为 0 表示不启用今日额度提醒。",
      enabled: true,
      risk: "write",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          threshold: { type: "number", description: "余额提醒阈值，单位元" },
          dailyLimit: { type: "number", description: "今日额度上限，单位元，0 表示不启用" },
          budget: { type: "number", description: "dailyLimit 的旧名称，等价于今日额度上限" },
        },
        required: [],
      },
      async execute(args) {
        const settings = await getSettings();
        const hasThreshold = args && args.threshold !== undefined && args.threshold !== null;
        const rawLimit = args && args.dailyLimit !== undefined ? args.dailyLimit : args ? args.budget : undefined;
        const hasLimit = rawLimit !== undefined && rawLimit !== null;
        if (!hasThreshold && !hasLimit) return "没有要改的值。";

        if (hasThreshold) {
          const value = Number(args.threshold);
          if (!Number.isFinite(value) || value < 0 || value > 100000) {
            return "阈值需要是 0 到 100000 之间的数字。";
          }
          settings.threshold = value;
        }
        if (hasLimit) {
          const value = Number(rawLimit);
          if (!Number.isFinite(value) || value < 0 || value > 100000) {
            return "今日额度需要是 0 到 100000 之间的数字。";
          }
          settings.budget = value;
        }
        await saveSettings(settings);
        if (cached) {
          cached.threshold = settings.threshold;
          cached.budget = settings.budget;
          cached.remain = settings.budget > 0 ? Math.max(0, settings.budget - cached.spent) : null;
          cached.limitRatio = settings.budget > 0 ? cached.spent / settings.budget : 0;
          cached.warnLimit = settings.budget > 0 && cached.spent >= settings.budget * 0.8;
          cached.low = cached.total < settings.threshold;
          cached.overBudget = settings.budget > 0 && cached.spent >= settings.budget;
        }
        const parts = [];
        if (hasThreshold) parts.push("余额低于 " + money(settings.threshold) + " 元提醒你");
        if (hasLimit) {
          parts.push(settings.budget > 0 ? "今日额度 " + money(settings.budget) + " 元" : "今日额度提醒已关闭");
        }
        if (settings.budget > 0 && cached) {
          parts.push(
            "今天已经用了 " +
              money(cached.spent) +
              " 元（" +
              Math.round((cached.spent / settings.budget) * 100) +
              "%）"
          );
        }
        return "好，" + parts.join("，") + "。";
      },
    });

    ctx.registerTool({
      id: "cyrene-balance_set_key",
      name: "设置余额查询用的 API Key",
      description:
        "单独指定一个 DeepSeek API Key 用于余额查询。不设置时自动读取 Cyrene 模型设置里的 DeepSeek Key。",
      enabled: true,
      risk: "write",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          apiKey: { type: "string", description: "DeepSeek API Key，通常 sk- 开头" },
        },
        required: ["apiKey"],
      },
      async execute(args) {
        const key = String((args && args.apiKey) || "").trim();
        if (!key) return "Key 是空的，没有改动。";
        const saved = await setKey(key);
        if (!saved) return "宿主安全存储不可用，Key 没有保存。";
        void tick();
        return "记下了，之后余额查询会用这个 Key。";
      },
    });

    ctx.registerTool({
      id: "cyrene-balance_status",
      name: "查看余额提醒设置",
      description: "查看当前提醒阈值、今日预算、刷新间隔、上次查询时间和余额。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        const settings = await getSettings();
        const lines = [
          "提醒阈值：" + money(settings.threshold) + " 元",
          "今日额度：" + (settings.budget > 0 ? money(settings.budget) + " 元" : "未启用"),
          "气泡显示：" + viewLabel(settings.bubbleMode),
          "自动刷新：每 " + settings.refreshSec + " 秒",
          "Key 来源：" + ((await getKey()) ? "插件内单独设置" : "跟随 Cyrene 的 DeepSeek 配置"),
        ];
        if (cached && settings.budget > 0) {
          lines.splice(
            2,
            0,
            "今日已用：" +
              money(cached.spent) +
              " 元（" +
              Math.round((cached.spent / settings.budget) * 100) +
              "%）" +
              (cached.overBudget ? "，已超过额度上限" : cached.warnLimit ? "，接近额度上限" : "")
          );
        }
        if (cached) {
          lines.push(
            "上次查询：" +
              cached.currency +
              " " +
              money(cached.total) +
              "，今日消费 " +
              money(cached.spent) +
              "（" +
              cached.at +
              "）"
          );
        } else {
          lines.push("上次查询：还没查过");
        }
        return lines.join("\n");
      },
    });

    ctx.registerTool({
      id: "cyrene-balance_set_view",
      name: "设置气泡显示范围",
      description:
        "切换桌宠气泡的显示范围：rotate 余额与台词交替、info 只显示余额信息、talk 只显示台词、today 只看今日额度、balance 只看余额。用户说「只看今日额度」「只看余额」「气泡别播台词」时使用。",
      enabled: true,
      risk: "write",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["rotate", "info", "talk", "today", "balance"],
            description: "显示范围",
          },
        },
        required: ["mode"],
      },
      async execute(args) {
        const mode = args && args.mode;
        if (!["rotate", "info", "talk", "today", "balance"].includes(mode)) {
          return "显示范围只能是 rotate / info / talk / today / balance。";
        }
        const settings = await getSettings();
        settings.bubbleMode = mode;
        await saveSettings(settings);
        if (win && !win.isDestroyed()) {
          try { win.webContents.send("config-changed"); } catch { /* 忽略 */ }
        }
        return "好，气泡改成「" + viewLabel(mode) + "」。";
      },
    });

    ctx.registerTool({
      id: "cyrene-balance_history",
      name: "查看近七天消费",
      description: "查看最近 7 天每天的消费金额。用户问「这周花了多少 / 前几天用了多少」时使用。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        const ledger = await readLedger();
        const lines = [historyLines(ledger)];
        const total = Object.values(ledger.history || {}).reduce((sum, v) => sum + (Number(v) || 0), 0);
        if (total > 0) {
          lines.push("合计 " + money(total) + " 元");
          lines.push("今天已用 " + money(ledger.spent) + " 元");
        }
        return lines.join("\n");
      },
    });

    ctx.registerPromptProvider({
      id: "balance",
      modes: ["chat", "work", "learn", "code"],
      provide() {
        if (!cached) return "";
        return (
          "DeepSeek 余额：" +
          cached.currency +
          " " +
          money(cached.total) +
          "，提醒阈值 " +
          money(cached.threshold) +
          "，" +
          (cached.low ? "已低于阈值" : "高于阈值") +
          "，今日消费 " +
          money(cached.spent) +
          (cached.recharge > 0 ? "，今日充值 " + money(cached.recharge) : "") +
          "，当前" +
          cached.peak.label +
          "，数据时间 " +
          cached.at +
          (cached.budget > 0
            ? "，今日额度 " +
              money(cached.budget) +
              "，已用 " +
              Math.round((cached.spent / cached.budget) * 100) +
              "%" +
              (cached.overBudget ? "（已超过额度上限）" : cached.warnLimit ? "（接近额度上限）" : "")
            : "") +
          (cached.stale ? "（上次刷新失败，为旧数据）" : "")
        );
      },
    });

    ctx.registerIpc("get", async () => buildWidgetPayload());

    ctx.registerIpc("refresh", async () => {
      const result = await tick();
      const payload = await buildWidgetPayload();
      if (result && result.error) payload.error = result.error;
      return payload;
    });

    ctx.registerIpc("scale", async () => {
      const settings = await getSettings();
      return settings.widgetScale;
    });

    ctx.registerIpc("config", async () => {
      const settings = await getSettings();
      return {
        stickerDuration: settings.stickerDuration,
        stickerPlacement: settings.stickerPlacement,
        stickerSize: settings.stickerSize,
        bubbleSize: settings.bubbleSize,
        bubbleWidth: settings.bubbleWidth,
        bubbleHeight: settings.bubbleHeight,
        bubbleMode: settings.bubbleMode,
        bubblePlace: settings.bubblePlace,
        bubbleFont: settings.bubbleFont,
        talkFont: settings.talkFont,
        rotateSec: settings.rotateSec,
        poseRotate: settings.poseRotate,
        poseSec: settings.poseSec,
        taskFont: settings.taskFont,
        taskListHeight: settings.taskListHeight,
        hudEnabled: settings.hudEnabled,
        hudDetail: settings.hudDetail,
      };
    });

    ctx.registerIpc("setLimit", async (value) => {
      const limit = Math.min(100000, Math.max(0, Number(value) || 0));
      const settings = await getSettings();
      settings.budget = limit;
      await saveSettings(settings);
      if (cached) {
        cached.budget = limit;
        cached.remain = limit > 0 ? Math.max(0, limit - cached.spent) : null;
        cached.limitRatio = limit > 0 ? cached.spent / limit : 0;
        cached.warnLimit = limit > 0 && cached.spent >= limit * 0.8;
        cached.overBudget = limit > 0 && cached.spent >= limit;
      }
      if (win && !win.isDestroyed()) {
        try { win.webContents.send("config-changed"); } catch { /* 忽略 */ }
      }
      return { limit, payload: await buildWidgetPayload() };
    });

    ctx.registerIpc("setScale", async (value) => {
      const scale = Math.min(1.5, Math.max(0.75, Number(value) || 1));
      const settings = await getSettings();
      settings.widgetScale = scale;
      widgetScaleCache = scale;
      await saveSettings(settings);
      if (petMode === "card") applyPetSize(true);
      else resizeWidget(scale);
      if (win && !win.isDestroyed()) void saveWidgetPosition();
      return scale;
    });

    ctx.registerIpc("recenter", async () => {
      return recenterPet({ save: true });
    });

    ctx.registerIpc("moveBy", async (payload) => {
      if (!win || win.isDestroyed()) return false;
      const dx = Number(payload && payload.dx) || 0;
      const dy = Number(payload && payload.dy) || 0;
      if (!dx && !dy) return false;
      const b = win.getBounds();
      win.setPosition(b.x + Math.round(dx), b.y + Math.round(dy));
      keepInsideMain();
      return true;
    });

    ctx.registerIpc("set-widget-height", async (value) => {
      if (petMode === "card") return false;
      setWidgetHeight(value);
      return true;
    });

    ctx.registerIpc("set-widget-width", async (value) => {
      if (petMode === "card") return false;
      setWidgetWidth(value);
      return true;
    });

    ctx.registerIpc("hud", async () => hudSnapshot());

    ctx.registerIpc("close", async () => {
      closeWidget();
      return true;
    });

    /* ---------- 统一桌宠 ---------- */

    ctx.registerIpc("card-collapse", async () => {
      collapsePetCard({ reason: "collapsed" });
      return true;
    });

    // 卡片在桌宠里真正渲染出来后的回执，用于区分"没拦到"和"拦到但没显示"
    ctx.registerIpc("card-ack", async (payload) => {
      const info = payload && typeof payload === "object" ? payload : {};
      debugLog("卡片已渲染 kind=" + String(info.kind || "?") + " id=" + String(info.id || "?"));
      return true;
    });

    // 卡片里的点击/提交动作，写进同一份诊断日志
    ctx.registerIpc("card-log", async (message) => {
      debugLog("卡片动作 " + String(message || "").slice(0, 200));
      return true;
    });

    ctx.registerIpc("card-open-main", async () => {
      try {
        const main = findMainWindow();
        if (main) {
          if (main.isMinimized()) main.restore();
          main.show();
          main.focus();
        }
      } catch {
        /* 忽略 */
      }
      collapsePetCard({ reason: "open-main" });
      return true;
    });

    ctx.registerIpc("task-open-main", async () => {
      try {
        const main = findMainWindow();
        if (main) {
          if (main.isMinimized()) main.restore();
          main.show();
          main.focus();
          try {
            main.webContents.send("cyrene:open-task-panel", {});
          } catch {
            /* 忽略 */
          }
        }
      } catch {
        /* 忽略 */
      }
      return true;
    });

    ctx.registerIpc("pet-state", async () => ({
      mode: petMode,
      card: petCard,
      working: petWorking,
      todos: petTodos,
      flags: petFlags,
    }));

    ctx.registerIpc("pet-flags", async (patch) => {
      if (!patch || typeof patch !== "object") return petFlags;
      if (typeof patch.catchAsk === "boolean") petFlags.catchAsk = patch.catchAsk;
      if (typeof patch.catchApproval === "boolean") petFlags.catchApproval = patch.catchApproval;
      if (typeof patch.hideNativeCard === "boolean") petFlags.hideNativeCard = patch.hideNativeCard;
      if (typeof patch.hideNativeTask === "boolean") petFlags.hideNativeTask = patch.hideNativeTask;
      if (typeof patch.showTaskBubble === "boolean") petFlags.showTaskBubble = patch.showTaskBubble;
      if (["auto", "always", "hidden"].includes(patch.taskDetail)) petFlags.taskDetail = patch.taskDetail;
      const current = await getSettings();
      await saveSettings({
        ...current,
        ...petFlags,
      });
      pushPetTodo();
      return petFlags;
    });

    /* ---------- 设置面板：只暴露桌宠相关的键 ---------- */

    const PET_SETTING_KEYS = [
      "catchAsk",
      "catchApproval",
      "hideNativeCard",
      "hideNativeTask",
      "showTaskBubble",
      "taskFont",
      "taskListHeight",
      "hudEnabled",
      "hudDetail",
      "bubbleWidth",
      "bubbleHeight",
    ];

    const publicSettings = (s) => {
      const out = {};
      for (const key of PET_SETTING_KEYS) out[key] = s[key];
      return out;
    };

    const applyRuntimeSettings = async (s) => {
      petFlags = {
        catchAsk: s.catchAsk,
        catchApproval: s.catchApproval,
        hideNativeCard: s.hideNativeCard,
        hideNativeTask: s.hideNativeTask,
      };
      if (s.hudEnabled) await startHud();
      else stopHud();
      if (win && !win.isDestroyed()) {
        try {
          win.webContents.send("config-changed");
        } catch {
          /* 窗口正在关闭时忽略 */
        }
      }
    };

    ctx.registerIpc("settings-get", async () => publicSettings(await getSettings()));

    ctx.registerIpc("settings-set", async (patch) => {
      const s = await getSettings();
      if (!patch || typeof patch !== "object") return publicSettings(s);
      if (typeof patch.catchAsk === "boolean") s.catchAsk = patch.catchAsk;
      if (typeof patch.catchApproval === "boolean") s.catchApproval = patch.catchApproval;
      if (typeof patch.hideNativeCard === "boolean") s.hideNativeCard = patch.hideNativeCard;
      if (typeof patch.hideNativeTask === "boolean") s.hideNativeTask = patch.hideNativeTask;
      if (typeof patch.showTaskBubble === "boolean") s.showTaskBubble = patch.showTaskBubble;
      if (typeof patch.hudEnabled === "boolean") s.hudEnabled = patch.hudEnabled;
      if ([10, 12, 14, 16].includes(Number(patch.taskFont))) s.taskFont = Number(patch.taskFont);
      if ([100, 150, 220].includes(Number(patch.taskListHeight))) {
        s.taskListHeight = Number(patch.taskListHeight);
      }
      if (["full", "simple", "simple2"].includes(patch.hudDetail)) s.hudDetail = patch.hudDetail;
      if (Number.isFinite(Number(patch.bubbleWidth))) {
        s.bubbleWidth = Math.max(0, Math.min(1400, Math.round(Number(patch.bubbleWidth))));
      }
      if (Number.isFinite(Number(patch.bubbleHeight))) {
        s.bubbleHeight = Math.max(0, Math.min(1400, Math.round(Number(patch.bubbleHeight))));
      }
      await saveSettings(s);
      await applyRuntimeSettings(s);
      return publicSettings(s);
    });

    ctx.registerIpc("settings-reset", async () => {
      const fresh = defaultSettings();
      await saveSettings(fresh);
      await applyRuntimeSettings(fresh);
      return publicSettings(fresh);
    });

    ctx.registerIpc("noop", async () => true);

    ctx.registerIpc("setFollow", async (value) => {
      const settings = await getSettings();
      settings.followMain = !!value;
      await saveSettings(settings);
      if (win && !win.isDestroyed()) closeWidget();
      await openWidget();
      return settings.followMain;
    });

    ctx.registerIpc("showMenu", async () => {
      if (!win || win.isDestroyed()) return false;
      try {
        const { Menu } = require("electron");
        const settings = await getSettings();
        const send = (type) => {
          try { win.webContents.send("menu-action", type); } catch { /* 忽略 */ }
        };
        const applySetting = (key, value) => {
          void (async () => {
            const s = await getSettings();
            s[key] = value;
            await saveSettings(s);
            send("config-changed");
          })();
        };

        // 阈值改了要立刻影响提醒判断，不等下一次余额刷新
        const applyThreshold = (value) => {
          void (async () => {
            const s = await getSettings();
            s.threshold = value;
            await saveSettings(s);
            if (cached) {
              cached.threshold = value;
              cached.low = value > 0 && cached.total < value;
            }
            send("config-changed");
          })();
        };

        // 刷新间隔改了要重建定时器，否则旧间隔会一直跑下去
        const applyRefreshSec = (value) => {
          void (async () => {
            const s = await getSettings();
            s.refreshSec = value;
            await saveSettings(s);
            if (timer) clearInterval(timer);
            const interval = Math.max(30, value) * 1000;
            timer = setInterval(() => {
              void tick().catch((error) => {
                if (ctxRef && !disposed) ctxRef.log("定时检查异常：" + ((error && error.message) || error));
              });
            }, interval);
            if (typeof timer.unref === "function") timer.unref();
            send("config-changed");
          })();
        };

        // 档位与固定宽高互斥：选了档位就回到自适应，避免"调了档位却没变化"
        const applyBubbleSize = (value) => {
          void (async () => {
            const s = await getSettings();
            s.bubbleSize = value;
            s.bubbleWidth = 0;
            s.bubbleHeight = 0;
            await saveSettings(s);
            send("config-changed");
          })();
        };

        const sizeOptions = (key, current, presets, unit) => [
          {
            label: "自适应",
            type: "radio",
            checked: !(Number(current) > 0),
            click: () => applySetting(key, 0),
          },
          ...presets.map((value) => ({
            label: value + (unit || " px"),
            type: "radio",
            checked: Math.abs(Number(current) - value) < 0.01,
            click: () => applySetting(key, value),
          })),
          { type: "separator" },
          {
            label: "输入数值…",
            click: () => send(key === "bubbleWidth" ? "custom-bubble-width" : "custom-bubble-height"),
          },
        ];
        const menu = Menu.buildFromTemplate([
          { label: "♪ 说句话", click: () => send("talk") },
          { type: "separator" },
          {
            label: "余额与额度",
            submenu: [
              {
                label: "今日额度",
                submenu: [
                  ...[10, 20, 30, 50, 100].map((value) => ({
                    label: value + " 元",
                    type: "radio",
                    checked: Math.abs(settings.budget - value) < 0.01,
                    click: () => applySetting("budget", value),
                  })),
                  { type: "separator" },
                  { label: "自定义…", click: () => send("custom-limit") },
                  {
                    label: "关闭额度提醒",
                    type: "radio",
                    checked: !(settings.budget > 0),
                    click: () => applySetting("budget", 0),
                  },
                ],
              },
              {
                label: "余额提醒阈值",
                submenu: [
                  ...[10, 20, 50, 100, 200].map((value) => ({
                    label: value + " 元",
                    type: "radio",
                    checked: Math.abs(settings.threshold - value) < 0.01,
                    click: () => applyThreshold(value),
                  })),
                  { type: "separator" },
                  {
                    label: "不提醒",
                    type: "radio",
                    checked: !(settings.threshold > 0),
                    click: () => applyThreshold(0),
                  },
                ],
              },
              {
                label: "刷新间隔",
                submenu: [30, 60, 120, 300].map((sec) => ({
                  label: sec < 60 ? sec + " 秒" : sec / 60 + " 分钟",
                  type: "radio",
                  checked: Math.abs(settings.refreshSec - sec) < 0.01,
                  click: () => applyRefreshSec(sec),
                })),
              },
              { type: "separator" },
              { label: "立即刷新余额", click: () => send("refresh") },
            ],
          },
          {
            label: "提问与确认",
            submenu: [
              {
                label: "在桌宠上回答提问",
                type: "checkbox",
                checked: settings.catchAsk !== false,
                click: (item) => applySetting("catchAsk", Boolean(item.checked)),
              },
              {
                label: "主界面提问卡",
                submenu: [
                  {
                    label: "照常显示",
                    type: "radio",
                    checked: settings.hideNativeCard !== true,
                    click: () => applySetting("hideNativeCard", false),
                  },
                  {
                    label: "隐藏，只在桌宠上答",
                    type: "radio",
                    checked: settings.hideNativeCard === true,
                    click: () => applySetting("hideNativeCard", true),
                  },
                ],
              },
              {
                label: "工具审批也交给桌宠",
                type: "checkbox",
                checked: settings.catchApproval !== false,
                click: (item) => applySetting("catchApproval", Boolean(item.checked)),
              },
              { type: "separator" },
              { label: "桌宠没接住时，主界面卡会自动出现", enabled: false },
            ],
          },
          {
            label: "外观",
            submenu: [
              {
                label: "立绘",
                submenu: [
                  {
                    label: "自动轮换",
                    type: "checkbox",
                    checked: settings.poseRotate !== false,
                    click: (item) => applySetting("poseRotate", Boolean(item.checked)),
                  },
                  { label: "换一个姿势", click: () => send("next-pose") },
                  {
                    label: "轮换间隔",
                    submenu: [20, 45, 90, 180].map((s) => ({
                      label: s + " 秒",
                      type: "radio",
                      checked: Math.abs(settings.poseSec - s) < 0.01,
                      click: () => applySetting("poseSec", s),
                    })),
                  },
                ],
              },
              {
                label: "小表情",
                submenu: [
                  {
                    label: "大小",
                    submenu: [
                      { value: 32, label: "小 32" },
                      { value: 42, label: "标准 42" },
                      { value: 52, label: "大 52" },
                      { value: 62, label: "特大 62" },
                    ].map((s) => ({
                      label: s.label,
                      type: "radio",
                      checked: Math.abs(settings.stickerSize - s.value) < 0.01,
                      click: () => applySetting("stickerSize", s.value),
                    })),
                  },
                  {
                    label: "停留时长",
                    submenu: [1.5, 3, 5, 8, 12].map((d) => ({
                      label: d + " 秒",
                      type: "radio",
                      checked: Math.abs(settings.stickerDuration - d) < 0.01,
                      click: () => applySetting("stickerDuration", d),
                    })),
                  },
                ],
              },
              {
                label: "气泡",
                submenu: [
                  {
                    label: "显示方式",
                    submenu: [
                      { value: "rotate", label: "余额 / 台词 交替" },
                      { value: "info", label: "只显示余额信息" },
                      { value: "talk", label: "只显示台词" },
                      { value: "today", label: "只看今日额度" },
                      { value: "balance", label: "只看余额" },
                    ].map((m) => ({
                      label: m.label,
                      type: "radio",
                      checked: settings.bubbleMode === m.value,
                      click: () => applySetting("bubbleMode", m.value),
                    })),
                  },
                  {
                    label: "位置",
                    submenu: [
                      { value: "top", label: "上方" },
                      { value: "middle", label: "中间" },
                      { value: "bottom", label: "下方" },
                    ].map((p) => ({
                      label: p.label,
                      type: "radio",
                      checked: settings.bubblePlace === p.value,
                      click: () => applySetting("bubblePlace", p.value),
                    })),
                  },
                  {
                    label: "内边距档位",
                    submenu: [
                      { value: "compact", label: "紧凑" },
                      { value: "normal", label: "标准" },
                      { value: "roomy", label: "宽松" },
                      { value: "xlarge", label: "超大" },
                    ].map((b) => ({
                      label: b.label,
                      type: "radio",
                      checked: settings.bubbleSize === b.value,
                      click: () => applyBubbleSize(b.value),
                    })),
                  },
                ],
              },
              {
                label: "气泡宽高",
                submenu: [
                  {
                    label: "宽度",
                    submenu: sizeOptions("bubbleWidth", settings.bubbleWidth, [240, 320, 420, 560]),
                  },
                  {
                    label: "高度",
                    submenu: sizeOptions("bubbleHeight", settings.bubbleHeight, [160, 240, 320, 420]),
                  },
                  { type: "separator" },
                  { label: "留 0 = 随内容自适应", enabled: false },
                ],
              },
              {
                label: "字号",
                submenu: [
                  {
                    label: "余额字号",
                    submenu: [
                      { value: 0.8, label: "小" },
                      { value: 1, label: "标准" },
                      { value: 1.3, label: "大" },
                      { value: 1.6, label: "特大" },
                    ].map((f) => ({
                      label: f.label,
                      type: "radio",
                      checked: Math.abs(settings.bubbleFont - f.value) < 0.01,
                      click: () => applySetting("bubbleFont", f.value),
                    })),
                  },
                  {
                    label: "台词字号",
                    submenu: [
                      { value: 10, label: "小 10" },
                      { value: 12, label: "标准 12" },
                      { value: 14, label: "大 14" },
                      { value: 16, label: "特大 16" },
                      { value: 18, label: "超大 18" },
                    ].map((f) => ({
                      label: f.label,
                      type: "radio",
                      checked: Math.abs(settings.talkFont - f.value) < 0.01,
                      click: () => applySetting("talkFont", f.value),
                    })),
                  },
                ],
              },
              {
                label: "交替间隔",
                submenu: [8, 12, 20, 30].map((s) => ({
                  label: s + " 秒",
                  type: "radio",
                  checked: Math.abs(settings.rotateSec - s) < 0.01,
                  click: () => applySetting("rotateSec", s),
                })),
              },
            ],
          },
          {
            label: "桌宠行为",
            submenu: [
              {
                label: "任务进程",
                submenu: [
                  {
                    label: "显示任务气泡",
                    type: "checkbox",
                    checked: settings.showTaskBubble !== false,
                    click: (item) => applySetting("showTaskBubble", Boolean(item.checked)),
                  },
                  {
                    label: "字号",
                    submenu: [10, 12, 14, 16].map((f) => ({
                      label: f === 12 ? "标准 12" : f + " px",
                      type: "radio",
                      checked: Math.abs(settings.taskFont - f) < 0.01,
                      click: () => applySetting("taskFont", f),
                    })),
                  },
                  {
                    label: "列表高度",
                    submenu: [100, 150, 220].map((h) => ({
                      label: h + " px",
                      type: "radio",
                      checked: Math.abs(settings.taskListHeight - h) < 0.01,
                      click: () => applySetting("taskListHeight", h),
                    })),
                  },
                ],
              },
              {
                label: "状态面板",
                submenu: [
                  {
                    label: "显示 CPU / 内存 / 心情 / 模型",
                    type: "checkbox",
                    checked: settings.hudEnabled === true,
                    click: (item) => applySetting("hudEnabled", Boolean(item.checked)),
                  },
                  {
                    label: "详细度",
                    submenu: [
                      { value: "full", label: "详细" },
                      { value: "simple", label: "简版" },
                      { value: "simple2", label: "简版2" },
                    ].map((d) => ({
                      label: d.label,
                      type: "radio",
                      checked: settings.hudDetail === d.value,
                      click: () => applySetting("hudDetail", d.value),
                    })),
                  },
                  { label: "立即刷新", click: () => pushHud() },
                ],
              },
              { type: "separator" },
              {
                label: "跟随 Cyrene 窗口",
                type: "checkbox",
                checked: settings.followMain !== false,
                click: (item) => {
                  void (async () => {
                    const s = await getSettings();
                    s.followMain = item.checked;
                    await saveSettings(s);
                    if (win && !win.isDestroyed()) closeWidget();
                    await openWidget();
                  })();
                },
              },
            ],
          },
          { type: "separator" },
          {
            label: "视图",
            submenu: [
              { label: "放大", click: () => send("zoom-in") },
              { label: "缩小", click: () => send("zoom-out") },
              { type: "separator" },
              { label: "当前缩放 " + Math.round((widgetScaleCache || 1) * 100) + "%", enabled: false },
            ],
          },
          { type: "separator" },
          { label: "关闭桌宠", click: () => send("close") },
        ]);
        menu.popup({ window: win });
        return true;
      } catch {
        return false;
      }
    });

    const settings = await getSettings();
    const interval = Math.max(30, settings.refreshSec) * 1000;
    timer = setInterval(() => {
      void tick().catch((error) => {
        if (ctxRef && !disposed) ctxRef.log("定时检查异常：" + ((error && error.message) || error));
      });
    }, interval);
    if (typeof timer.unref === "function") timer.unref();

    ctx.onDispose(() => {
      disposed = true;
      destroyTray();
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = null;
      }
    });

    ensureTray();
    void tick();
    void startPet();
    // 等窗口先立起来，再把上次没答完的卡放回去
    setTimeout(() => {
      void restorePendingCard();
    }, 2500);
    ctx.log("余额提醒已启动，每 " + Math.round(interval / 1000) + " 秒刷新一次");

    if (settings.autoOpen) {
      openTimer = setTimeout(() => {
        openTimer = null;
        if (disposed) return;
        openWidget().catch((error) => {
          if (ctxRef && !disposed) ctxRef.log("自动打开挂件失败：" + ((error && error.message) || error));
        });
      }, 1200);
    }
  },

  async unregister() {
    disposed = true;
    destroyTray();
    stopPet();
    closeWidget();
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = null;
    }
    ctxRef = null;
    cached = null;
    lastError = "";
  },
};
