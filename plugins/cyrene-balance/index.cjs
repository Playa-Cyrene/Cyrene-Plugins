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
  bubbleMode: "rotate",
  bubblePlace: "top",
  bubbleFont: 1,
  talkFont: 12,
  rotateSec: 12,
  poseRotate: true,
  poseSec: 45,
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
      bubbleMode: ["rotate", "info", "talk"].includes(raw.bubbleMode) ? raw.bubbleMode : "rotate",
      bubblePlace: ["top", "middle", "bottom"].includes(raw.bubblePlace) ? raw.bubblePlace : "top",
      bubbleFont: [0.8, 1, 1.3, 1.6].includes(Number(raw.bubbleFont)) ? Number(raw.bubbleFont) : 1,
      talkFont: [10, 12, 14, 16, 18].includes(Number(raw.talkFont)) ? Number(raw.talkFont) : 12,
      rotateSec:
        Number.isFinite(Number(raw.rotateSec)) && Number(raw.rotateSec) >= 5 && Number(raw.rotateSec) <= 90
          ? Number(raw.rotateSec)
          : 12,
      poseRotate: raw.poseRotate !== false,
      poseSec: [20, 45, 90, 180].includes(Number(raw.poseSec)) ? Number(raw.poseSec) : 45,
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
  return result;
}

function formatReport(result) {
  if (!result.ok) return result.error;
  if (result.stale) {
    return "刚刚刷新失败，先给你看上次的数字：\n" + formatCached();
  }
  return formatCached();
}

function formatCached() {
  if (!cached) return "还没有余额数据。";
  const c = cached;
  const lines = [
    "DeepSeek 余额：" + c.currency + " " + money(c.total),
    "今日消费 " + money(c.spent) + (c.recharge > 0 ? " · 今日充值 " + money(c.recharge) : ""),
  ];
  if (c.granted > 0) lines.push("其中赠金 " + money(c.granted));
  lines.push(
    "当前" + c.peak.label + (c.peak.next ? "，" + c.peak.next + c.peak.nextLabel : "")
  );
  if (c.low) lines.push("已低于提醒阈值 " + money(c.threshold) + " 元");
  if (c.overBudget) lines.push("今日已超出预算 " + money(c.budget) + " 元");
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

function resizeWidget(scale) {
  if (!win || win.isDestroyed()) return;
  const width = Math.round(WIDGET_WIDTH * scale);
  const height = Math.round(WIDGET_HEIGHT * scale);
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
  const width = Math.round(WIDGET_WIDTH * scale);
  const height = Math.round(WIDGET_HEIGHT * scale);

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
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });
  if (!followMode) {
    try { win.setAlwaysOnTop(true, "floating"); } catch { /* 忽略 */ }
  }
  win.loadFile(path.join(__dirname, "widget.html"));
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
  mainWin = null;
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
        "查询 DeepSeek API 账户余额、今日消费、今日充值、当前峰谷时段。用户问「还有多少钱 / 余额多少 / 今天花了多少 / 现在是不是高峰」时使用。无参数。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        return formatReport(await query());
      },
    });

    ctx.registerTool({
      id: "cyrene-balance_set_threshold",
      name: "设置余额提醒阈值",
      description:
        "设置余额提醒阈值（元），可选同时设置今日预算（元，0 表示不启用）。用户说「余额低于 X 提醒我」「今天预算 Y 元」时使用。",
      enabled: true,
      risk: "write",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          threshold: { type: "number", description: "余额提醒阈值，单位元" },
          budget: { type: "number", description: "今日消费预算，单位元，0 表示不启用" },
        },
        required: [],
      },
      async execute(args) {
        const settings = await getSettings();
        const hasThreshold = args && args.threshold !== undefined && args.threshold !== null;
        const hasBudget = args && args.budget !== undefined && args.budget !== null;
        if (!hasThreshold && !hasBudget) return "没有要改的值。";

        if (hasThreshold) {
          const value = Number(args.threshold);
          if (!Number.isFinite(value) || value < 0 || value > 100000) {
            return "阈值需要是 0 到 100000 之间的数字。";
          }
          settings.threshold = value;
        }
        if (hasBudget) {
          const value = Number(args.budget);
          if (!Number.isFinite(value) || value < 0 || value > 100000) {
            return "预算需要是 0 到 100000 之间的数字。";
          }
          settings.budget = value;
        }
        await saveSettings(settings);
        if (cached) {
          cached.threshold = settings.threshold;
          cached.budget = settings.budget;
          cached.low = cached.total < settings.threshold;
          cached.overBudget = settings.budget > 0 && cached.spent >= settings.budget;
        }
        const parts = [];
        if (hasThreshold) parts.push("余额低于 " + money(settings.threshold) + " 元提醒你");
        if (hasBudget) {
          parts.push(settings.budget > 0 ? "今日预算 " + money(settings.budget) + " 元" : "今日预算已关闭");
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
          "今日预算：" + (settings.budget > 0 ? money(settings.budget) + " 元" : "未启用"),
          "自动刷新：每 " + settings.refreshSec + " 秒",
          "Key 来源：" + ((await getKey()) ? "插件内单独设置" : "跟随 Cyrene 的 DeepSeek 配置"),
        ];
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
        bubbleMode: settings.bubbleMode,
        bubblePlace: settings.bubblePlace,
        bubbleFont: settings.bubbleFont,
        talkFont: settings.talkFont,
        rotateSec: settings.rotateSec,
        poseRotate: settings.poseRotate,
        poseSec: settings.poseSec,
      };
    });

    ctx.registerIpc("setScale", async (value) => {
      const scale = Math.min(1.5, Math.max(0.75, Number(value) || 1));
      const settings = await getSettings();
      settings.widgetScale = scale;
      await saveSettings(settings);
      resizeWidget(scale);
      if (win && !win.isDestroyed()) void saveWidgetPosition();
      return scale;
    });

    ctx.registerIpc("recenter", async () => {
      if (!win || win.isDestroyed()) return false;
      placeWidget();
      return true;
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

    ctx.registerIpc("close", async () => {
      closeWidget();
      return true;
    });

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
        const menu = Menu.buildFromTemplate([
          { label: "♪ 说句话", click: () => send("talk") },
          { type: "separator" },
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
                  { value: "info", label: "只显示余额" },
                  { value: "talk", label: "只显示台词" },
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
                label: "尺寸",
                submenu: [
                  { value: "compact", label: "紧凑" },
                  { value: "normal", label: "标准" },
                  { value: "roomy", label: "宽松" },
                  { value: "xlarge", label: "超大" },
                ].map((b) => ({
                  label: b.label,
                  type: "radio",
                  checked: settings.bubbleSize === b.value,
                  click: () => applySetting("bubbleSize", b.value),
                })),
              },
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
          { type: "separator" },
          { label: "放大", click: () => send("zoom-in") },
          { label: "缩小", click: () => send("zoom-out") },
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
          { label: "刷新余额", click: () => send("refresh") },
          { type: "separator" },
          { label: "关闭", click: () => send("close") },
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
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = null;
      }
    });

    void tick();
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
