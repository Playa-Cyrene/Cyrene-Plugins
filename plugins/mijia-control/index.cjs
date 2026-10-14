"use strict";
/**
 * 米家智能家居控制插件 —— Cyrene Plugin API v1
 *
 * 目标：在不改动 agent 核心的前提下，用一个自包含插件跑通
 *   「扫码连接米家 → 扫描并按房间分组设备 → 面板 / 对话两种方式操控」。
 *
 * 结构：
 *   lib/micloud.cjs —— 自包含米家云客户端（登录 / RC4 签名 / 设备 / 房间 / 属性读写 / 动作）
 *   index.cjs       —— 本文件，插件装配（工具 / IPC / 扫描 / 网络检测 / 窗口）
 *   ui.html         —— 设备控制面板（账号头像栏 + 按房间分组圆角卡片 + 齿轮设置 + 设备操作）
 *
 * 契约要点（对齐 api.ts）：
 *   - token 只经 ctx.deps.secrets 存，绝不明文落盘；
 *   - 工具 id 以插件 id 前缀 mijia-control_；deps 只申请 secrets（最小权限）；
 *   - registerIpc 通道宿主自动补前缀 plugin:mijia-control:<channel>，窗口 nodeIntegration 直连；
 *   - open() 自建 frameless BrowserWindow（与官方 system-status / 小米健康同法）；
 *   - 后台扫描定时器受 ctx.signal 约束，onDispose 兜底清理，无泄漏。
 */

const os = require("node:os");
const path = require("node:path");
const dgram = require("node:dgram");
const { createSession } = require("./lib/session.cjs");
const { MiCloudAuth, MiCloudClient, TokenExpiredError } = require("./lib/micloud.cjs");
const { createSpecManager } = require("./lib/miot_spec.cjs");

const PLUGIN_ID = "mijia-control";
const CHANNEL_NS = "plugin:mijia-control:";
const TOKEN_SECRET_KEY = "token";
const LOGIN_PUSH = `${CHANNEL_NS}login`;
const DEVICES_PUSH = `${CHANNEL_NS}devices`;
const WIN_MIN_CHANNEL = `${CHANNEL_NS}win-minimize`;
const WIN_MAX_CHANNEL = `${CHANNEL_NS}win-maximize`;
const WIN_CLOSE_CHANNEL = `${CHANNEL_NS}win-close`;
const PREFS_KEY = "prefs";
const DEFAULT_SCAN_MIN = 5;
// 绝大多数 MiOT 设备（灯/插座/风扇/空净/加湿器…）的开关都在 siid=2 / piid=1。
// 仅在查不到该设备 MIoT-Spec 时作为兵底默认；能取到 spec 时一律用 spec 里的电源属性。
const DEFAULT_POWER = { siid: 2, piid: 1 };

// MIoT-Spec 能力层（model → 控件描述符）；在 register() 里用 ctx.storage 初始化。
let spec = null;

let ctxRef = null;
let auth = null;
let client = null;
let pluginWin = null;
let scanTimer = null;
let winControlsInstalled = false;
let removeWindowControls = null;
let session = null;

const login = { state: "idle", qr: "", loginUrl: "", error: "" };
const cache = {
  devices: [], // [{did,name,model,localip,online,room,home,source}]
  roomMap: {},
  fetchedAt: 0,
  lastError: "",
  lanIps: [],
};

function isCurrent(snapshot) {
  return Boolean(session && snapshot && session.isCurrent(snapshot));
}
function renewSession() {
  const snapshot = session.renew();
  auth = null;
  client = null;
  cache.devices = [];
  cache.roomMap = {};
  cache.fetchedAt = 0;
  cache.lastError = "";
  cache.lanIps = [];
  return snapshot;
}

// ── 偏好 ────────────────────────────────────────────────────────
function sanitizePrefs(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    chatInject: src.chatInject !== false,
    scanIntervalMin:
      Number.isFinite(src.scanIntervalMin) && src.scanIntervalMin >= 1
        ? Math.min(Math.floor(src.scanIntervalMin), 24 * 60)
        : DEFAULT_SCAN_MIN,
    autoScan: src.autoScan !== false,
  };
}
function readPrefs() {
  return sanitizePrefs(ctxRef ? ctxRef.storage.get(PREFS_KEY) : null);
}
function writePrefs(prefs) {
  if (ctxRef) ctxRef.storage.set(PREFS_KEY, sanitizePrefs(prefs));
}

// ── token / 客户端 ───────────────────────────────────────────────
async function loadToken() {
  if (!ctxRef || !ctxRef.deps.secrets) return null;
  const owner = ctxRef;
  const snapshot = session.capture();
  await session.drain();
  if (!isCurrent(snapshot)) return null;
  const raw = await owner.deps.secrets.get(TOKEN_SECRET_KEY);
  if (!isCurrent(snapshot)) return null;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function ensureClient() {
  const snapshot = session && session.capture();
  if (!isCurrent(snapshot) || login.state === "connecting" || login.state === "scanning") return null;
  const token = await loadToken();
  if (!isCurrent(snapshot)) return null;
  if (!token || !token.service_token || !token.ssecurity || !token.user_id) return null;
  if (!auth) auth = new MiCloudAuth(token, { signal: snapshot.signal });
  if (!client) client = new MiCloudClient(auth);
  return client;
}
async function persistToken(token, snapshot) {
  if (!token || !isCurrent(snapshot)) return false;
  if (!await session.save(token, snapshot) || !isCurrent(snapshot)) return false;
  auth = null;
  client = null;
  return true;
}

// ── 网络 / 蓝牙检测 ───────────────────────────────────────────────
// 主进程侧只能可靠判断“是否有活动网络”和“是否存在疑似无线网卡”；
// 蓝牙可用性由渲染层 navigator.bluetooth.getAvailability() 判定。
function detectNetwork() {
  const ifaces = os.networkInterfaces();
  let online = false;
  let wifi = false;
  for (const [name, addrs] of Object.entries(ifaces)) {
    const lower = String(name).toLowerCase();
    const looksWifi = /wi-?fi|wlan|wireless|无线/.test(lower);
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) {
        online = true;
        if (looksWifi) wifi = true;
      }
    }
  }
  return { online, wifi };
}

// ── 设备归一化 ────────────────────────────────────────────────────
function categoryOf(model) {
  const m = String(model || "").toLowerCase();
  if (/watch|band|wearable/.test(m)) return "穿戴";
  if (/light|lamp|bulb|ceiling/.test(m)) return "灯";
  if (/fan/.test(m)) return "风扇";
  if (/plug|socket/.test(m)) return "插座";
  if (/purifier/.test(m)) return "空气净化器";
  if (/humidifier/.test(m)) return "加湿器";
  if (/vacuum|robot|roborock/.test(m)) return "扫地机器人";
  if (/camera|cvs/.test(m)) return "摄像机";
  if (/lock/.test(m)) return "门锁";
  if (/curtain|door-b/.test(m)) return "窗帘";
  if (/sensor|magnet|smoke|weather|temperature|humidity/.test(m)) return "传感器";
  if (/switch|remote|ctrl/.test(m)) return "开关";
  if (/tv|audio|speaker|box/.test(m)) return "影音";
  if (/aircond|air-purifier|acpartner|ir/.test(m)) return "空调/遥控";
  return "设备";
}
function normalizeDevice(d, roomMap) {
  const did = String(d.did || "");
  const room = roomMap[did] || {};
  const online = d.online === undefined ? Boolean(d.isOnline) : Boolean(d.online);
  return {
    did,
    name: String(d.name || d.alias || did),
    model: String(d.model || ""),
    localip: String(d.localip || ""),
    mac: String(d.mac || ""),
    online,
    room: room.roomName || "未分配房间",
    home: room.homeName || "我的家",
    category: categoryOf(d.model),
    isChild: Boolean(d.parent_id),
    source: "cloud",
  };
}

// ── 云端扫描 ──────────────────────────────────────────────────────
async function scanCloud(snapshot = session && session.capture()) {
  const c = await ensureClient();
  if (!c || !isCurrent(snapshot)) return { ok: false, error: "尚未连接" };
  try {
    const [devices, roomMap] = await Promise.all([c.getDevices(), c.getRoomMap()]);
    if (!isCurrent(snapshot)) return { ok: false, error: "会话已变更，已丢弃旧数据" };
    cache.roomMap = roomMap;
    const norm = devices.map((d) => normalizeDevice(d, roomMap));
    // 合并此前局域网发现的设备（按 did/ip 去重）
    const seen = new Set(norm.map((d) => d.did));
    for (const lan of cache.devices.filter((d) => d.source === "lan")) {
      if (!seen.has(lan.did)) norm.push(lan);
    }
    cache.devices = norm;
    cache.fetchedAt = Date.now();
    cache.lastError = "";
    broadcastDevices();
    if (ctxRef) ctxRef.log(`米家云扫描：${norm.length} 台设备`);
    void enrichDeviceSpecs(snapshot); // 后台按 spec 标注可控性，完成后再次广播
    return { ok: true, count: norm.length };
  } catch (err) {
    if (!isCurrent(snapshot)) return { ok: false, error: "请求已取消" };
    cache.lastError = err && err.message ? err.message : String(err);
    if (err instanceof TokenExpiredError) await persistToken(auth ? auth.token : null, snapshot);
    if (ctxRef) ctxRef.log(`米家云扫描失败：${cache.lastError}`);
    return { ok: false, error: cache.lastError };
  }
}

// ── 局域网扫描（best-effort：向 54321 广播 miio hello，记录应答 IP）──────
function scanLan(timeoutMs = 2500, snapshot = session && session.capture()) {
  return new Promise((resolve) => {
    if (!isCurrent(snapshot)) { resolve([]); return; }
    let sock;
    try {
      sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }
    const found = new Map();
    const hello = Buffer.alloc(32, 0xff);
    hello.writeUInt16BE(0x2131, 0);
    hello.writeUInt16BE(hello.length, 2);
    let done = false;
    let timer;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      snapshot.signal.removeEventListener("abort", finish);
      try {
        sock.close();
      } catch {
        /* 忽略 */
      }
      const list = [...found.values()];
      if (!isCurrent(snapshot)) { resolve([]); return; }
      cache.lanIps = list.map((x) => x.localip);
      // 把局域网发现但云端没有的设备并入缓存（占位，可后续补全）
      const known = new Set(cache.devices.map((d) => d.localip).filter(Boolean));
      for (const item of list) {
        if (!known.has(item.localip)) {
          cache.devices.push({
            did: `lan-${item.localip}`,
            name: `局域网设备 ${item.localip}`,
            model: "",
            localip: item.localip,
            mac: "",
            online: true,
            room: "局域网",
            home: "我的家",
            category: "设备",
            isChild: false,
            source: "lan",
          });
        }
      }
      broadcastDevices();
      resolve(list);
    };
    sock.on("message", (msg, rinfo) => {
      if (msg.length >= 8 && msg.readUInt16BE(0) === 0x2131) {
        found.set(rinfo.address, { localip: rinfo.address, raw: msg.length });
      }
    });
    sock.on("error", finish);
    snapshot.signal.addEventListener("abort", finish, { once: true });
    timer = setTimeout(finish, timeoutMs);
    sock.bind(0, () => {
      if (done || !isCurrent(snapshot)) {
        try { sock.close(); } catch { /* bind may complete after cancellation */ }
        finish();
        return;
      }
      try {
        sock.setBroadcast(true);
        sock.send(hello, 0, hello.length, 54321, "255.255.255.255", () => {});
      } catch {
        /* 忽略 */
      }
    });
  });
}

async function fullScan() {
  const snapshot = session && session.capture();
  const result = await scanCloud(snapshot);
  if (isCurrent(snapshot)) void scanLan(2500, snapshot);
  return result;
}

// ── 按 MIoT-Spec 标注设备可控性（异步、不阻断首屏）──────────────
// 为每台设备回填 hasControl / noSpec：面板与 AI 清单据此区分“可操控 / 仅展示 / 未知”。
async function enrichDeviceSpecs(snapshot = session && session.capture()) {
  const manager = spec;
  if (!manager || !isCurrent(snapshot)) return;
  const models = [...new Set(cache.devices.filter((d) => d.source === "cloud" && d.model).map((d) => d.model))];
  if (!models.length) return;
  const descByModel = {};
  for (const m of models) {
    if (!isCurrent(snapshot)) return;
    try {
      descByModel[m] = await manager.getSpec(m);
    } catch {
      /* 单台失败不影响其余 */
    }
  }
  if (!isCurrent(snapshot)) return;
  let changed = false;
  for (const d of cache.devices) {
    const desc = descByModel[d.model];
    if (!desc) continue;
    const nc = desc.noSpec ? "unknown" : desc.hasControl ? "controllable" : "none";
    if (d.controlState !== nc) {
      d.controlState = nc;
      d.hasControl = Boolean(desc.hasControl);
      changed = true;
    }
  }
  if (changed) broadcastDevices();
}

// ── 设备解析（供工具与 UI 复用）──────────────────────────────────────
function resolveDevice(query) {
  const q = String(query || "").trim();
  if (!q) return { error: "未指定设备" };
  const list = cache.devices;
  let hit = list.find((d) => d.did === q);
  if (!hit) {
    const exact = list.filter((d) => d.name === q);
    const cands = exact.length ? exact : list.filter((d) =>
      (d.name && (d.name.includes(q) || q.includes(d.name))) || d.model.includes(q));
    if (cands.length === 1) hit = cands[0];
    else if (cands.length > 1)
      return { error: `匹配到多台设备：${cands.map((d) => `${d.room}·${d.name}(did=${d.did})`).join("、")}，请用 did 指定` };
  }
  if (!hit) return { error: `未找到设备：${q}` };
  if (hit.source === "lan") return { error: `局域网设备 ${hit.name} 尚未在云端登记，无法下发控制` };
  return { device: hit };
}

// ── 控制动作 ──────────────────────────────────────────────────────
// 电源坐标：优先用该设备 MIoT-Spec 里的电源属性，取不到时退回 DEFAULT_POWER。
async function powerOf(model) {
  if (spec) {
    try {
      const d = await spec.getSpec(model);
      if (d && d.power && Number.isFinite(d.power.siid) && Number.isFinite(d.power.piid)) {
        return { siid: d.power.siid, piid: d.power.piid };
      }
    } catch {
      /* 降级到默认 */
    }
  }
  return { ...DEFAULT_POWER };
}
async function setPower(did, on, power, snapshot) {
  const c = await ensureClient();
  if (!c || !isCurrent(snapshot)) return { ok: false, error: "会话已变更或尚未连接米家" };
  const p = power || DEFAULT_POWER;
  const r = await c.setProp(did, p.siid, p.piid, on);
  const code = r && r.code;
  return r && code === 0 && isCurrent(snapshot)
    ? { ok: true, value: r && r.value }
    : { ok: false, error: isCurrent(snapshot) ? controlErr(code) : "会话已变更，无法确认结果" };
}
async function getPower(did, power, snapshot) {
  const c = await ensureClient();
  if (!c || !isCurrent(snapshot)) return { ok: false, error: "会话已变更或尚未连接米家" };
  const p = power || DEFAULT_POWER;
  const [r] = await c.getProps([{ did, siid: p.siid, piid: p.piid }]);
  if (!isCurrent(snapshot)) return { ok: false, error: "会话已变更" };
  if (!r || r.code !== 0) return { ok: false, error: controlErr(r && r.code) };
  if (![true, false, 0, 1].includes(r.value)) return { ok: false, error: "设备开关状态未知" };
  return { ok: true, value: r.value === true || r.value === 1, code: 0 };
}

// 把常见米家云错误码翻译成人话（控制失败时展示）。
function controlErr(code) {
  if (code === undefined || code === null) return "未收到有效的设备应答，无法确认是否执行成功";
  const s = String(code);
  let hint = "";
  if (s.startsWith("-7040")) hint = "（云端无法送达：蓝牙 / 蓝牙 Mesh 设备需家中「蓝牙网关」在线，或设备当前离线）";
  else if (s === "-8") hint = "（该操作需要带类型的参数，公开 spec 未提供，无法盲发）";
  return `code=${s}${hint}`;
}

// ── 扫码登录 ──────────────────────────────────────────────────────
function resetLogin() {
  login.state = "idle";
  login.qr = "";
  login.loginUrl = "";
  login.error = "";
}
function broadcastLoginState() {
  if (pluginWin && !pluginWin.isDestroyed()) {
    try {
      pluginWin.webContents.send(LOGIN_PUSH, { state: login.state, qr: login.qr, loginUrl: login.loginUrl, error: login.error });
    } catch {
      /* 窗口关闭中 */
    }
  }
}
function broadcastDevices() {
  if (pluginWin && !pluginWin.isDestroyed()) {
    try {
      pluginWin.webContents.send(DEVICES_PUSH, devicesSnapshot());
    } catch {
      /* 忽略 */
    }
  }
}
function startLogin() {
  if (login.state === "scanning" || login.state === "connecting") {
    return { ok: true, state: login.state, alreadyRunning: true };
  }
  resetLogin();
  const snapshot = renewSession();
  const loginAuth = new MiCloudAuth(undefined, { signal: snapshot.signal });
  login.state = "connecting";
  void (async () => {
    try {
      const token = await loginAuth.loginQr(async (qrImageUrl, loginUrl) => {
        if (!isCurrent(snapshot)) return;
        login.qr = qrImageUrl || "";
        login.loginUrl = loginUrl || "";
        login.state = "scanning";
        broadcastLoginState();
      }, 300);
      if (!await persistToken(token, snapshot) || !isCurrent(snapshot)) return;
      auth = null;
      client = null;
      login.state = "connected";
      broadcastLoginState();
      if (ctxRef) ctxRef.log(`米家扫码登录成功：user_id=${token.user_id}`);
      await fullScan();
    } catch (err) {
      if (!isCurrent(snapshot)) return;
      login.state = "error";
      login.error = err && err.message ? err.message : String(err);
      broadcastLoginState();
      if (ctxRef) ctxRef.log(`米家扫码登录失败：${login.error}`);
    }
  })();
  return { ok: true, state: login.state };
}
async function cancelLogin() {
  renewSession();
  resetLogin();
  broadcastLoginState();
  await session.drain();
  return { ok: true, state: login.state };
}
async function logoutAndClear() {
  const snapshot = renewSession();
  resetLogin();
  if (ctxRef && ctxRef.deps.secrets) {
    await session.clear();
  }
  if (!isCurrent(snapshot)) return { ok: true, superseded: true };
  auth = null;
  client = null;
  cache.devices = [];
  cache.roomMap = {};
  cache.fetchedAt = 0;
  cache.lanIps = [];
  broadcastDevices();
  broadcastLoginState();
  if (ctxRef) ctxRef.log("已退出米家登录并清空设备缓存");
  return { ok: true, connected: false };
}

// ── 状态快照 ──────────────────────────────────────────────────────
function devicesSnapshot() {
  return {
    devices: cache.devices,
    fetchedAt: cache.fetchedAt,
    lastError: cache.lastError,
    lanIps: cache.lanIps,
  };
}
async function readStatus() {
  const token = await loadToken();
  const connected = Boolean(token && token.service_token && token.ssecurity && token.user_id);
  const net = detectNetwork();
  return {
    connected,
    userId: token ? String(token.user_id) : "",
    canRefresh: Boolean(token && token.pass_token && token.user_id),
    loginState: login.state,
    qr: login.qr,
    loginUrl: login.loginUrl,
    loginError: login.error,
    deviceCount: cache.devices.length,
    devices: cache.devices,
    fetchedAt: cache.fetchedAt,
    lastError: cache.lastError,
    netOnline: net.online,
    netWifi: net.wifi,
    prefs: readPrefs(),
  };
}

// ── 供 AI 工具消费的设备清单文本 ─────────────────────────────────
function describeDevices() {
  // 排除“仅展示”设备（如手表/手环，spec 无可写属性也无动作），避免误向 AI 暴露。
  const list = cache.devices.filter((d) => d.controlState !== "none");
  if (!list.length) return cache.devices.length ? "（当前设备均不可远程操控）" : "（当前没有扫描到设备，可能未连接或尚未同步）";
  const byRoom = {};
  for (const d of list) (byRoom[d.room] = byRoom[d.room] || []).push(d);
  const lines = [`【米家可操控设备 · 共 ${list.length} 台 · ${new Date(cache.fetchedAt || Date.now()).toLocaleString("zh-CN")}】`];
  for (const [room, ds] of Object.entries(byRoom)) {
    lines.push(`· ${room}：` + ds.map((d) => `${d.name}(${d.category},${d.online ? "在线" : "离线"},did=${d.did})`).join("；"));
  }
  return lines.join("\n");
}

// ── 每轮上下文注入（受 chatInject 控制，不联网）────────────────────
function buildMijiaContext() {
  if (!ctxRef || !readPrefs().chatInject) return "";
  if (!cache.devices.length) return "";
  return [
    "[米家控制] 机主已连接米家账号，名下有以下智能家居设备。查设备与状态用只读工具（mijia-control_list_devices 列设备与 did、mijia-control_get_state 读属性、mijia-control_status 查连接），无副作用、可随时调。",
    "操控设备用 mijia-control_control（传 device、op（on/off/toggle/set/call）；set 需 siid/piid/value，call 需 siid/aiid（可选 in））。它会产生真实副作用且仅在工具清单里存在时可用（闲聊需开启 Chat 工具增强并勾选，work 模式默认可用）；若清单里没有，则如实说明当前无法操控，切勿声称已控制或编造调用结果。",
    "确认纪律：调 mijia-control_control 前，除非机主本轮已明确直接下令（如“把客厅灯打开”“关掉空调”），否则必须先用 ask_user 向机主确认“要执行此操作吗？”，得到肯定答复后再执行；用户拒绝或含糊则不执行。",
    describeDevices(),
  ].join("\n");
}

// ── 后台扫描 ──────────────────────────────────────────────────────
function startScanLoop() {
  stopScanLoop();
  const prefs = readPrefs();
  if (!prefs.autoScan) return;
  scanTimer = setInterval(() => {
    void fullScan().catch((err) => { if (ctxRef && !ctxRef.signal.aborted) ctxRef.log(`设备扫描失败：${err.message}`); });
  }, prefs.scanIntervalMin * 60 * 1000);
  if (scanTimer.unref) scanTimer.unref();
  if (ctxRef) ctxRef.log(`米家设备扫描已启动（每 ${prefs.scanIntervalMin} 分钟）`);
}
function stopScanLoop() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

// ── 窗口控制 ──────────────────────────────────────────────────────
function installWindowControls() {
  if (winControlsInstalled) return;
  const { ipcMain } = require("electron");
  const minimize = () => {
    if (pluginWin && !pluginWin.isDestroyed()) pluginWin.minimize();
  };
  const maximize = () => {
    if (!pluginWin || pluginWin.isDestroyed()) return;
    if (pluginWin.isMaximized()) pluginWin.unmaximize();
    else pluginWin.maximize();
  };
  const close = () => {
    if (pluginWin && !pluginWin.isDestroyed()) pluginWin.close();
  };
  ipcMain.on(WIN_MIN_CHANNEL, minimize);
  ipcMain.on(WIN_MAX_CHANNEL, maximize);
  ipcMain.on(WIN_CLOSE_CHANNEL, close);
  removeWindowControls = () => {
    ipcMain.removeListener(WIN_MIN_CHANNEL, minimize);
    ipcMain.removeListener(WIN_MAX_CHANNEL, maximize);
    ipcMain.removeListener(WIN_CLOSE_CHANNEL, close);
    winControlsInstalled = false;
    removeWindowControls = null;
  };
  winControlsInstalled = true;
}

// ── 工具执行封装 ──────────────────────────────────────────────────
async function runControl(args) {
  const snapshot = session && session.capture();
  const c = await ensureClient();
  if (!c || !isCurrent(snapshot)) return "尚未连接米家。请在插件窗口扫码登录后再试。";
  const resolved = resolveDevice(args.device);
  if (resolved.error) return resolved.error;
  const dev = resolved.device;
  const op = String(args.op || "toggle").toLowerCase();
  const power = await powerOf(dev.model);
  if (!isCurrent(snapshot)) return "会话已变更，操作已取消。";
  const dbg = `${dev.name}(did=${dev.did} model=${dev.model}) op=${op} power=${JSON.stringify(power)}`;
  const okCode = (code) => code === 0 && isCurrent(snapshot);
  try {
    if (op === "on" || op === "off") {
      const r = await setPower(dev.did, op === "on", power, snapshot);
      if (ctxRef) ctxRef.log(`[control] ${dbg} setPower(${op === "on"}) => ${JSON.stringify(r)}`);
      return r.ok ? `已${op === "on" ? "打开" : "关闭"}：${dev.name}` : `${dev.name} 操作失败：${r.error}`;
    }
    if (op === "toggle") {
      const cur = await getPower(dev.did, power, snapshot);
      if (!cur.ok) return `${dev.name} 状态读取失败，未执行切换：${cur.error}`;
      const target = !cur.value;
      const r = await setPower(dev.did, target, power, snapshot);
      if (ctxRef) ctxRef.log(`[control] ${dbg} toggle cur=${JSON.stringify(cur)} => ${JSON.stringify(r)}`);
      return r.ok ? `已将 ${dev.name} ${target ? "打开" : "关闭"}` : `${dev.name} 操作失败：${r.error}`;
    }
    if (op === "set") {
      if (!Number.isFinite(args.siid) || !Number.isFinite(args.piid)) return "set 需要提供 siid 与 piid";
      const r = await c.setProp(dev.did, args.siid, args.piid, args.value);
      const code = r && r.code;
      if (ctxRef) ctxRef.log(`[control] ${dbg} set siid=${args.siid} piid=${args.piid} value=${JSON.stringify(args.value)} => ${JSON.stringify(r)}`);
      return okCode(code)
        ? `已设置 ${dev.name} siid=${args.siid} piid=${args.piid}`
        : `${dev.name} 设置失败 ${controlErr(code)}${r && r.message ? "（" + r.message + "）" : ""}`;
    }
    if (op === "call") {
      if (!Number.isFinite(args.siid) || !Number.isFinite(args.aiid)) return "call 需要提供 siid 与 aiid";
      const inArr = Array.isArray(args.in) ? args.in : [];
      const r = await c.callAction(dev.did, args.siid, args.aiid, inArr);
      const code = r && r.code;
      if (ctxRef) ctxRef.log(`[control] ${dbg} call siid=${args.siid} aiid=${args.aiid} in=${JSON.stringify(inArr)} => ${JSON.stringify(r)}`);
      return okCode(code)
        ? `已在 ${dev.name} 执行动作 siid=${args.siid} aiid=${args.aiid}${r && r.out !== undefined ? "：" + JSON.stringify(r.out) : ""}`
        : `${dev.name} 动作失败 ${controlErr(code)}${r && r.message ? "（" + r.message + "）" : ""}`;
    }
    return `未知操作类型：${op}`;
  } catch (err) {
    if (ctxRef) ctxRef.log(`[control] ${dbg} 异常：${err && err.message ? err.message : String(err)}`);
    if (err instanceof TokenExpiredError) return "米家登录已过期，请在插件窗口重新扫码登录。";
    return `操控 ${dev.name} 失败：${err && err.message ? err.message : String(err)}`;
  }
}

const mijiaControlPlugin = {
  register(ctx) {
    ctxRef = ctx;
    session = createSession(ctx, TOKEN_SECRET_KEY);

    ctx.registerTool({
      id: `${PLUGIN_ID}_list_devices`,
      name: "米家设备列表",
      description:
        "列出机主米家账号下可控制的智能家居设备（含名称、类别、房间、在线状态、did）。在操控设备前用它确认设备名与 did。只读，无副作用。",
      enabled: true,
      risk: "network",
      effectKind: "read",
      chatBuiltin: true,
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        const snapshot = session && session.capture();
        const c = await ensureClient();
        if (!c || !isCurrent(snapshot)) return "尚未连接米家。请在插件窗口扫码登录后再试。";
        if (!cache.devices.length) await scanCloud();
        if (!isCurrent(snapshot)) return "会话已变更，请重新查询。";
        return describeDevices();
      },
    });

    ctx.registerTool({
      id: `${PLUGIN_ID}_status`,
      name: "米家连接状态",
      description: "查询米家控制插件的连接状态：是否已登录、设备数量、上次扫描时间、网络是否在线。只读，无副作用。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      chatBuiltin: true,
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        const s = await readStatus();
        const lines = [];
        lines.push(`已连接：${s.connected ? "是" : "否"}`);
        if (s.connected) lines.push(`账号：${s.nickname || s.userId}`);
        lines.push(`设备数量：${s.deviceCount}`);
        lines.push(`上次扫描：${s.fetchedAt ? new Date(s.fetchedAt).toLocaleString("zh-CN") : "从未"}`);
        lines.push(`本机网络：${s.netOnline ? "在线" : "离线"}${s.netWifi ? "（WiFi）" : ""}`);
        if (s.lastError) lines.push(`最近错误：${s.lastError}`);
        return lines.join("\n");
      },
    });

    ctx.registerTool({
      id: `${PLUGIN_ID}_control`,
      name: "米家设备操控",
      description:
        "控制一台米家设备（真实副作用，会改动现实设备）。op=on/off 直接开关（用常见 siid=2/piid=1）；op=toggle 取反；op=set 需 siid/piid/value 写任意属性；op=call 需 siid/aiid（可选 in 数组）执行动作。device 传设备名或 did。调用纪律：除非机主本轮已明确直接下令开关/调节某设备（如“把客厅灯打开”），否则必须先用 ask_user 向机主确认“要执行此操作吗？”，得到肯定答复后再调用本工具；用户拒绝或含糊则不要执行。",
      enabled: true,
      risk: "network",
      effectKind: "mutation",
      inputSchema: {
        type: "object",
        properties: {
          device: { type: "string", description: "设备名称或 did" },
          op: { type: "string", enum: ["on", "off", "toggle", "set", "call"], description: "操作类型，默认 toggle" },
          siid: { type: "number", description: "set/call 时的服务实例 id" },
          piid: { type: "number", description: "set 时的属性 id" },
          aiid: { type: "number", description: "call 时的动作 id" },
          value: { description: "set 时要写入的属性值" },
          in: { type: "array", description: "call 动作的输入参数数组" },
        },
        required: ["device"],
      },
      async execute(args) {
        return runControl(args);
      },
    });

    ctx.registerTool({
      id: `${PLUGIN_ID}_get_state`,
      name: "米家设备属性读取",
      description: "读取一台设备的一个或多个 MiOT 属性值（传 did 或设备名，以及 props=[{siid,piid}]）。用于查询当前状态。只读，无副作用。",
      enabled: true,
      risk: "network",
      effectKind: "read",
      chatBuiltin: true,
      inputSchema: {
        type: "object",
        properties: {
          device: { type: "string", description: "设备名称或 did" },
          props: { type: "array", description: '要读取的属性列表，如 [{"siid":2,"piid":1}]' },
        },
        required: ["device"],
      },
      async execute(args) {
        const snapshot = session && session.capture();
        const c = await ensureClient();
        if (!c || !isCurrent(snapshot)) return "尚未连接米家。";
        const resolved = resolveDevice(args.device);
        if (resolved.error) return resolved.error;
        const dev = resolved.device;
        const props = Array.isArray(args.props) && args.props.length
          ? args.props
          : [{ siid: DEFAULT_POWER.siid, piid: DEFAULT_POWER.piid }];
        try {
          const rls = await c.getProps(props.map((p) => ({ did: dev.did, siid: p.siid, piid: p.piid })));
          if (!isCurrent(snapshot)) return "会话已变更，已丢弃旧数据。";
          return `${dev.name}：` + rls.map((r) => `siid=${r.siid} piid=${r.piid} = ${JSON.stringify(r.value)}(code=${r.code})`).join("；");
        } catch (err) {
          return `读取 ${dev.name} 属性失败：${err && err.message ? err.message : String(err)}`;
        }
      },
    });

    ctx.registerPromptProvider({
      id: "mijia-context",
      modes: ["chat", "work"],
      sources: ["conversation"],
      provide: () => buildMijiaContext(),
    });

    // ── UI IPC ──
    ctx.registerIpc("status", () => readStatus());
    ctx.registerIpc("loginStart", () => startLogin());
    ctx.registerIpc("loginCancel", () => cancelLogin());
    ctx.registerIpc("logout", () => logoutAndClear());
    ctx.registerIpc("rescan", async () => {
      const r = await fullScan();
      return { ...r, ...devicesSnapshot() };
    });
    ctx.registerIpc("devices", () => devicesSnapshot());
    ctx.registerIpc("netInfo", () => detectNetwork());
    ctx.registerIpc("deviceSpec", async (did) => {
      const snapshot = session && session.capture();
      const resolved = resolveDevice(did);
      if (resolved.error) return { ok: false, error: resolved.error };
      const dev = resolved.device;
      const c = await ensureClient();
      if (!c || !isCurrent(snapshot)) return { ok: false, error: "会话已变更或尚未连接" };
      let desc = { model: dev.model, noSpec: true, controls: [], actions: [], power: null, hasControl: false };
      if (spec) {
        try {
          desc = await spec.getSpec(dev.model);
        } catch (err) {
          desc.error = err && err.message ? err.message : String(err);
        }
      }
      // 读取当前值（仅可读属性，最多 40 个），失败不阻断渲染。
      const values = {};
      if (!isCurrent(snapshot)) return { ok: false, error: "会话已变更" };
      const wantRead = (desc.controls || []).filter((x) => x.readable).slice(0, 40);
      if (c && wantRead.length) {
        try {
          const rls = await c.getProps(wantRead.map((x) => ({ did: dev.did, siid: x.siid, piid: x.piid })));
          for (const r of rls) {
            if (!r) continue;
            values[`${r.siid}:${r.piid}`] = { value: r.value, code: r.code };
          }
        } catch {
          /* 忽略读取错误 */
        }
      }
      if (!isCurrent(snapshot)) return { ok: false, error: "会话已变更，已丢弃旧数据" };
      return {
        ok: true,
        device: { did: dev.did, name: dev.name, model: dev.model, room: dev.room, category: dev.category, online: dev.online },
        spec: desc,
        values,
      };
    });
    ctx.registerIpc("control", async (args) => runControl(args || {}));
    ctx.registerIpc("getPrefs", () => readPrefs());
    ctx.registerIpc("setPrefs", (prefs) => {
      const merged = sanitizePrefs(prefs);
      writePrefs(merged);
      startScanLoop();
      return { ok: true, prefs: merged };
    });

    // MIoT-Spec 能力层：用宿主 storage 做索引/单型号落盘缓存，启动即预热索引。
    spec = createSpecManager({
      signal: ctx.signal,
      storage: { get: (k) => ctx.storage.get(k), set: (k, v) => ctx.storage.set(k, v) },
      log: (m) => ctx.log(m),
    });
    void spec.init();

    // 启动即尝试一次扫描（若已登录）+ 拉起后台扫描；停止时清理。
    void (async () => {
      const c = await ensureClient();
      if (c) await fullScan();
      if (!ctx.signal.aborted) startScanLoop();
    })().catch((err) => { if (!ctx.signal.aborted) ctx.log(`米家插件初始化失败：${err.message}`); });
    ctx.onDispose(() => {
      session?.stop();
      removeWindowControls?.();
      stopScanLoop();
    });

    ctx.log("米家控制插件已注册：list/status/control/get_state 工具 + 对话注入 + 云端/局域网扫描 + 面板 IPC");
  },

  async open() {
    if (pluginWin && !pluginWin.isDestroyed()) {
      pluginWin.focus();
      return;
    }
    const { BrowserWindow } = require("electron");
    installWindowControls();
    pluginWin = new BrowserWindow({
      width: 520,
      height: 720,
      minWidth: 420,
      minHeight: 560,
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
    // 打开面板即触发一次扫描（需求：打开插件页面时扫描）
    void (async () => {
      const c = await ensureClient();
      if (c) await fullScan();
    })().catch((err) => { if (ctxRef && !ctxRef.signal.aborted) ctxRef.log(`打开面板扫描失败：${err.message}`); });
  },

  unregister() {
    session?.stop();
    removeWindowControls?.();
    stopScanLoop();
    if (pluginWin && !pluginWin.isDestroyed()) pluginWin.close();
    ctxRef = null;
    auth = null;
    client = null;
    resetLogin();
    cache.devices = [];
    cache.roomMap = {};
    cache.fetchedAt = 0;
    cache.lastError = "";
    cache.lanIps = [];
    spec = null;
    cache.profile = null;
  },
};

module.exports = mijiaControlPlugin;
module.exports.default = mijiaControlPlugin;
