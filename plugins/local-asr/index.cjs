/**
 * local-asr 插件 v0.4.0（唤醒词门控版）
 *
 * v0.1.0 工作方式（全部保留）：
 * 1. 插件自有窗口（ui.html）用 getUserMedia + AudioWorklet 采集 16kHz PCM
 * 2. PCM 块经插件私有 IPC 推到主进程，主进程做能量 VAD 分句
 * 3. 句尾把整句送识别，文本经 speech-input 租约 commit 提交进通话/聊天
 * 4. host:turn:started / finished 协调：等昔联回复期间暂停采集
 *
 * v0.2.0：环境体检 + 一键修复设置 + 外置服务自启
 *
 * v0.3.0：零环境小白可用（本版核心）
 * - 启用/打开时体检：无外置服务且无内置引擎 → 自动下载安装轻量引擎
 * - 轻量引擎 = sherpa-onnx（NAPI addon，CPU）+ paraformer int8 模型
 *   下载源全部国内直连：npmmirror（二进制 8.7MB）+ ModelScope（模型 243MB）
 *   实测 CPU 识别 5.6s 音频约 220ms（实时率 ~4%），NAPI 跨 Electron ABI
 * - 识别优先级：外置 FunASR(8328, GPU) > 内置引擎(CPU) > 报错引导
 * - 全程 decodeAsync/createAsync 非阻塞，不卡 Electron 主进程
 *
 * v0.3.2：下载可靠性
 * - 断点续传：.part + .part.json（记录来源 URL），中断后下次从断点续传（HTTP Range）；
 *   跨源不续传（防止不同源文件拼接损坏），服务器不支持 Range 时自动从头下
 * - 取消即时生效：AbortController 立即断连接，不再"下完当前文件才停"
 * - 416 兜底：下完但没 rename 就中断的，直接补 rename 收工
 * - 取消记忆：storage 标记 autoInstallDeclined，用户取消过就不再自动下载（手动点安装重置）
 *   （v0.4.5 已移除自动下载，此机制随之废弃，仅作历史记录）
 * v0.4.6：内置引擎进程隔离（修复宿主闪退）
 * - 根因：宿主主进程启动时已加载 onnxruntime-node 的 onnxruntime.dll
 *   （bge-reranker 等内置 AI 在用），Windows 加载器按模块名去重，
 *   sherpa-onnx.node 静态绑定到这份不兼容 DLL，推理瞬间 abort
 *   （0xc0000409 / FAST_FAIL_FATAL_APP_EXIT）连带宿主整个闪退
 * - 修复：sherpa 引擎整体挪进独立子进程（asr-worker.cjs，
 *   ELECTRON_RUN_AS_NODE=1 纯 Node 运行），进程内只有 sherpa 自己的 DLL；
 *   子进程崩溃宿主无感，下次识别自动重启，60s 内连崩 3 次熔断停启
 * - 音频经 IPC structured clone（serialization: advanced）传 Float32Array，
 *   零拷贝损耗；识别超时 30s
 * v0.4.5：供应链安全 + 显式确认安装（审核反馈）
 * - 全部下载文件（2 个 tgz + 模型 + 词表）按镜像源硬编码 SHA-256：
 *   下载完成后先校验哈希，通过才落盘/解包/加载（来源：npmmirror registry
 *   dist.shasum 验证副本一致后计算；ModelScope 官方 repo/files API 的 Sha256）
 * - 修复 sherpa-onnx-node 包大小写错（61221 → 实际 11954，会导致全新装机失败）
 * - DEFAULT_SERVICE_CONFIG 不再写死作者本机路径，默认空 + UI 引导选择
 * - 启用不再自动下载 250MB：只探测并提示，面板点击「安装」按钮（显式确认）才下载
 * v0.4.0：唤醒词门控（小爱模式）
 * - 音乐播放时麦克风会录到扬声器（歌词/伴奏），VAD 不停误触发
 * - 门控：音乐播放中，只有含唤醒词（默认 昔涟/小昔）的语句或音乐快捷指令才提交，
 *   其余静默丢弃；唤醒词命中时去掉前缀再提交（"昔涟暂停音乐"→"暂停音乐"）
 * - 音乐状态来源：面板窗口轮询宿主 music:get-status（v1.2.2+ 内置音乐工具）
 * - 模式：off / music（推荐）/ always，面板可改唤醒词（最多 6 个）
 * - UI：下载速度（MB/s）+ 已下/总量显示
 *
 * 为什么运行环境不打包进 zip：宿主限制包体 ≤50MiB / 解压总量 ≤200MiB，
 * 轻量引擎本体（二进制 23MB + 模型 243MB）也放不下模型，故按需在线安装。
 *
 * 租约契约（官方 examples/local-asr-contract 同款）：
 * - abort 必停；commit 失败按稳定错误码分支；release 幂等
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawn, fork } = require("node:child_process");
const { createHash } = require("node:crypto");
const zlib = require("node:zlib");
const { pipeline: streamPipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const { app, dialog, BrowserWindow } = require("electron");

const PLUGIN_ID = "local-asr";
const CH_CAPTURE_CMD = "plugin:local-asr:capture-cmd"; // 主进程 → 渲染进程 麦克风控制
const ASR_BASE = "http://127.0.0.1:8328";
const ASR_MODEL = "moss-transcribe";
const TTS_BASE = "http://127.0.0.1:8327";

/* ---------------- 可调参数 ---------------- */
const VAD_RMS = 0.012;        // 语音能量阈值（RMS）
const SILENCE_MS = 800;      // 句后静音判定时长
const MIN_SPEECH_MS = 350;   // 最短有效句长（防噪音）
const MAX_SPEECH_MS = 30000; // 最长句强制切分
const RESUME_GUARD_MS = 15000; // turn:finished 丢失保底恢复时长

/* ---------------- 轻量引擎下载源（全部国内直连，已实测） ----------------
 * npmmirror（阿里）：sherpa-onnx-node 主包 12KB + win-x64 二进制 8.7MB，
 *   二进制含 onnxruntime.dll / sherpa-onnx.node（NAPI，无安装脚本）
 * ModelScope（阿里）：paraformer int8 模型 243MB + tokens.txt，多镜像回退
 *
 * 供应链安全（v0.4.5）：每个文件硬编码 SHA-256，下载后先校验再落盘/解包/加载。
 * 哈希来源（2026-09-09 核实）：
 * - npmmirror 两个 tgz：本地副本 sha1 与 registry dist.shasum 逐字节比对一致后计算
 * - ModelScope 模型/词表：官方 repo/files API 返回的 Sha256 字段
 * 注意：npmmirror/ModelScope 均为可变第三方来源，同尺寸恶意替换无法靠大小校验
 * 发现，哈希锁定是"运行时下载 + 动态 require"可接受的前提。
 * sherpa-onnx 引擎版本升级时必须同步更新这里的 size 与 sha256。 */
const NPMMIRROR = "https://registry.npmmirror.com";
const SHERPA_VERSION = "1.13.7";
const ENGINE_PARTS = [
  {
    id: "addon-main",
    label: "引擎主程序",
    url: `${NPMMIRROR}/sherpa-onnx-node/-/sherpa-onnx-node-${SHERPA_VERSION}.tgz`,
    dest: "sherpa-onnx-node",
    size: 11954,
    sha256: "4fd585c8a9f66a3d0ab8837f41350556f79aeea30da21b86a6e440e79734421f",
  },
  {
    id: "addon-win",
    label: "推理二进制",
    url: `${NPMMIRROR}/sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-${SHERPA_VERSION}.tgz`,
    dest: "sherpa-onnx-win-x64",
    size: 8705089,
    sha256: "c0576cf5f0a3439d3fecfeac6b3a60314a4b109d0054f848581c284f1f5b0b93",
  },
];
const MODEL_SOURCES = [
  {
    id: "model",
    label: "识别模型",
    url: "https://modelscope.cn/models/HZZSCIENCE/sherpa-onnx-paraformer-zh-2023-09-14/resolve/master/model.int8.onnx",
    dest: "models/model.int8.onnx",
    size: 243371218,
    sha256: "f36a0433bcf096bd6d6f11b80a3ac8bed110bdca632fe0d731df8d1a84475945",
  },
  {
    id: "model",
    label: "识别模型(镜像1)",
    url: "https://modelscope.cn/models/xnnehang/sherpa-onnx-paraformer-zh-2023-09-14/resolve/master/model.int8.onnx",
    dest: "models/model.int8.onnx",
    size: 243371218,
    sha256: "f36a0433bcf096bd6d6f11b80a3ac8bed110bdca632fe0d731df8d1a84475945",
  },
  {
    id: "model",
    label: "识别模型(镜像2)",
    url: "https://modelscope.cn/models/pengzhendong/sherpa-onnx-paraformer-zh/resolve/master/model.int8.onnx",
    dest: "models/model.int8.onnx",
    size: 227330205,
    sha256: "90bc03034ae1bef9575f8cc798cd1519c8be8aa9e8b458a033e32017ff4d584c",
  },
];
const TOKENS_SOURCES = [
  {
    id: "tokens",
    label: "词表",
    url: "https://modelscope.cn/models/HZZSCIENCE/sherpa-onnx-paraformer-zh-2023-09-14/resolve/master/tokens.txt",
    dest: "models/tokens.txt",
    size: 75756,
    sha256: "59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6",
  },
  {
    id: "tokens",
    label: "词表(镜像1)",
    url: "https://modelscope.cn/models/xnnehang/sherpa-onnx-paraformer-zh-2023-09-14/resolve/master/tokens.txt",
    dest: "models/tokens.txt",
    size: 75756,
    sha256: "59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6",
  },
];

/* ---------------- 外置服务配置（v0.2.0，保留） ----------------
 * v0.4.5：默认值为空——不再写死作者本机路径。首次使用时在面板
 * 「服务配置」里点「选择可执行文件」（ASR 推荐 start_asr_silent.bat，
 * TTS 推荐 pythonw.exe）即可，选择结果持久化到插件 storage。 */
const DEFAULT_SERVICE_CONFIG = {
  asr: { exe: "", args: [], cwd: "" },
  tts: { exe: "", args: [], cwd: "" },
};

/* ---------------- 运行时状态 ---------------- */
let ctxRef = null;      // PluginContext
let win = null;         // 采集窗口
let lease = null;      // 当前语音租约
let leaseTarget = "";  // "active-call" | "active-chat"
let recording = false; // 采集开关（renderer 在推流即 true）
let waitingTurn = false; // 等昔联回复中（丢弃音频）
let resumeGuard = null;  // 保底恢复定时器
let unsubscribeTurnStarted = null;
let unsubscribeTurnFinished = null;
let autoStartTried = false; // 本次 open 周期只自动拉起一次外置服务
let installHintTried = false; // 本次插件注册周期只提示一次"需要安装引擎"
let autoTakeoverTimer = null; // v0.4.7 通话自动接管轮询
let captureWin = null;        // v0.4.8 自动接管专用隐藏采集窗（面板没开时兜底）

/* ---------------- 采集窗口管理（v0.4.8） ---------------- */
/** 麦克风采集跑在渲染进程（ui.html getUserMedia）。自动接管时主进程必须把采集拉起来：
 *  面板开着 → 通知面板开麦；面板没开 → 造一个隐藏采集窗，会话结束再回收。 */
async function ensureCaptureRunning() {
  if (win && !win.isDestroyed()) {
    win.webContents.send(CH_CAPTURE_CMD, { cmd: "start" });
    logToUi("已通知面板开麦");
    return;
  }
  if (captureWin && !captureWin.isDestroyed()) {
    captureWin.webContents.send(CH_CAPTURE_CMD, { cmd: "start" });
    return;
  }
  captureWin = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    title: "ASR 采集（自动）",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  captureWin.on("closed", () => { captureWin = null; });
  await captureWin.loadFile(path.join(__dirname, "ui.html"), { search: "autocap=1" });
  captureWin.webContents.send(CH_CAPTURE_CMD, { cmd: "start" });
  logToUi("已创建隐藏采集窗（面板未打开）");
}

/** 通知渲染进程停麦；自动采集窗顺手回收 */
function notifyCaptureStop() {
  const msg = { cmd: "stop" };
  try { if (win && !win.isDestroyed()) win.webContents.send(CH_CAPTURE_CMD, msg); } catch {}
  try {
    if (captureWin && !captureWin.isDestroyed()) {
      captureWin.webContents.send(CH_CAPTURE_CMD, msg);
      setTimeout(() => {
        try { if (captureWin && !captureWin.isDestroyed()) captureWin.close(); } catch {}
      }, 300);
    }
  } catch {}
}

/* ---------------- 插件自身设置（v0.4.7：自动接管等） ---------------- */
let pluginSettings = null;

function getPluginSettingsPath() {
  return path.join(getStorageRoot(), "settings.json");
}

function loadPluginSettings() {
  if (pluginSettings) return pluginSettings;
  try { pluginSettings = JSON.parse(fs.readFileSync(getPluginSettingsPath(), "utf8")) || {}; }
  catch { pluginSettings = {}; }
  if (typeof pluginSettings.autoTakeoverCall !== "boolean") pluginSettings.autoTakeoverCall = true;
  return pluginSettings;
}

function savePluginSettings(partial) {
  const cur = loadPluginSettings();
  if (typeof partial.autoTakeoverCall === "boolean") cur.autoTakeoverCall = partial.autoTakeoverCall;
  fs.mkdirSync(path.dirname(getPluginSettingsPath()), { recursive: true });
  fs.writeFileSync(getPluginSettingsPath(), JSON.stringify(cur, null, 2), "utf8");
  return { ...cur };
}

/* 内置引擎状态（v0.4.6 起引擎跑在独立子进程，见 asr-worker.cjs 头注释） */
let embedded = {
  worker: null,        // 子进程句柄（null = 未启动/已退出）
  booted: false,       // 子进程是否完成模型加载（收到 ready）
  readyPromise: null,  // getEmbeddedWorker() 的在途 Promise
  reqSeq: 0,           // 识别请求序号
  pending: new Map(),  // id → { resolve, reject, timer }
  crashes: 0,          // 60s 窗口内连续崩溃次数（成功识别一次清零）
  lastCrashAt: 0,
  loadError: "",       // 加载失败 / 熔断信息
  shuttingDown: false, // unregister 中，退出不再自动重启
};

/* 引擎安装任务状态（供 UI 查询进度） */
let install = {
  running: false,
  phase: "",            // "download" | "extract" | "done" | "error"
  fileLabel: "",
  received: 0,
  total: 0,
  error: "",
  cancelled: false,
};
let installAbort = null; // AbortController：取消安装/插件卸载时立即中断下载连接

/* VAD 状态 */
let vadState = "idle"; // idle | speaking | trailing
let chunks = [];       // Float32Array[]
let chunkTotal = 0;
let speakStart = 0;
let lastVoiceAt = 0;

let stats = { committed: 0, recognized: 0, errors: 0 };
let lastText = "";
let lastError = "";

/* ================= v0.4.0 唤醒词门控（小爱模式） =================
 * 音乐播放时麦克风会收到扬声器声音（歌词/伴奏），VAD 会不停触发。
 * 门控策略：开启后，只有含「唤醒词」的语句或音乐快捷指令才会提交给昔涟，
 * 其余（歌词、环境杂音）静默丢弃 —— 类似小爱同学的唤醒词机制（文本层实现）。
 * 模式：off=关闭 | music=仅音乐播放时启用（推荐） | always=总是需要唤醒词
 */
let wakeGate = "off"; // "off" | "music" | "always"
let wakeWords = ["昔涟", "小昔"]; // 命中任一即唤醒
let musicPlaying = false; // 由面板轮询宿主 music:get-status 上报
let musicStatusSupported = null; // null=未探测 true/false=宿主是否支持音乐状态通道
let gatedCount = 0; // 已拦截语句数

/** 无需唤醒词直通的音乐快捷指令 */
const MUSIC_CMD_RE =
  /^(暂停|继续|继续放|放下去|下一首|上一首|切歌|换一首|换歌|停止播放|别放了?|停止音乐|暂停音乐|关掉音乐|声音?(大|小)一点?|音量(大|小|高|低)一点?|(增大|减小|调(大|小))音量.*)/;

/**
 * 门控判断：返回 {pass, text, woken}。
 * - pass=false → 丢弃（歌词/杂音/无关语句）
 * - woken=true → 唤醒词命中，text 已去掉唤醒词前缀再提交
 */
function gateUtterance(raw) {
  if (wakeGate === "off") return { pass: true, text: raw, woken: false };
  if (wakeGate === "music" && !musicPlaying) return { pass: true, text: raw, woken: false };
  const t = (raw || "").trim();
  if (!t) return { pass: true, text: t, woken: false };
  for (const w of wakeWords) {
    if (!w) continue;
    const i = t.indexOf(w);
    if (i !== -1) {
      const rest = (t.slice(0, i) + t.slice(i + w.length))
        .replace(/^[，。、,.\s!！?？～~]+/, "")
        .replace(/[，。、,.\s!！?？～~]+$/, "")
        .trim();
      return { pass: true, text: rest || w, woken: true };
    }
  }
  if (MUSIC_CMD_RE.test(t)) return { pass: true, text: t, woken: false };
  return { pass: false };
}

/* ================= 工具函数 ================= */

function isHostError(e) {
  return e instanceof Error && typeof e.code === "string" && e.code.startsWith("E_");
}

function pushUi(event, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(`plugin:${PLUGIN_ID}:ui`, { event, payload });
  }
}

function logToUi(text) {
  if (ctxRef) ctxRef.log(text);
  pushUi("log", { text, at: Date.now() });
}

function stateSnapshot() {
  return {
    recording,
    target: leaseTarget,
    holdingLease: !!lease,
    waitingTurn,
    vadState,
    stats,
    lastText,
    lastError,
    wakeGate,
    wakeWords,
    musicPlaying,
    musicStatusSupported,
    gatedCount,
  };
}

/** 带超时的 fetch（兼容无 AbortSignal.timeout 的环境） */
function fetchTimeout(url, ms, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const merged = { ...(init || {}), signal: ctl.signal };
  if (ctxRef && ctxRef.signal && ctxRef.signal.aborted) {
    clearTimeout(timer);
    return Promise.reject(new Error("aborted"));
  }
  return fetch(url, merged).finally(() => clearTimeout(timer));
}

/** 插件私有数据目录（引擎与模型安装位置） */
function getStorageRoot() {
  try {
    const r = ctxRef.storage.rootDir();
    if (r && typeof r === "string") return r;
  } catch { /* 老版本宿主无 rootDir */ }
  return path.join(app.getPath("userData"), "plugin-data", PLUGIN_ID);
}

function getEngineRoot() {
  return path.join(getStorageRoot(), "engine");
}

/* ================= 环境体检 / 修复（v0.2.0） ================= */

function getSettingsPath() {
  return path.join(app.getPath("userData"), "app-settings.json");
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(getSettingsPath(), "utf8"));
  } catch {
    return null;
  }
}

/** 探活 ASR 外置服务：down(没起) / loading(模型加载中) / ready */
async function probeAsr() {
  try {
    const r = await fetchTimeout(`${ASR_BASE}/api/status`, 2500);
    if (r.status === 503) return { state: "loading", detail: "模型加载中（首次约 15 秒）" };
    if (r.ok) {
      try {
        const j = await r.json();
        return { state: "ready", detail: j.device ? `GPU ${j.device}` : "就绪" };
      } catch {
        return { state: "ready", detail: "就绪" };
      }
    }
    return { state: "error", detail: `HTTP ${r.status}` };
  } catch {
    return { state: "down", detail: "未启动" };
  }
}

/** 探活 TTS 服务：发空 JSON，400="no text" 表示 handler 正常工作 */
async function probeTts() {
  try {
    const r = await fetchTimeout(`${TTS_BASE}/tts`, 3000, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (r.status === 400) return { state: "ready", detail: "就绪" };
    return { state: "ready", detail: `响应 HTTP ${r.status}` };
  } catch {
    return { state: "down", detail: "未启动" };
  }
}

/**
 * 检查 Cyrene 通话设置。
 * 关键背景（v1.2.1 源码核实）：
 * - asrEngine "local" 是占位枚举，无引擎实现 → startCall 直接失败
 * - "mossland" 的 start() 只检查 ttsMosslandKey 非空，不联网
 * - 本插件接管输入后，mossland 引擎实际不会收到音频 → 当"陪跑"用
 */
function checkSettings() {
  const s = readSettings();
  if (!s) {
    return { ok: false, issues: [{ code: "no-settings-file", fixable: false }] };
  }
  const issues = [];
  if (s.asrEngine !== "mossland") {
    issues.push({
      code: s.asrEngine === "local" ? "asr-engine-local-placeholder" : "asr-engine-wrong",
      current: String(s.asrEngine),
      fixable: true,
    });
  }
  if (!String(s.ttsMosslandKey || "").trim()) {
    issues.push({ code: "mossland-key-empty", fixable: true });
  }
  return {
    ok: issues.length === 0,
    issues,
    ttsEngine: String(s.ttsEngine || "off"),
  };
}

/**
 * 一键修复：直接写 app-settings.json（先备份）。
 * 已知风险：Cyrene 运行中修改设置会在内存缓存合并写回时覆盖本文件的改动，
 * 所以修复后必须尽快重启；插件每次打开都会重检，被覆盖了再点一次即可。
 */
function fixSettings() {
  const p = getSettingsPath();
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    /* 文件不存在/损坏：从空对象开始，只写需要的字段 */
  }
  try {
    if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.local-asr-backup`);
  } catch {
    /* 备份失败不阻断（文件可能不存在） */
  }
  const changed = [];
  if (s.asrEngine !== "mossland") {
    s.asrEngine = "mossland";
    changed.push("asrEngine → mossland（陪跑引擎，实际识别走本插件）");
  }
  if (!String(s.ttsMosslandKey || "").trim()) {
    s.ttsMosslandKey = "local-asr";
    changed.push("ttsMosslandKey ← 占位值（只需非空，不会联网）");
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(s, null, 2), "utf8");
  return { ok: true, changed, needRestart: changed.length > 0 };
}

function getServiceConfig() {
  const stored = ctxRef ? ctxRef.storage.get("serviceConfig") : undefined;
  return {
    asr: (stored && stored.asr && stored.asr.exe) ? stored.asr : DEFAULT_SERVICE_CONFIG.asr,
    tts: (stored && stored.tts && stored.tts.exe) ? stored.tts : DEFAULT_SERVICE_CONFIG.tts,
  };
}

/** 拉起外置服务（detached 常驻，关 Cyrene 不影响） */
function startService(kind) {
  const cfg = getServiceConfig()[kind];
  if (!cfg || !cfg.exe) return { ok: false, error: "未配置启动命令" };
  if (!fs.existsSync(cfg.exe)) {
    return { ok: false, error: `路径不存在: ${cfg.exe}（在下方"服务配置"里修改）` };
  }
  try {
    let child;
    if (/\.(bat|cmd)$/i.test(cfg.exe)) {
      // .bat 不能直接 spawn（Node 安全限制），走 cmd /c
      child = spawn("cmd.exe", ["/c", cfg.exe, ...(cfg.args || [])], {
        cwd: cfg.cwd || undefined,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      child = spawn(cfg.exe, cfg.args || [], {
        cwd: cfg.cwd || undefined,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
    }
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ================= 内置轻量引擎（v0.3.0 核心） ================= */

/** 引擎文件是否齐全（二进制 + 模型 + 词表） */
function engineInstalled() {
  const root = getEngineRoot();
  return fs.existsSync(path.join(root, "sherpa-onnx-win-x64", "sherpa-onnx.node"))
    && fs.existsSync(path.join(root, "models", "model.int8.onnx"))
    && fs.existsSync(path.join(root, "models", "tokens.txt"));
}

/** v0.4.9：引擎加载脚本哈希（安装时记录于 storage；旧安装无记录时现算并补记） */
function engineJsSha() {
  try {
    let h = ctxRef?.storage?.get("engineJsSha256");
    const jsFile = path.join(getEngineRoot(), "sherpa-onnx-node", "sherpa-onnx.js");
    if (!h && fs.existsSync(jsFile)) {
      h = createHash("sha256").update(fs.readFileSync(jsFile)).digest("hex");
      try { ctxRef?.storage?.set("engineJsSha256", h); } catch { /* 补记失败不影响加载 */ }
    }
    return h ? String(h) : "";
  } catch { return ""; }
}

function engineState() {
  if (install.running) {
    return { state: "installing", phase: install.phase, label: install.fileLabel, received: install.received, total: install.total };
  }
  if (embedded.loadError) return { state: "error", detail: embedded.loadError };
  if (embedded.worker) {
    return embedded.booted
      ? { state: "ready", detail: "CPU · paraformer int8" }
      : { state: "installed", detail: "引擎加载中…" };
  }
  if (engineInstalled()) {
    return { state: "installed", detail: "已安装（首次识别时加载，约 1.5 秒）" };
  }
  if (install.cancelled) {
    const kept = partBytes();
    if (kept > 1048576) {
      return { state: "missing", detail: `未安装（上次取消，已保留 ${(kept / 1048576).toFixed(0)}MB 断点，重装时续传）` };
    }
  }
  return { state: "missing", detail: "未安装" };
}

/** 引擎工作进程脚本（随插件分发，与 index.cjs 同目录） */
function workerScriptPath() {
  return path.join(__dirname, "asr-worker.cjs");
}

/** 懒拉起引擎子进程（ELECTRON_RUN_AS_NODE=1 → 纯 Node，进程内无宿主 DLL）
 *  为什么必须进程隔离（v0.4.6）：宿主主进程启动即加载 onnxruntime-node 的
 *  onnxruntime.dll（bge-reranker 等内置 AI 使用），Windows 加载器按模块名去重，
 *  本插件动态 require 的 sherpa-onnx.node 会静态绑到这份不兼容的 DLL 上，
 *  推理瞬间 abort（0xc0000409）并连带宿主闪退。独立进程内只有 sherpa 自己的
 *  引擎文件，天然无冲突；子进程崩溃只损失当次识别，宿主无感。
 *  关于动态加载的说明（供审查）：本插件唯一直接加载引擎的位置在 asr-worker.cjs，
 *  加载对象是本插件自己下载到私有 storage 目录的 sherpa-onnx 引擎（下载源
 *  固定为 registry.npmmirror.com 与 modelscope.cn，URL 见本文件顶部常量
 *  ENGINE_PARTS / MODEL_SOURCES，文件经字节数 + SHA-256 哈希双重校验后才
 *  落盘，哈希值硬编码于源条目、逐文件对应镜像源）。
 *  引擎无法随插件目录分发的原因：宿主限制 zip ≤50MiB，模型 243MB 放不下，
 *  故设计为"首次使用在线下载 → 校验 → 加载"，下载与加载逻辑全部在本文件内
 *  可审计。 */
function getEmbeddedWorker() {
  if (embedded.worker && !embedded.worker.killed && embedded.readyPromise) {
    return embedded.readyPromise;
  }
  if (!engineInstalled()) return Promise.resolve(null);
  embedded.shuttingDown = false;
  embedded.booted = false;
  const child = fork(workerScriptPath(), [], {
    serialization: "advanced", // Float32Array 走 structured clone，不转 base64
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ASR_ENGINE_ROOT: getEngineRoot(), ASR_ENGINE_JS_SHA: engineJsSha() },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  embedded.worker = child;
  embedded.readyPromise = new Promise((resolve) => {
    const fail = (why) => {
      clearTimeout(bootTimer);
      if (embedded.worker === child) {
        embedded.loadError = why;
        embedded.booted = false;
        embedded.worker = null;
        embedded.readyPromise = null;
      }
      try { child.kill(); } catch { /* 已退出 */ }
      logToUi(`内置引擎异常: ${why}`);
      resolve(null);
    };
    const bootTimer = setTimeout(() => fail("引擎加载超时（60s）"), 60000);
    child.on("message", (msg) => {
      if (!msg) return;
      if (msg.ready) {
        clearTimeout(bootTimer);
        embedded.booted = true;
        embedded.loadError = "";
        resolve(child);
      } else if (msg.fatal) {
        fail(`引擎初始化失败: ${msg.fatal}`);
      } else if (typeof msg.id === "number") {
        const p = embedded.pending.get(msg.id);
        if (!p) return;
        embedded.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(String(msg.text || "").trim());
      }
    });
    child.on("exit", () => {
      // 回收在途请求，避免调用方挂到 30s 超时
      for (const [, p] of embedded.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("引擎子进程已退出"));
      }
      embedded.pending.clear();
      if (embedded.worker !== child) return; // 已被新实例顶替
      embedded.worker = null;
      embedded.booted = false;
      embedded.readyPromise = null;
      if (embedded.shuttingDown) return;
      const now = Date.now();
      embedded.crashes = now - embedded.lastCrashAt < 60000 ? embedded.crashes + 1 : 1;
      embedded.lastCrashAt = now;
      if (embedded.crashes >= 3) {
        embedded.loadError = "引擎子进程连续崩溃，已熔断停启（重启 Cyrene 或重新启用插件可复位）";
        logToUi(`[local-asr] ${embedded.loadError}`);
      } else {
        logToUi("[local-asr] 引擎子进程退出，将在下次识别时自动重启");
      }
    });
    if (child.stderr) child.stderr.on("data", () => { /* 消费掉 sherpa 日志，防管道背压 */ });
  });
  return embedded.readyPromise;
}

/** 内置引擎识别：Float32@16kHz → 文本（子进程内 decode，主进程零阻塞零崩溃风险） */
async function transcribeEmbedded(f32) {
  const child = await getEmbeddedWorker();
  if (!child) return "";
  if (embedded.crashes >= 3 && !embedded.worker) return ""; // 熔断态
  const id = ++embedded.reqSeq;
  const text = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      embedded.pending.delete(id);
      reject(new Error("识别超时（30s）"));
    }, 30000);
    embedded.pending.set(id, { resolve, reject, timer });
    child.send({ id, sampleRate: 16000, samples: f32 }, (err) => {
      if (err) {
        embedded.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  });
  embedded.crashes = 0; // 成功识别 → 崩溃计数清零
  return text;
}

/** 统计保留的 .part 断点总量（取消后向用户展示"还剩多少不用重下"） */
function partBytes() {
  try {
    const root = getEngineRoot();
    let sum = 0;
    for (const f of fs.readdirSync(root, { recursive: true })) {
      const s = String(f);
      if (s.endsWith(".part") || s.endsWith(".part.json")) {
        try { sum += fs.statSync(path.join(root, s)).size; } catch { /* 忽略并发删除 */ }
      }
    }
    return sum;
  } catch {
    return 0;
  }
}

/** 流式计算文件 SHA-256（不整读进内存，模型 243MB 也安全） */
function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = fs.createReadStream(p);
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

/**
 * 带断点续传的下载（v0.3.2）：
 * - .part + .part.json（记录来源 URL）→ 同一源中断后从断点续传（HTTP Range）
 * - 跨源不续传（不同源文件内容/大小可能不同，拼接会损坏文件），自动作废重下
 * - 服务器不支持 Range（返回 200）时自动从头下载
 * - 大小校验失败视为损坏，删除重下
 * - SHA-256 校验（v0.4.5）：落盘前对完整 .part 计算哈希，与硬编码值不符即
 *   丢弃并报错（多源场景视为该源失败，自动换下一个源）；
 *   已存在的目标文件也会复验哈希，防止落盘后被替换
 * - signal abort 立即中断连接（.part 保留供下次续传）
 */
async function downloadFile(url, destAbs, expectedSize, expectedSha256, onProgress, signal) {
  const root = getEngineRoot();
  const dest = path.join(root, destAbs);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    const st = fs.statSync(dest);
    if (!expectedSize || st.size === expectedSize) {
      if (!expectedSha256 || (await sha256File(dest)) === expectedSha256) return dest;
      /* 大小对但内容不符（被替换/损坏）：删除重下 */
      logToUi(`已存在文件哈希校验不符，删除重下: ${destAbs}`);
      fs.rmSync(dest, { force: true });
    }
  }
  const part = `${dest}.part`;
  const metaPath = `${part}.json`;

  /* 断点检查：.part 存在且元数据 URL 与本次源一致才续传 */
  let resumeFrom = 0;
  try {
    if (fs.existsSync(part)) {
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch { /* 元数据损坏 */ }
      const st = fs.statSync(part);
      if (meta && meta.url === url && st.size > 0 && (!meta.size || st.size <= meta.size)) {
        resumeFrom = st.size;
      } else {
        fs.rmSync(part, { force: true }); // 来源不同/元数据缺失：作废，从头下
      }
    }
  } catch { /* 断点判断失败不影响下载，从头来 */ }

  let resp = await fetch(url, {
    redirect: "follow",
    headers: resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : undefined,
    signal,
  });
  if (resp.status === 416) {
    /* 上次实际已下完但没来得及 rename：大小 + 哈希都对就直接收工 */
    const st = fs.statSync(part);
    if ((!expectedSize || st.size === expectedSize)
      && (!expectedSha256 || (await sha256File(part)) === expectedSha256)) {
      fs.renameSync(part, dest);
      fs.rmSync(metaPath, { force: true });
      return dest;
    }
    fs.rmSync(part, { force: true });
    fs.rmSync(metaPath, { force: true });
    throw new Error("续传位置无效（416），断点已清理，换源重试");
  }
  if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status}`);
  const resumed = resp.status === 206 && resumeFrom > 0;
  if (!resumed) resumeFrom = 0; // 服务器不支持 Range：从头下（覆盖写）

  let total = 0;
  const contentRange = resp.headers.get("content-range"); // 形如 "bytes N-M/TOTAL"
  if (resumed && contentRange) {
    const m = /\/(\d+)\s*$/.exec(contentRange);
    if (m) total = Number(m[1]);
  }
  if (!total) total = resumeFrom + (Number(resp.headers.get("content-length")) || 0);
  if (!total && expectedSize) total = expectedSize;

  let received = resumeFrom;
  onProgress(received, total); // 立刻上报一次，续传时 UI 直接显示已有进度
  let lastNotify = 0;
  const nodeStream = Readable.fromWeb(resp.body);
  nodeStream.on("data", (chunk) => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastNotify > 250) { // 4Hz 进度上报，避免刷爆 IPC
      lastNotify = now;
      onProgress(received, total);
    }
  });
  if (!resumed) {
    fs.rmSync(metaPath, { force: true });
    fs.writeFileSync(metaPath, JSON.stringify({ url, size: total, ts: Date.now() }));
  }
  const out = fs.createWriteStream(part, resumed ? { flags: "a" } : undefined);
  await streamPipeline(nodeStream, out);
  const st = fs.statSync(part);
  if (expectedSize && st.size !== expectedSize) {
    fs.rmSync(part, { force: true });
    fs.rmSync(metaPath, { force: true });
    throw new Error(`大小不符: ${st.size} ≠ ${expectedSize}`);
  }
  if (expectedSha256) {
    const actual = await sha256File(part);
    if (actual !== expectedSha256) {
      fs.rmSync(part, { force: true });
      fs.rmSync(metaPath, { force: true });
      throw new Error(`SHA-256 校验失败（${actual.slice(0, 12)}… ≠ ${expectedSha256.slice(0, 12)}…），文件已丢弃，请换源重试`);
    }
  }
  fs.renameSync(part, dest);
  fs.rmSync(metaPath, { force: true });
  return dest;
}

/**
 * 极简 tar.gz 解包器（npm tgz 专用子集：USTAR 常规文件，strip 首段 "package/"）。
 * 不引第三方依赖——插件 zip 里带不了 node_modules。
 */
async function extractTarGz(tgzPath, destDir) {
  const gunzipped = zlib.gunzipSync(fs.readFileSync(tgzPath));
  let off = 0;
  let count = 0;
  while (off + 512 <= gunzipped.length) {
    const header = gunzipped.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // 结束标记
    let name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/[\0 ]/g, ""), 8) || 0;
    const type = String.fromCharCode(header[156] || 0x30);
    off += 512;
    const data = gunzipped.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (prefix) name = `${prefix}/${name}`;
    name = name.replace(/^package\//, "");
    if (!name || name === "package" || name === ".") continue;
    if (type === "x" || type === "g" || type === "L" || type === "K") continue; // pax 扩展头
    const segs = name.split("/");
    if (segs.some((sg) => sg === ".." || sg === ".")) continue; // 防路径逃逸
    if (type === "5" || name.endsWith("/")) {
      fs.mkdirSync(path.join(destDir, name), { recursive: true });
      continue;
    }
    if (type !== "0" && type !== "\0") continue; // 跳过符号链接等
    const target = path.join(destDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    count++;
  }
  return count;
}

/** 安装轻量引擎：下载二进制(tgz×2) + 模型 + 词表并解包（支持断点续传） */
async function installEmbeddedEngine() {
  if (install.running) return { ok: false, error: "安装已在进行中" };
  install = { running: true, phase: "download", fileLabel: "", received: 0, total: 0, error: "", cancelled: false };
  installAbort = new AbortController();
  const signal = installAbort.signal;
  pushUi("install-state", engineState());
  const root = getEngineRoot();
  logToUi("开始安装轻量引擎（约 250MB，国内源，SHA-256 校验，支持断点续传）…");
  try {
    // 1) npm 二进制包 ×2（小，快）
    for (const part of ENGINE_PARTS) {
      if (install.cancelled) throw new Error("已取消");
      install.fileLabel = part.label;
      install.received = 0;
      install.total = part.size;
      const tgzPath = path.join(root, `${part.id}.tgz`);
      await downloadFile(part.url, `${part.id}.tgz`, part.size, part.sha256, (r, t) => {
        install.received = r; install.total = t || part.size;
      }, signal);
      install.phase = "extract";
      install.fileLabel = `${part.label}（解包）`;
      pushUi("install-state", engineState());
      const dest = path.join(root, part.dest);
      fs.mkdirSync(dest, { recursive: true });
      const n = await extractTarGz(tgzPath, dest);
      if (part.id === "addon-main") {
        /* v0.4.9：tgz 下载时已验哈希，这里再记录解包后引擎加载脚本的
           SHA-256（存宿主 storage），fork 时下发给 worker 做加载前复验，
           防安装后被替换 */
        try {
          const jsSha = createHash("sha256").update(fs.readFileSync(path.join(dest, "sherpa-onnx.js"))).digest("hex");
          try { ctxRef?.storage?.set("engineJsSha256", jsSha); } catch { /* storage 不可用时跳过 */ }
        } catch { /* 记录失败不阻塞安装 */ }
      }
      logToUi(`已解包 ${part.label}（${n} 个文件）`);
      fs.unlinkSync(tgzPath);
      install.phase = "download";
    }
    // 2) 词表（75KB）
    install.fileLabel = "词表";
    await downloadWithSources(TOKENS_SOURCES, signal);
    // 3) 模型（243MB，多镜像回退，断点续传）
    install.fileLabel = "识别模型";
    await downloadWithSources(MODEL_SOURCES, signal);
    install.phase = "done";
    install.running = false;
    install.cancelled = false;
    logToUi("轻量引擎安装完成。现在可以直接语音通话（无需外置服务）");
    pushUi("install-state", engineState());
    return { ok: true };
  } catch (e) {
    install.running = false;
    const isCancel = install.cancelled || (e && e.name === "AbortError") || String((e && e.message) || e) === "已取消";
    if (isCancel) {
      install.cancelled = true;
      install.error = "";
      install.phase = "";
      const kept = partBytes();
      logToUi(`已取消安装${kept ? `（已下载 ${(kept / 1048576).toFixed(0)}MB 已保留，下次从断点续传）` : ""}`);
      pushUi("install-state", engineState());
      return { ok: false, cancelled: true };
    }
    install.phase = "error";
    install.error = String((e && e.message) || e);
    logToUi(`引擎安装失败: ${install.error}`);
    pushUi("install-state", engineState());
    return { ok: false, error: install.error };
  } finally {
    installAbort = null;
  }
}

async function downloadWithSources(sources, signal) {
  let lastErr = null;
  for (const src of sources) {
    if (install.cancelled) throw new Error("已取消");
    try {
      install.received = 0;
      install.total = src.size;
      pushUi("install-state", engineState());
      await downloadFile(src.url, src.dest, src.size, src.sha256, (r, t) => {
        install.received = r; install.total = t || src.size;
      }, signal);
      logToUi(`已下载 ${src.label}`);
      return;
    } catch (e) {
      if (install.cancelled || (e && e.name === "AbortError") || String((e && e.message) || e) === "已取消") throw e;
      lastErr = e;
      logToUi(`${src.label} 从 ${new URL(src.url).host} 下载失败，尝试下一个源…`);
    }
  }
  throw lastErr || new Error("全部下载源失败");
}

/** 全量体检（供 UI 与自启/自装逻辑调用） */
async function runDiagnostics() {
  // 任一探针失败不能让整个 diagnose 挂掉 → 各起各的 try/catch
  let asr, tts;
  try { asr = await probeAsr(); } catch (e) {
    asr = { state: "error", detail: "探针异常: " + (e && e.message || e) };
  }
  try { tts = await probeTts(); } catch (e) {
    tts = { state: "error", detail: "探针异常: " + (e && e.message || e) };
  }
  let settings;
  try { settings = checkSettings(); } catch (e) {
    settings = { ok: false, issues: [{ code: "exception", fixable: false }] };
  }
  const cfg = getServiceConfig();
  return {
    asr,
    tts,
    settings,
    engine: engineState(),
    config: {
      asr: { exe: (cfg && cfg.asr && cfg.asr.exe) || "-" },
      tts: { exe: (cfg && cfg.tts && cfg.tts.exe) || "-" },
    },
  };
}

/** 自动启动外置服务：体检发现有服务没起且配置有效时自动拉起（每次 open 只试一轮） */
async function autoStartMissingServices(diag) {
  if (autoStartTried) return;
  autoStartTried = true;
  if (diag.asr.state === "down") {
    const r = startService("asr");
    if (r.ok) logToUi("检测到 ASR 服务未启动，已自动拉起（模型加载约 15 秒）");
  }
  if (diag.tts.state === "down") {
    const r = startService("tts");
    if (r.ok) logToUi("检测到 TTS 服务未启动，已自动拉起");
  }
}

/** 启用时环境探测（v0.4.5：不再自动下载）：
 *  只做探测 + 提示，250MB 下载必须由用户在面板点「安装」按钮显式确认后才开始。
 *  （v0.3.0~v0.4.4 是 fire-and-forget 自动下载，审核认为"启用≠同意下载 250MB"） */
async function suggestInstallIfNeeded() {
  if (installHintTried) return;
  installHintTried = true;
  try {
    if (engineInstalled()) return;
    const asr = await probeAsr();
    if (asr.state === "down") {
      logToUi("未检测到 ASR 环境：打开本插件面板，点「安装 (约250MB)」按钮下载内置引擎（国内源 · SHA-256 校验 · 断点续传）");
      pushUi("state", stateSnapshot());
    }
  } catch {
    /* 静默：用户打开面板时能看到状态与手动安装按钮 */
  }
}

/* ================= 音频处理（识别路径升级为双引擎） ================= */

function feedPcm(f32) {
  if (!recording || waitingTurn) return;
  const now = Date.now();

  // 分块 RMS
  let sum = 0;
  for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
  const rms = Math.sqrt(sum / f32.length);

  if (rms > VAD_RMS) {
    if (vadState === "idle") {
      vadState = "speaking";
      speakStart = now;
      chunks = [];
      chunkTotal = 0;
      pushUi("vad", { state: "speaking" });
    }
    lastVoiceAt = now;
  }

  if (vadState !== "idle") {
    chunks.push(f32);
    chunkTotal += f32.length;
  }

  if (vadState === "speaking") {
    const speechMs = now - speakStart;
    if (rms <= VAD_RMS && now - lastVoiceAt >= SILENCE_MS) {
      // 静音达阈值 → 句尾
      if (speechMs >= MIN_SPEECH_MS) {
        finishUtterance();
      } else {
        resetVad(); // 太短，当噪音丢弃
      }
    } else if (speechMs > MAX_SPEECH_MS) {
      finishUtterance(); // 超长强制切
    }
  }
}

function resetVad() {
  vadState = "idle";
  chunks = [];
  chunkTotal = 0;
  pushUi("vad", { state: "idle" });
}

async function finishUtterance() {
  const total = new Float32Array(chunkTotal);
  let off = 0;
  for (const c of chunks) { total.set(c, off); off += c.length; }
  resetVad();
  if (!lease) return;

  const durSec = (total.length / 16000).toFixed(1);
  logToUi(`识别中… (${durSec}s 音频)`);
  try {
    const text = await transcribeAny(total);
    stats.recognized++;
    const trimmed = (text || "").trim();
    if (trimmed) {
      // v0.4.0：唤醒词门控（音乐播放时过滤歌词/杂音）
      const g = gateUtterance(trimmed);
      if (!g.pass) {
        gatedCount++;
        logToUi(`（门控拦截：“${trimmed.slice(0, 24)}${trimmed.length > 24 ? "…" : ""}”，未含唤醒词）`);
        pushUi("state", stateSnapshot());
        return;
      }
      const finalText = (g.text || "").trim();
      if (!finalText) return;
      await lease.commit(finalText);
      stats.committed++;
      lastText = finalText;
      logToUi(`已提交: “${finalText}”${g.woken ? "（唤醒词命中）" : ""}`);
      // commit 后等待昔联回复：暂停采集，turn:finished 恢复
      waitingTurn = true;
      pushUi("state", stateSnapshot());
      if (resumeGuard) clearTimeout(resumeGuard);
      resumeGuard = setTimeout(() => {
        if (waitingTurn) {
          waitingTurn = false;
          logToUi("(保底恢复采集)");
          pushUi("state", stateSnapshot());
        }
      }, RESUME_GUARD_MS);
    } else {
      logToUi("识别结果为空，跳过");
    }
  } catch (e) {
    stats.errors++;
    lastError = String((e && e.message) || e);
    logToUi(`失败: ${lastError}`);
    if (isHostError(e) && (e.code === "E_NOT_FOUND" || e.code === "E_SPEECH_INPUT_BUSY")) {
      // 通话已结束等不可恢复 → 整体停止
      stopSession().catch(() => undefined);
    }
  }
}

/**
 * 双引擎识别（v0.3.0）：
 * 1. 外置 FunASR(8328) 在线 → 走 GPU（已验证过的路径）
 * 2. 内置引擎已安装 → 走 CPU（decodeAsync 非阻塞）
 * 3. 都没有 → 报错引导安装
 */
async function transcribeAny(f32) {
  // 1) 外置服务（快路径）
  let externalUp = false;
  try {
    const probe = await fetchTimeout(`${ASR_BASE}/api/status`, 1200);
    externalUp = probe.ok || probe.status === 503;
  } catch { /* down */ }
  if (externalUp) {
    try {
      return await transcribeExternal(pcmToWav(f32));
    } catch (e) {
      logToUi(`外置服务识别失败: ${e}，转内置引擎…`);
    }
  }
  // 2) 内置引擎
  if (engineInstalled()) {
    const t0 = Date.now();
    const text = await transcribeEmbedded(f32);
    if (text) logToUi(`内置引擎 ${Date.now() - t0}ms`);
    return text;
  }
  // 3) 无可用引擎
  throw new Error("无可用识别引擎：外置服务未启动且内置引擎未安装（打开插件面板可一键安装）");
}

/** Float32 @16kHz 单声道 → WAV Buffer */
function pcmToWav(f32) {
  const n = f32.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);  // PCM
  buf.writeUInt16LE(1, 22);  // mono
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    buf.writeInt16LE((s < 0 ? s * 0x8000 : s * 0x7fff) | 0, 44 + i * 2);
  }
  return buf;
}

/** POST 到本地 FunASR 服务，返回识别文本 */
async function transcribeExternal(wavBuf) {
  const form = new FormData();
  form.append("file", new Blob([wavBuf]), "utt.wav");
  form.append("model", ASR_MODEL);
  const resp = await fetch(`${ASR_BASE}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
    signal: (ctxRef && ctxRef.signal) || undefined,
  });
  if (!resp.ok) {
    throw new Error(`ASR 服务 ${resp.status}`);
  }
  const data = await resp.json();
  return data.text || "";
}

/* ================= 会话控制 ================= */

async function startSession(target, opts) {
  // opts.probe=true：自动接管的周期探测调用。
  // 语义差异：E_NO_ACTIVE_INPUT_TARGET（没通话）等"环境未就绪"错误静默返回，
  // 不写日志不设 lastError——探测循环每 1.5s 一次，正常状态下绝大多数都是这种结果。
  const probe = !!(opts && opts.probe);
  if (recording) return { ok: false, error: "已在采集中", quiet: true };
  if (!ctxRef || !ctxRef.deps.speechInput) {
    if (probe) return { ok: false, quiet: true };
    return { ok: false, error: "speech-input 服务不可用（检查插件启用状态）" };
  }
  // 引擎可用性预检：双引擎都没有时提前告知，而不是说完一句才失败
  // （probe 模式跳过：探测高频调用不值得每次探活；引擎未就绪时 acquire 后
  //   识别路径有自己的错误处理与日志）
  if (!probe) {
    try {
      const p = await fetchTimeout(`${ASR_BASE}/api/status`, 1200).catch(() => null);
      const externalOk = p && (p.ok || p.status === 503);
      if (!externalOk && !engineInstalled()) {
        return { ok: false, error: "无可用识别引擎（外置服务未启动、内置引擎未安装）。请先打开插件面板安装轻量引擎或启动外置服务" };
      }
    } catch { /* 预检失败不阻断，让后续路径自己报 */ }
  }
  try {
    const l = await ctxRef.deps.speechInput.acquire({ target });
    lease = l;
    leaseTarget = target;
    recording = true;
    waitingTurn = false;
    resetVad();

    // 租约被宿主中止（通话结束/页面重载/插件停止）：立即停采集
    l.signal.addEventListener("abort", () => {
      logToUi("租约被宿主中止，停止采集");
      void hardStop();
    }, { once: true });

    logToUi(`已接管 ${target === "active-call" ? "通话" : "聊天"}输入，开始采集`);
    pushUi("state", stateSnapshot());
    return { ok: true };
  } catch (e) {
    const code = isHostError(e) ? e.code : "";
    // probe 模式下这些错误码都是"环境未就绪"，属探测常态，静默
    if (probe && (code === "E_NO_ACTIVE_INPUT_TARGET" || code === "E_SPEECH_INPUT_BUSY")) {
      return { ok: false, quiet: true };
    }
    lastError = isHostError(e)
      ? `${e.code}: ${e.message}`
      : String((e && e.message) || e);
    logToUi(`获取租约失败: ${lastError}`);
    if (code === "E_NO_ACTIVE_INPUT_TARGET") {
      lastError += target === "active-call"
        ? "（没有进行中的通话——请先开始语音通话）"
        : "（没有打开的聊天窗口）";
    }
    return { ok: false, error: lastError };
  }
}

async function stopSession() {
  recording = false;
  waitingTurn = false;
  if (resumeGuard) { clearTimeout(resumeGuard); resumeGuard = null; }
  resetVad();
  notifyCaptureStop();
  const l = lease;
  lease = null;
  leaseTarget = "";
  if (l) await l.release().catch(() => undefined);
  logToUi("已停止，输入权归还宿主");
  pushUi("state", stateSnapshot());
  return { ok: true };
}

/** 租约 abort 路径：只清状态，不再 release（已中止） */
async function hardStop() {
  recording = false;
  waitingTurn = false;
  if (resumeGuard) { clearTimeout(resumeGuard); resumeGuard = null; }
  resetVad();
  notifyCaptureStop();
  lease = null;
  leaseTarget = "";
  pushUi("state", stateSnapshot());
}

/* ================= 插件入口 ================= */

module.exports = {
  async register(ctx) {
    ctxRef = ctx;

    /* 工具：让昔涟能查询/停止 */
    ctx.registerTool({
      id: "local-asr_status",
      name: "本地识别状态",
      description: "查看本地语音识别插件状态：是否采集中、租约目标、引擎类型、提交计数、唤醒门控、最近识别文本与错误。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      execute() {
        const s = stateSnapshot();
        const eng = engineState();
        return [
          `采集中: ${s.recording ? "是" : "否"}`,
          `租约目标: ${s.target || "无"}`,
          `内置引擎: ${eng.state}${eng.detail ? `（${eng.detail}）` : ""}`,
          `等待回复中: ${s.waitingTurn ? "是" : "否"}`,
          `已提交 ${s.stats.committed} 句 / 识别 ${s.stats.recognized} 次 / 失败 ${s.stats.errors} 次`,
          `唤醒门控: ${s.wakeGate === "off" ? "关闭" : s.wakeGate === "music" ? `仅音乐播放时（当前${s.musicPlaying ? "播放中，已激活" : "未播放"}）` : "总是"} / 唤醒词: ${s.wakeWords.join("/")} / 已拦截 ${s.gatedCount} 句`,
          s.lastText ? `最近文本: ${s.lastText}` : "",
          s.lastError ? `最近错误: ${s.lastError}` : "",
        ].filter(Boolean).join("\n");
      },
    });
    ctx.registerTool({
      id: "local-asr_stop",
      name: "停止本地识别",
      description: "停止本地语音识别采集并释放语音输入租约，把输入权还给 Cyrene 内置输入。",
      enabled: true,
      risk: "input-control",
      effectKind: "mutation",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        await stopSession();
        return "已停止本地识别，输入权归还内置输入。";
      },
    });

    /* IPC：采集窗口 ↔ 主进程（v0.1.0 原有） */
    ctx.registerIpc("start", (target) =>
      startSession(target === "active-chat" ? "active-chat" : "active-call"));
    ctx.registerIpc("stop", () => stopSession());
    ctx.registerIpc("pcm-chunk", (arr) => {
      // renderer 推来的 Float32Array（structured clone 后仍是 Float32Array）
      if (arr instanceof Float32Array) feedPcm(arr);
      else if (arr && arr.buffer instanceof ArrayBuffer) feedPcm(new Float32Array(arr.buffer));
      return true;
    });
    ctx.registerIpc("get-state", () => stateSnapshot());
    /* v0.4.7：自动接管开关 */
    ctx.registerIpc("get-auto-settings", () => {
      const s = loadPluginSettings();
      return { ok: true, autoTakeoverCall: s.autoTakeoverCall };
    });
    ctx.registerIpc("set-auto-settings", (_e, partial) => {
      try {
        const s = savePluginSettings(partial || {});
        return { ok: true, autoTakeoverCall: s.autoTakeoverCall };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    });

    /* ---------- v0.4.0 唤醒词门控 ---------- */

    // 恢复已保存的门控设置
    try {
      if (!ctx.storage) throw new Error("宿主未注入 storage");
      try { logToUi(`storage rootDir: ${ctx.storage.rootDir ? ctx.storage.rootDir() : "(无rootDir)"}`); } catch {}
      const savedGate = ctx.storage.get("wakeGate");
      if (savedGate === "music" || savedGate === "always" || savedGate === "off") {
        wakeGate = savedGate;
        logToUi(`✓ 从 storage 读取 wakeGate=${wakeGate}`);
      } else {
        logToUi(`○ storage 无 wakeGate（首次使用，保持默认 ${wakeGate}）`);
      }
      const savedWords = ctx.storage.get("wakeWords");
      if (Array.isArray(savedWords) && savedWords.length) {
        wakeWords = savedWords.map(String).filter(Boolean);
        logToUi(`✓ 从 storage 读取 wakeWords=${wakeWords.join("/")}`);
      } else {
        logToUi(`○ storage 无 wakeWords（首次使用，保持默认 ${wakeWords.join("/")}）`);
      }
    } catch (e) {
      logToUi(`⚠ 读取保存的唤醒设置失败：${e.message || e}`, true);
    }

    ctx.registerIpc("set-wake", (_e, cfg) => {
      logToUi(`[set-wake] 收到: mode=${cfg && cfg.mode} words="${cfg && cfg.words}"`);
      const mode = cfg && cfg.mode;
      if (mode === "off" || mode === "music" || mode === "always") wakeGate = mode;
      if (cfg && typeof cfg.words === "string") {
        const ws = cfg.words.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
        if (ws.length) wakeWords = ws.slice(0, 6);
      }
      // 同步 storage.set 会抛错 → 用 try/catch 把失败显式打到 UI
      let result = { ok: false, error: "unknown", wakeGate, wakeWords };
      try {
        if (!ctxRef) throw new Error("ctxRef 为空，宿主尚未注入 ctx");
        if (!ctxRef.storage) throw new Error("ctxRef.storage 未注入");
        const rootDir = ctxRef.storage.rootDir ? ctxRef.storage.rootDir() : "(no rootDir)";
        logToUi(`[set-wake] 写入: rootDir=${rootDir} gate=${wakeGate} words=${JSON.stringify(wakeWords)}`);
        ctxRef.storage.set("wakeGate", wakeGate);
        ctxRef.storage.set("wakeWords", wakeWords);
        // 立即回读验证文件确实落盘
        const fs = require("node:fs");
        const path = require("node:path");
        const gateFile = path.join(rootDir, "wakeGate.json");
        const wordsFile = path.join(rootDir, "wakeWords.json");
        const gateExists = fs.existsSync(gateFile);
        const wordsExists = fs.existsSync(wordsFile);
        const gateSize = gateExists ? fs.statSync(gateFile).size : 0;
        const wordsSize = wordsExists ? fs.statSync(wordsFile).size : 0;
        logToUi(`[set-wake] 验证: gateFile=${gateExists}(${gateSize}B) wordsFile=${wordsExists}(${wordsSize}B)`);
        if (!gateExists || !wordsExists) {
          throw new Error(`set() 返回成功但磁盘无文件: gate=${gateExists} words=${wordsExists}`);
        }
        logToUi(`✓ 唤醒门控已写入 storage (${rootDir})`);
        result = { ok: true, rootDir, gateFile: gateFile, wordsFile: wordsFile, wakeGate, wakeWords };
      } catch (e) {
        logToUi(`⚠ 唤醒设置保存失败：${e.message || e}`, true);
        result = { ok: false, error: String(e.message || e) };
      }
      logToUi(`唤醒门控：${
        wakeGate === "off" ? "关闭" : wakeGate === "music" ? "仅音乐播放时" : "总是"
      }（唤醒词：${wakeWords.join("/")}）`);
      pushUi("state", stateSnapshot());
      return result;
    });

    ctx.registerIpc("music-status", (_e, payload) => {
      if (payload && typeof payload === "object") {
        if (payload.supported !== undefined) musicStatusSupported = !!payload.supported;
        const wasPlaying = musicPlaying;
        musicPlaying = !!payload.playing;
        if (wasPlaying !== musicPlaying) {
          logToUi(musicPlaying ? "🎵 检测到音乐开始播放" + (wakeGate === "music" ? "（门控已激活）" : "") : "🎵 音乐已停止" + (wakeGate === "music" ? "（门控解除）" : ""));
          pushUi("state", stateSnapshot());
        }
      }
      return { ok: true };
    });

    /* IPC：环境体检 / 修复 / 服务管理（v0.2.0） */
    ctx.registerIpc("diagnose", async () => {
      const diag = await runDiagnostics();
      await autoStartMissingServices(diag);
      return diag;
    });
    ctx.registerIpc("fix-settings", () => {
      const r = fixSettings();
      if (r.needRestart) logToUi("已写入通话设置，需要重启 Cyrene 生效");
      return r;
    });
    ctx.registerIpc("start-service", (kind) => {
      const r = startService(kind === "tts" ? "tts" : "asr");
      logToUi(r.ok ? `已发出 ${kind} 启动命令` : `${kind} 启动失败: ${r.error}`);
      return r;
    });
    ctx.registerIpc("pick-service-exe", async (kind) => {
      const k = kind === "tts" ? "tts" : "asr";
      const result = await dialog.showOpenDialog({
        title: `选择 ${k === "asr" ? "ASR" : "TTS"} 服务${k === "asr" ? "（推荐选 start_asr_silent.bat）" : "的 pythonw.exe"}`,
        properties: ["openFile"],
        filters: [{ name: "可执行文件", extensions: ["exe", "bat", "cmd"] }],
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
      const cfg = getServiceConfig();
      const old = cfg[k];
      const oldArgsDir = old && old.args && old.args[0]
        ? path.dirname(old.args[0])
        : (old && old.cwd) || "";
      cfg[k] = {
        exe: result.filePaths[0],
        args: [],
        cwd: fs.existsSync(oldArgsDir) ? oldArgsDir : path.dirname(result.filePaths[0]),
      };
      ctxRef.storage.set("serviceConfig", cfg);
      logToUi(`已更新 ${k} 启动命令: ${cfg[k].exe}`);
      return { ok: true, config: cfg[k] };
    });

    /* IPC：内置引擎安装（v0.3.0） */
    ctx.registerIpc("install-engine", () => installEmbeddedEngine());
    ctx.registerIpc("get-engine-state", () => engineState());
    ctx.registerIpc("cancel-install", () => {
      if (install.running) {
        install.cancelled = true;
        try { installAbort?.abort(); } catch { /* 已停止 */ }
        logToUi("已取消安装（连接立即中断，已下载部分保留，下次续传）");
      }
      return { ok: true };
    });

    /* turn 事件：等昔联回复期间不采集（防录进 TTS） */
    unsubscribeTurnStarted = ctx.events.on("host:turn:started", () => {
      if (recording && !waitingTurn && lease) {
        // 只有本插件 commit 触发的轮次才需要等；粗暴一点：说话中间不打断，
        // 仅在 VAD idle 时进入等待，避免把用户正在说的话切掉
        if (vadState === "idle") {
          waitingTurn = true;
          pushUi("state", stateSnapshot());
        }
      }
    });
    unsubscribeTurnFinished = ctx.events.on("host:turn:finished", () => {
      if (waitingTurn) {
        waitingTurn = false;
        if (resumeGuard) { clearTimeout(resumeGuard); resumeGuard = null; }
        pushUi("state", stateSnapshot());
      }
    });

    /* v0.4.9：自动接管通话 —— 纯 SDK 探测式，零内部模块依赖
     * 原理：周期性尝试 acquire({target:"active-call"})；
     * E_NO_ACTIVE_INPUT_TARGET（官方契约错误码）= 没有通话，静默等下轮；
     * acquire 成功 = 通话进行中且租约到手，直接完成接管。
     * 不再 require 宿主 dist 内部模块（call-manager），上游升级改路径/接口均不受影响。 */
    autoTakeoverTimer = setInterval(() => {
      if (!loadPluginSettings().autoTakeoverCall) return;
      if (recording || !ctxRef || !ctxRef.deps.speechInput) return;
      Promise.resolve(startSession("active-call", { probe: true }))
        .then(async (r) => {
          if (!r || !r.ok) return; // 探测失败（无通话/被占用）静默等下轮
          logToUi("检测到通话开始，自动接管输入…");
          try { await ensureCaptureRunning(); } catch (e) { logToUi("开麦失败：" + String((e && e.message) || e)); }
        })
        .catch(() => { /* 静默：下轮再探 */ });
    }, 1500);
    logToUi("通话自动接管已开启（可在面板关闭）");

    /* 停止兜底 */
    ctx.onDispose(async () => {
      install.cancelled = true;
      try { installAbort?.abort(); } catch { /* 已停止 */ }
      if (autoTakeoverTimer) { clearInterval(autoTakeoverTimer); autoTakeoverTimer = null; }
      recording = false;
      if (resumeGuard) { clearTimeout(resumeGuard); resumeGuard = null; }
      const l = lease;
      lease = null;
      await l?.release().catch(() => undefined);
      if (win && !win.isDestroyed()) win.close();
      win = null;
    });

    /* v0.4.5：启用只探测提示，下载需用户在面板显式确认（不阻塞注册） */
    void suggestInstallIfNeeded();
  },

  async open() {
    autoStartTried = false; // 每次开窗允许重新自动拉起一轮
    if (win && !win.isDestroyed()) { win.focus(); return; }
    win = new BrowserWindow({
      width: 520,
      height: 820,
      autoHideMenuBar: true,
      title: "本地语音识别",
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    win.on("closed", () => {
      win = null;
      // 关窗即停采集，不留后台麦克风
      void stopSession().catch(() => undefined);
    });
    await win.loadFile(path.join(__dirname, "ui.html"));
  },

  async unregister() {
    recording = false;
    if (resumeGuard) { clearTimeout(resumeGuard); resumeGuard = null; }
    // v0.4.9 补全清理：自动接管轮询 + 进行中的引擎下载
    if (autoTakeoverTimer) { clearInterval(autoTakeoverTimer); autoTakeoverTimer = null; }
    try { installAbort?.abort(); } catch { /* 已停止 */ }
    if (install.running) install.cancelled = true;
    // 引擎子进程：置 shuttingDown 防止 exit 回调里自动重启，再回收在途请求
    embedded.shuttingDown = true;
    for (const [, p] of embedded.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("插件已停用"));
    }
    embedded.pending.clear();
    try { embedded.worker?.kill(); } catch { /* 已退出 */ }
    embedded.worker = null;
    embedded.booted = false;
    embedded.readyPromise = null;
    const l = lease;
    lease = null;
    await l?.release().catch(() => undefined);
    try { unsubscribeTurnStarted?.(); } catch { /* noop */ }
    try { unsubscribeTurnFinished?.(); } catch { /* noop */ }
    if (win && !win.isDestroyed()) win.close();
    win = null;
    if (captureWin && !captureWin.isDestroyed()) captureWin.close();
    captureWin = null;
    ctxRef = null;
  },
};
