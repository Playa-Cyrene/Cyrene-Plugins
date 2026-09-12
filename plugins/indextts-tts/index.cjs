"use strict";

// IndexTTS 本地语音（indextts-tts）插件入口。
//
// 自包含约束：只 require Node 内置模块与 electron，不 require 任何未打包的 npm 包。
//
// 职责：
//   1) 保存用户配置（模型目录 / Python 路径 / 端口 / 引擎版本 / 是否随插件启动）；
//   2) 插件启用时启动本地 IndexTTS 服务（spawn bundled 的 indextts_server.py），停用时关闭；
//   3) 提供配置窗口（ui.html）与 AI 工具（状态 / 启动 / 停止）。
//
// 服务暴露的是 GPT-SoVITS 兼容的 /tts，因此用户在 Cyrene 里继续选择「GPT-SoVITS」，
// 把 API 地址指向本插件启动的 http://127.0.0.1:<端口> 即可，无需改动 Cyrene 本体。

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");

const SERVER_SCRIPT = path.join(__dirname, "indextts_server.py");
const CONFIG_KEY = "config";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9880;
/** 首次加载模型可能较慢（CPU 上可超过 3 分钟），给足启动窗口。 */
const STARTUP_TIMEOUT_MS = 240000;
const POLL_INTERVAL_MS = 2000;
/** 启动头 10s 用更细的轮询粒度，让「改端口→重新就绪」不必等满 2s。 */
const POLL_INTERVAL_FAST_MS = 250;
const POLL_FAST_WINDOW_MS = 10000;
const HEALTH_TIMEOUT_MS = 3000;
/** 连续崩溃的自动重启上限，达到后停止自动重启（避免持续崩溃循环）。 */
const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 3000;
/** 稳定运行满这么久才认为这一轮启动健康，重置崩溃预算（否则「起来就崩」会无限重启）。 */
const STABLE_RESET_MS = 60000;
/**
 * 每次插件加载生成一次性 nonce，spawn 时传给服务端并由 /health 回显，
 * 用于确认应答来自「我们自己拉起的进程」——端口上已有别的服务时不会误判为就绪。
 */
const HEALTH_NONCE = "cyrene-" + process.pid + "-" + Date.now().toString(36);

// ---------------------------------------------------------------------------
// 下载镜像：**只在官方源失败后启用**（fallback 语义），用户可在「高级选项 → 镜像」里
// 改成自己的地址或清空（清空 = 只用官方）。
//
// GitHub 代理是「前缀式」的：把原始 URL 直接拼在镜像前缀后面。
// 注意仓库 zip 与 uv 二进制下载下来是要执行的，走第三方代理等于信任它不塞私货；
// 这一点在 README 的「网络访问」里如实披露，UI 上也给了提示。
// ---------------------------------------------------------------------------
const DEFAULT_GITHUB_MIRROR_TEXT = "https://gh-proxy.com/, https://ghfast.top/";
const DEFAULT_PYPI_MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple";
/** 上游 network_detection / model_download 自己硬编码的回退点，强制走镜像时显式设置。 */
const HF_MIRROR_ENDPOINT = "https://hf-mirror.com";
/** uv 自己下载 CPython 的地址（GitHub Releases）；镜像前缀拼在它前面。 */
const PYTHON_BUILD_STANDALONE_URL = "https://github.com/astral-sh/python-build-standalone/releases/download";
/** 模型来源：auto = 交给上游探测（不设 USE_MODELSCOPE）。 */
const MODEL_SOURCES = ["auto", "modelscope", "official"];

const DEFAULT_CONFIG = {
  modelDir: "",
  pythonPath: "",
  port: DEFAULT_PORT,
  engineVersion: "v2",
  autoStart: true,
  emotionGuidance: false,
  githubMirror: DEFAULT_GITHUB_MIRROR_TEXT,
  pypiMirror: DEFAULT_PYPI_MIRROR,
  modelSource: "auto",
};

// ---------------------------------------------------------------------------
// 运行时状态（模块级单例；插件同一时刻只有一个实例）
// ---------------------------------------------------------------------------
let ctxRef = null;
let pluginWin = null;
let child = null;
let running = false;
let ready = false;
let activeKey = null;
let restartCount = 0;
let restartTimer = null;
/** 稳定运行计时器：满 STABLE_RESET_MS 才把崩溃预算清零。 */
let stableTimer = null;

function clearStableTimer() {
  if (stableTimer) {
    clearTimeout(stableTimer);
    stableTimer = null;
  }
}

/** 就绪后开始稳定计时；稳定满 STABLE_RESET_MS 才重置崩溃预算。 */
function markStable() {
  clearStableTimer();
  stableTimer = setTimeout(() => {
    stableTimer = null;
    restartCount = 0;
  }, STABLE_RESET_MS);
}

let deliberateStop = false;
/** 用户/宿主主动请求过停止：启动被这样打断时算「已取消」，不计入崩溃预算。 */
let stopRequested = false;
let lastError = null;
/** 服务端最近输出（崩溃 / 启动失败时附在错误里，便于定位）。 */
let serverLog = [];
/** 进行中的启动 Promise：并发/重复调用共享同一次启动，避免重复 spawn。 */
let startPromise = null;

// ---------------------------------------------------------------------------
// 配置读写（走宿主私有存储，卸载重装不丢）
// ---------------------------------------------------------------------------
function normalizeConfig(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const port = Number(c.port);
  return {
    modelDir: typeof c.modelDir === "string" ? c.modelDir.trim() : "",
    pythonPath: typeof c.pythonPath === "string" ? c.pythonPath.trim() : "",
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT,
    engineVersion: c.engineVersion === "v2_5" ? "v2_5" : "v2",
    autoStart: c.autoStart !== false,
    emotionGuidance: c.emotionGuidance === true,
    // 镜像字段的语义：没存过 → 给默认镜像；存过空串 → 保持空（只用官方）。
    githubMirror: typeof c.githubMirror === "string" ? c.githubMirror.trim() : DEFAULT_GITHUB_MIRROR_TEXT,
    pypiMirror: typeof c.pypiMirror === "string" ? c.pypiMirror.trim() : DEFAULT_PYPI_MIRROR,
    modelSource: MODEL_SOURCES.includes(c.modelSource) ? c.modelSource : "auto",
  };
}

function loadConfig() {
  try {
    return withDetectedEngine(normalizeConfig(ctxRef.storage.get(CONFIG_KEY)));
  } catch {
    return Object.assign({}, DEFAULT_CONFIG);
  }
}

function saveConfig(raw) {
  engineCache = { modelDir: null, version: null }; // 配置变更后让 engine 探测缓存失效
  const normalized = withDetectedEngine(normalizeConfig(raw));
  ctxRef.storage.set(CONFIG_KEY, normalized);
  return normalized;
}

/** 「一键配置」里用户选的安装目录：单独持久化，关窗再开不用重选。 */
const INSTALL_DIR_KEY = "installDir";

function loadInstallDir() {
  try {
    return ctxRef.storage.get(INSTALL_DIR_KEY) || "";
  } catch {
    return "";
  }
}

function saveInstallDir(dir) {
  try {
    ctxRef.storage.set(INSTALL_DIR_KEY, dir || "");
  } catch { /* ignore */ }
}

/** 配置指纹：模型目录 / Python 路径 / 端口 / 引擎版本 / 情感引导 / 模型来源任一变化都需要重启服务。 */
function fingerprint(cfg) {
  return JSON.stringify({
    modelDir: cfg.modelDir,
    pythonPath: cfg.pythonPath,
    port: cfg.port,
    engineVersion: cfg.engineVersion,
    emotionGuidance: cfg.emotionGuidance,
    // 模型来源会变成服务进程的 USE_MODELSCOPE 环境变量，改了必须重启才生效；
    // 镜像前缀只用于安装阶段，故意不进指纹（改它不该重启已在跑的服务）。
    modelSource: cfg.modelSource,
  });
}

function baseUrl(cfg) {
  return "http://" + DEFAULT_HOST + ":" + cfg.port;
}

// ---------------------------------------------------------------------------
// 一键配置：从一个 IndexTTS 安装目录自动识别 Python 解释器与模型目录
// ---------------------------------------------------------------------------
/** 在 dir 下递归（最多 depth 层）找含 config.yaml 的目录。 */
function findConfigDir(dir, depth) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  if (entries.some((e) => e.isFile() && e.name === "config.yaml")) return dir;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "__pycache__") continue;
    const found = findConfigDir(path.join(dir, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

/** 从安装目录识别 python 解释器与模型目录（找不到对应字段则留空）。 */
function detectInstallation(base) {
  const result = { pythonPath: "", modelDir: "" };

  const pyCandidates = [
    path.join(base, ".venv", "Scripts", "python.exe"),
    path.join(base, "venv", "Scripts", "python.exe"),
    path.join(base, "env", "Scripts", "python.exe"),
    path.join(base, "Scripts", "python.exe"),
    path.join(base, "python.exe"),
    // POSIX（Linux/macOS）：uv 建的虚拟环境是 .venv/bin/python
    path.join(base, ".venv", "bin", "python"),
    path.join(base, "venv", "bin", "python"),
    path.join(base, "env", "bin", "python"),
  ];
  for (const p of pyCandidates) {
    if (fs.existsSync(p)) {
      result.pythonPath = p;
      break;
    }
  }
  if (!result.pythonPath) {
    // 往下一层找 <base>/<envName>/{Scripts/python.exe | bin/python}
    try {
      for (const name of fs.readdirSync(base)) {
        for (const rel of [["Scripts", "python.exe"], ["bin", "python"]]) {
          const p = path.join(base, name, rel[0], rel[1]);
          if (fs.existsSync(p)) {
            result.pythonPath = p;
            break;
          }
        }
        if (result.pythonPath) break;
      }
    } catch { /* 忽略不可读目录 */ }
  }

  const modelCandidates = [
    path.join(base, "checkpoints"),
    path.join(base, "models", "checkpoints"),
    base,
  ];
  for (const d of modelCandidates) {
    if (fs.existsSync(path.join(d, "config.yaml"))) {
      result.modelDir = d;
      break;
    }
  }
  if (!result.modelDir) {
    result.modelDir = findConfigDir(base, 3) || "";
  }
  result.engineVersion = detectEngineVersion(result.modelDir);

  return result;
}

/** detectEngineVersion 的缓存：窗口每 3s 轮询 getState，避免每次都同步读 config.yaml。 */
let engineCache = { modelDir: null, version: null };

/** 从 <modelDir>/config.yaml 的 version 字段判定引擎版本；判不出返回 null。 */
function detectEngineVersion(modelDir) {
  if (!modelDir) return null;
  if (engineCache.modelDir === modelDir) return engineCache.version;
  let version = null;
  try {
    const cfgPath = path.join(modelDir, "config.yaml");
    if (fs.existsSync(cfgPath)) {
      const text = fs.readFileSync(cfgPath, "utf8");
      const match = text.match(/^\s*version:\s*["']?([0-9.]+)/m);
      if (match) version = match[1].startsWith("2.5") ? "v2_5" : "v2";
    }
  } catch {
    version = null;
  }
  engineCache = { modelDir: modelDir, version: version };
  return version;
}

/** 按模型目录自动校正引擎版本：模型是 2.0 就不能用 2.5 的代码，否则加载即崩。 */
function withDetectedEngine(cfg) {
  const detected = detectEngineVersion(cfg.modelDir);
  if (!detected || detected === cfg.engineVersion) return cfg;
  return Object.assign({}, cfg, { engineVersion: detected });
}

// ---------------------------------------------------------------------------
// 一键安装（从零）：下载 IndexTTS 仓库 → uv → 依赖 → 模型
// ---------------------------------------------------------------------------
/** 仓库 zip 与 uv 官方发布地址（都来自各自项目的 GitHub）。 */
const REPO_ZIP_URL = "https://codeload.github.com/index-tts/index-tts/zip/refs/heads/main";
const UV_RELEASE = "https://github.com/astral-sh/uv/releases/latest/download";

let bootstrapState = { active: false, step: "", message: "", error: null };
/** 引导过程的最近输出行（出错时附在错误里，便于定位）。 */
let bootstrapLog = [];
/** 一键安装期间派生的子进程（uv / python / 解压），插件停止时统一清理，避免孤儿进程。 */
const auxChildren = new Set();

function pushLog(line) {
  bootstrapLog.push(line);
  if (bootstrapLog.length > 80) bootstrapLog.splice(0, bootstrapLog.length - 80);
}

function bootstrapLogTail(n) {
  return bootstrapLog.slice(-n).join("\n");
}

/** 进度推送节流：安装期 uv 输出很密，最多每 200ms 推一次（bootstrapState 本身始终是最新）。 */
let lastProgressAt = 0;

/** 把引导进度推给插件窗口（窗口未打开时静默丢弃）。 */
function sendProgress(step, message) {
  bootstrapState = { active: true, step: step, message: message, error: null };
  if (!pluginWin || pluginWin.isDestroyed()) return;
  const now = Date.now();
  if (now - lastProgressAt < 200) return;
  lastProgressAt = now;
  try {
    pluginWin.webContents.send("plugin:indextts-tts:progress", bootstrapState);
  } catch { /* 窗口正在关闭 */ }
}

function finishProgress(error) {
  bootstrapState = { active: false, step: "", message: "", error: error || null };
  if (pluginWin && !pluginWin.isDestroyed()) {
    try {
      pluginWin.webContents.send("plugin:indextts-tts:progress", bootstrapState);
    } catch { /* ignore */ }
  }
}

/** 下载一个 URL 到本地文件（跟随重定向）。onProgress(gotBytes, totalBytes)。 */
function downloadFile(url, dest, onProgress, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error("已取消"));
      return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    let settled = false;
    let activeReq = null;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      try { activeReq?.destroy(); } catch { /* ignore */ }
      try { file.close(); } catch { /* ignore */ }
      try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onAbort = () => fail(new Error("已取消"));
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(dest);
    };
    const go = (currentUrl, redirects) => {
      if (settled) return;
      if (redirects > 8) return fail(new Error("下载重定向次数过多：" + url));
      const req = https.get(currentUrl, { headers: { "User-Agent": "cyrene-indextts-plugin" } }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return go(new URL(res.headers.location, currentUrl).toString(), redirects + 1);
        }
        if (status !== 200) {
          res.resume();
          return fail(new Error("下载失败 HTTP " + status + "：" + currentUrl));
        }
        const total = Number(res.headers["content-length"] || 0);
        let got = 0;
        res.on("data", (chunk) => {
          got += chunk.length;
          if (onProgress) onProgress(got, total);
        });
        res.on("error", fail);
        res.pipe(file);
        file.on("finish", () => {
          // 校验完整性：有 Content-Length 时字节数必须一致，避免截断的压缩包被当成成功。
          if (total > 0 && got !== total) {
            return fail(new Error("下载不完整：" + got + "/" + total + " 字节（" + currentUrl + "）"));
          }
          file.close(() => done());
        });
        file.on("error", fail);
      });
      activeReq = req;
      req.on("error", fail);
      req.setTimeout(120000, () => req.destroy(new Error("下载超时（120s）：" + currentUrl)));
    };
    go(url, 0);
  });
}

// ---------------------------------------------------------------------------
// 镜像回退（fallback）：先官方，官方失败才依次试镜像前缀
// ---------------------------------------------------------------------------
/** 解析镜像配置文本（逗号 / 分号 / 空白 / 换行分隔）；只接受 http(s) 前缀，非法项直接忽略。 */
function parseMirrors(text) {
  const out = [];
  for (const raw of String(text || "").split(/[\s,;]+/)) {
    const item = raw.trim();
    if (!item) continue;
    if (!/^https?:\/\//i.test(item)) continue; // 不把用户输入当任意协议拼进 URL
    out.push(item.endsWith("/") ? item : item + "/");
  }
  return out;
}

/** 把原始 URL 拼到每个镜像前缀后面；只对 GitHub 域名生效，其它主机不改写。 */
function mirrorUrls(url, mirrors) {
  if (!/^https:\/\/(codeload\.)?github\.com\//i.test(url)) return [];
  return mirrors.map((prefix) => prefix + url);
}

/**
 * 先试官方 URL，失败后依次试镜像；任一成功即返回。
 * onRetry(nextUrl, err) 用来把「正在换镜像」推进安装进度（可选）。
 * 用户取消（signal aborted）不算下载失败，不会再去试镜像。
 */
async function downloadWithMirrors(url, dest, opts) {
  const options = opts || {};
  const attempts = [url].concat(mirrorUrls(url, options.mirrors || []));
  const failures = [];
  for (let i = 0; i < attempts.length; i += 1) {
    if (options.signal && options.signal.aborted) throw new Error("已取消");
    try {
      return await downloadFile(attempts[i], dest, options.onProgress, options.signal);
    } catch (err) {
      if (options.signal && options.signal.aborted) throw err;
      failures.push({ url: attempts[i], error: err && err.message ? err.message : String(err) });
      if (i + 1 < attempts.length && options.onRetry) {
        try { options.onRetry(attempts[i + 1], err); } catch { /* 进度回调出错不影响下载 */ }
      }
    }
  }
  // 只有一个源时保持原样；有多个源就把每个源的错误都列出来，
  // 便于区分「官方被墙」还是「镜像也不通」——用户报障时这行信息最关键。
  if (failures.length === 1) throw new Error(failures[0].error);
  throw new Error(
    "所有下载源都失败（共 " + failures.length + " 个）：\n"
      + failures.map((f) => "  · " + f.url + "\n    " + f.error).join("\n"),
  );
}

/** 在 process.env 之上叠加一组变量（spawn 传 env 会覆盖整个环境，必须自己合并）。 */
function withEnv(extra) {
  return Object.assign({}, process.env, extra || {});
}

/**
 * 模型来源 → 上游认的环境变量。上游 indextts/utils/network_detection.py 里
 * USE_MODELSCOPE=true 会强制走 ModelScope（失败再退 hf-mirror.com），false 强制走官方 HF；
 * auto 什么都不设，让上游按 TCP 探测自己决定。
 */
function modelSourceEnv(source) {
  if (source === "modelscope") return { USE_MODELSCOPE: "true", HF_ENDPOINT: HF_MIRROR_ENDPOINT };
  if (source === "official") return { USE_MODELSCOPE: "false" };
  return {};
}

/** uv sync 失败后重试用的镜像环境变量；没配镜像就返回空对象（不做无意义的重试）。 */
function uvMirrorEnv(cfg) {
  const env = {};
  if (cfg.pypiMirror) {
    // uv 新名 UV_DEFAULT_INDEX，旧名 UV_INDEX_URL：两个都设，兼容用户机器上可能存在的旧 uv。
    env.UV_DEFAULT_INDEX = cfg.pypiMirror;
    env.UV_INDEX_URL = cfg.pypiMirror;
  }
  const githubMirrors = parseMirrors(cfg.githubMirror);
  if (githubMirrors.length) {
    // uv 自己下载的 CPython 来自 GitHub Releases，用镜像前缀顶替。
    env.UV_PYTHON_INSTALL_MIRROR = githubMirrors[0] + PYTHON_BUILD_STANDALONE_URL;
  }
  return env;
}

/** 运行子进程并把输出逐行回调；非 0 退出码时 reject。进程会登记到 auxChildren 以便统一清理。 */
function runStreaming(cmd, args, options, onLine) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args, Object.assign({ windowsHide: true }, options || {}));
    } catch (err) {
      return reject(new Error("无法启动 " + cmd + "：" + err.message));
    }
    auxChildren.add(proc);
    let settled = false;
    const feed = (buf) => {
      for (const line of buf.toString().split(/\r\n|\r|\n/)) {
        const text = line.trim();
        if (text && onLine) onLine(text);
      }
    };
    proc.stdout?.on("data", feed);
    proc.stderr?.on("data", feed);
    proc.on("error", (err) => {
      auxChildren.delete(proc);
      if (settled) return;
      settled = true;
      const cancelled = !!(options && options.signal && options.signal.aborted);
      reject(cancelled ? new Error("已取消") : new Error("无法启动 " + cmd + "：" + err.message));
    });
    proc.on("exit", (code) => {
      auxChildren.delete(proc);
      if (settled) return;
      settled = true;
      if (options && options.signal && options.signal.aborted) reject(new Error("已取消"));
      else if (code === 0) resolve();
      else reject(new Error(cmd + " 退出码 " + code));
    });
  });
}

/** 终止一键安装期间派生的所有子进程（uv / python / 解压等）。 */
function killAuxChildren() {
  for (const proc of auxChildren) {
    try {
      if (process.platform === "win32" && proc.pid) {
        spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
          .on("error", () => { try { proc.kill(); } catch { /* ignore */ } });
      } else {
        proc.kill("SIGTERM");
      }
    } catch { /* ignore */ }
  }
  auxChildren.clear();
}

/** 解压 zip：Windows 用 PowerShell Expand-Archive，其它平台用 unzip。 */
function extractZip(zipPath, destDir, signal) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === "win32") {
    const ps = "Expand-Archive -LiteralPath $env:CYRENE_ZIP -DestinationPath $env:CYRENE_DEST -Force";
    return runStreaming(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      {
        env: Object.assign({}, process.env, { CYRENE_ZIP: zipPath, CYRENE_DEST: destDir }),
        signal: signal,
      },
      null,
    );
  }
  return runStreaming("unzip", ["-o", zipPath, "-d", destDir], { signal: signal }, null);
}

/** 按类型解压（zip / tar.gz）。 */
function extractArchive(archivePath, destDir, kind, signal) {
  fs.mkdirSync(destDir, { recursive: true });
  if (kind === "tar.gz") {
    return runStreaming("tar", ["-xzf", archivePath, "-C", destDir], { signal: signal }, null);
  }
  return extractZip(archivePath, destDir, signal);
}

/** 把 srcDir 的内容复制进 destDir（保留结构）。 */
function copyDirContents(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    fs.cpSync(path.join(srcDir, name), path.join(destDir, name), { recursive: true });
  }
}

/** 在 dir 下递归查找指定文件名，返回完整路径；找不到返回 null。 */
function findFile(dir, name) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    }
  }
  return null;
}

/** 当前平台对应的 uv 发行包；不支持的平台返回 null。 */
function uvAsset() {
  if (process.platform === "win32") {
    return { url: UV_RELEASE + "/uv-x86_64-pc-windows-msvc.zip", exe: "uv.exe", kind: "zip" };
  }
  if (process.platform === "linux") {
    return { url: UV_RELEASE + "/uv-x86_64-unknown-linux-gnu.tar.gz", exe: "uv", kind: "tar.gz" };
  }
  return null;
}

/** 安装后的虚拟环境 Python 路径。 */
function venvPythonPath(installDir) {
  return process.platform === "win32"
    ? path.join(installDir, ".venv", "Scripts", "python.exe")
    : path.join(installDir, ".venv", "bin", "python");
}

/**
 * 从零安装 IndexTTS 到 installDir：
 *   1) 下载仓库 zip 并解压进 installDir
 *   2) 下载 uv（单文件，自带 Python 下载能力，避免要求系统 Python）
 *   3) uv sync：自动下载 Python 3.10/3.11 与 torch 等依赖
 *   4) 用 venv 的 python 把模型下载到 installDir/checkpoints
 * 每步都推进度；失败抛出带步骤名的错误。网络失败时按配置的镜像回退（先官方，失败才走镜像）。
 */
async function bootstrapInstall(installDir, signal) {
  bootstrapLog = [];
  // 镜像与引擎版本只读一次：安装过程中改配置不该影响正在跑的流程。
  const cfg = loadConfig();
  const githubMirrors = parseMirrors(cfg.githubMirror);
  /** 每步之间检查是否已被取消（禁用插件 / 退出 Cyrene 时 ctx.signal 会 abort）。 */
  const ensureLive = () => {
    if (signal && signal.aborted) throw new Error("已取消安装");
  };
  // 平台检查放最前：不支持的平台要立刻返回，不能先把仓库解压写进用户选的目录。
  const asset = uvAsset();
  if (!asset) {
    throw new Error("当前平台（" + process.platform + "）暂不支持自动安装，请手动安装 IndexTTS");
  }
  const cacheDir = path.join(installDir, ".cyrene-bootstrap");
  fs.mkdirSync(cacheDir, { recursive: true });

  // 1) 仓库
  ensureLive();
  sendProgress("repo", "正在从 GitHub 下载 IndexTTS 仓库…");
  const repoZip = path.join(cacheDir, "index-tts.zip");
  await downloadWithMirrors(REPO_ZIP_URL, repoZip, {
    mirrors: githubMirrors,
    signal: signal,
    onProgress: (got, total) => {
      if (!total) return;
      sendProgress(
        "repo",
        "下载 IndexTTS 仓库 " + Math.round((got / total) * 100) + "%（"
          + (got / 1048576).toFixed(0) + "/" + (total / 1048576).toFixed(0) + " MB）",
      );
    },
    onRetry: (next, err) => sendProgress("repo", "官方源下载失败（" + err.message + "），改用镜像重试…"),
  });
  ensureLive();
  sendProgress("repo", "正在解压仓库…");
  const repoExtract = path.join(cacheDir, "repo");
  fs.rmSync(repoExtract, { recursive: true, force: true });
  await extractArchive(repoZip, repoExtract, "zip", signal);
  const tops = fs.readdirSync(repoExtract, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (tops.length !== 1) {
    throw new Error("仓库解压结果异常：未找到唯一的顶层目录");
  }
  copyDirContents(path.join(repoExtract, tops[0].name), installDir);
  fs.rmSync(repoExtract, { recursive: true, force: true });
  if (!fs.existsSync(path.join(installDir, "pyproject.toml"))) {
    throw new Error("仓库内容不完整：安装目录下没有 pyproject.toml");
  }

  // 2) uv
  ensureLive();
  let uvPath = findFile(cacheDir, asset.exe);
  if (!uvPath) {
    sendProgress("uv", "正在下载 uv（约 30MB）…");
    const uvArchive = path.join(cacheDir, asset.kind === "tar.gz" ? "uv.tar.gz" : "uv.zip");
    await downloadWithMirrors(asset.url, uvArchive, {
      mirrors: githubMirrors,
      signal: signal,
      onRetry: (next, err) => sendProgress("uv", "官方源下载失败（" + err.message + "），改用镜像重试…"),
    });
    ensureLive();
    sendProgress("uv", "正在解压 uv…");
    const uvDir = path.join(cacheDir, "uv");
    fs.rmSync(uvDir, { recursive: true, force: true });
    await extractArchive(uvArchive, uvDir, asset.kind, signal);
    uvPath = findFile(uvDir, asset.exe);
    if (!uvPath) throw new Error("uv 解压后未找到可执行文件（" + asset.exe + "）");
    try { fs.chmodSync(uvPath, 0o755); } catch { /* Windows 不需要 */ }
  }

  // 3) uv sync（官方 PyPI / GitHub 拉 CPython；失败才换镜像重试）
  ensureLive();
  sendProgress("deps", "正在安装依赖（会下载 Python 与 torch，数 GB，请耐心等待）…");
  const feedUv = (line) => {
    pushLog(line);
    sendProgress("deps", line.length > 200 ? line.slice(-200) : line);
  };
  const uvFailure = (err, retried) => new Error(
    "依赖安装失败（uv sync" + (retried ? "，官方与镜像均失败" : "") + "）：" + err.message
      + (bootstrapLog.length ? "\n\n最近输出：\n" + bootstrapLogTail(25) : ""),
  );
  try {
    await runStreaming(uvPath, ["sync"], { cwd: installDir, signal: signal }, feedUv);
  } catch (err) {
    const mirrorEnv = uvMirrorEnv(cfg);
    // 没配镜像（或用户已取消）就没得回退，如实报错。
    if (!Object.keys(mirrorEnv).length || (signal && signal.aborted)) throw uvFailure(err, false);
    const via = [
      mirrorEnv.UV_DEFAULT_INDEX ? "PyPI 镜像" : "",
      mirrorEnv.UV_PYTHON_INSTALL_MIRROR ? "CPython 镜像" : "",
    ].filter(Boolean).join(" + ");
    sendProgress("deps", "官方源安装失败（" + err.message + "），改用 " + via + " 重试…");
    try {
      await runStreaming(
        uvPath,
        ["sync"],
        { cwd: installDir, signal: signal, env: withEnv(mirrorEnv) },
        feedUv,
      );
    } catch (err2) {
      throw uvFailure(err2, true);
    }
  }

  // 4) 模型（主权重 + 辅助模型）
  // 辅助模型不预下载的话，首次启动会在 240s 就绪窗口里下载数 GB 而超时，故一并下载。
  ensureLive();
  const pythonPath = venvPythonPath(installDir);
  if (!fs.existsSync(pythonPath)) {
    throw new Error("依赖安装完成但未找到虚拟环境 Python：" + pythonPath);
  }
  // 用当前配置的引擎版本下载对应模型，避免「代码/权重版本不一致」。
  const engine = cfg.engineVersion;
  sendProgress(
    "model",
    "正在下载模型权重与辅助模型（" + (engine === "v2_5" ? "IndexTTS 2.5" : "IndexTTS 2.0") + "，数 GB，请耐心等待）…",
  );
  const modelDir = path.join(installDir, "checkpoints");
  const modelArgs = [SERVER_SCRIPT, "--download-only", "--download-aux", "--model-dir", modelDir, "--engine", engine];
  const feedModel = (line) => {
    pushLog(line);
    sendProgress("model", line.length > 200 ? line.slice(-200) : line);
  };
  const modelFailure = (err, retried) => new Error(
    "模型下载失败" + (retried ? "（官方与镜像均失败）" : "") + "：" + err.message
      + (bootstrapLog.length ? "\n\n最近输出：\n" + bootstrapLogTail(25) : ""),
  );
  // 先按用户选的来源（auto = 交给上游探测）；失败就换另一条路再试一次（fallback 语义）。
  const secondSource = cfg.modelSource === "modelscope" ? "official" : "modelscope";
  const secondLabel = secondSource === "modelscope" ? "ModelScope / hf-mirror" : "官方 HuggingFace";
  try {
    await runStreaming(pythonPath, modelArgs, {
      cwd: __dirname,
      signal: signal,
      env: withEnv(modelSourceEnv(cfg.modelSource)),
    }, feedModel);
  } catch (err) {
    if (signal && signal.aborted) throw modelFailure(err, false);
    sendProgress("model", "下载失败（" + err.message + "），改用 " + secondLabel + " 重试…");
    try {
      await runStreaming(pythonPath, modelArgs, {
        cwd: __dirname,
        signal: signal,
        env: withEnv(modelSourceEnv(secondSource)),
      }, feedModel);
    } catch (err2) {
      throw modelFailure(err2, true);
    }
  }
  if (!fs.existsSync(path.join(modelDir, "config.yaml"))) {
    throw new Error("模型下载完成但未找到 checkpoints/config.yaml");
  }
  if (!fs.existsSync(path.join(modelDir, "hf_cache"))) {
    throw new Error("辅助模型未下载完成（缺少 checkpoints/hf_cache），首次启动会继续下载并可能超时");
  }

  return { pythonPath: pythonPath, modelDir: modelDir };
}

// ---------------------------------------------------------------------------
// 健康探测
// ---------------------------------------------------------------------------
function probeHealth(port, nonce) {
  return new Promise((resolve) => {
    const req = http.get(
      // agent: false —— 不复用 keep-alive 连接池，避免轮询探测留下未关闭的 socket
      { host: DEFAULT_HOST, port: port, path: "/health", timeout: HEALTH_TIMEOUT_MS, agent: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve(false);
          // 有 nonce 时必须匹配：端口上已有别的服务应答 200 也不能算「我们自己的进程」就绪。
          resolve(!nonce || body.includes(nonce));
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 服务生命周期
// ---------------------------------------------------------------------------
/** 终止当前子进程（含进程树）。返回 Promise：等进程真正退出，或 5s 超时兜底。 */
function killChild() {
  const proc = child;
  child = null;
  running = false;
  ready = false;
  activeKey = null;
  clearStableTimer();
  if (!proc) return Promise.resolve();
  const exited = new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 5000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  try {
    if (process.platform === "win32" && proc.pid) {
      // Windows 上 proc.kill() 只终止直接子进程；用 taskkill /T 杀整棵进程树，
      // 避免 Python 派生的子进程残留（失控进程 / 内存不释放）。
      const killer = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => { try { proc.kill(); } catch { /* ignore */ } });
      // taskkill 运行了但失败（被安全软件拦截 / PID 复用 / 权限不足）时也要兜底。
      killer.on("exit", (code) => {
        if (code !== 0) { try { proc.kill(); } catch { /* ignore */ } }
      });
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
    try { proc.kill(); } catch { /* 进程可能已退出，忽略 */ }
  }
  // 等待结束后复核：确实没杀掉就把失败信息回给调用方，别谎报「已停止」。
  return exited.then(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      const msg = "无法终止 Python 进程（pid " + proc.pid + "），它可能仍在占用端口/显存，请手动结束";
      lastError = msg;
      return msg;
    }
    return null;
  });
}

/** 轮询 /health，直到就绪或到达挂钟截止时间（最坏约 STARTUP_TIMEOUT_MS）。 */
async function waitReady(port) {
  const startedAt = Date.now();
  const deadline = startedAt + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (deliberateStop || !child) return false;
    if (await probeHealth(port, HEALTH_NONCE)) {
      // 探测通过后再复核当前子进程仍存活，避免探测到别的服务 / 已退出的进程。
      if (deliberateStop || !child) return false;
      return true;
    }
    if (deliberateStop || !child) return false;
    if (Date.now() >= deadline) break;
    // 头 10s 用 250ms 粒度（改端口重启后更快就绪），之后退回 2s 省资源。
    const fast = Date.now() - startedAt < POLL_FAST_WINDOW_MS;
    await sleep(fast ? POLL_INTERVAL_FAST_MS : POLL_INTERVAL_MS);
  }
  return false;
}

/** 子进程意外退出：仅在它曾就绪过时才按预算自动重启，避免崩溃循环。 */
function onGone() {
  if (deliberateStop) {
    child = null;
    running = false;
    ready = false;
    return;
  }
  const wasReady = ready;
  child = null;
  running = false;
  ready = false;
  if (!wasReady) return; // 启动阶段就失败：交给 startServer 处理（杀进程 + 抛错）
  // 尊重「自动启动」开关：关掉时退出不再自动重启。
  const autoStart = ctxRef ? loadConfig().autoStart : true;
  if (!autoStart) {
    if (ctxRef) ctxRef.log("IndexTTS 服务已退出；未开启自动启动，不再自动重启");
    return;
  }
  if (restartCount >= MAX_RESTARTS) {
    if (ctxRef) ctxRef.log("IndexTTS 服务连续崩溃/启动失败 " + restartCount + " 次，已停止自动重启");
    return;
  }
  if (restartTimer) return;
  // 就绪后崩溃也要计数（否则「起来就崩」会无限重启）；稳定计时被这次崩溃打断。
  restartCount += 1;
  clearStableTimer();
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startServer({ fromRestart: true }).catch((err) => {
      if (ctxRef) ctxRef.log("IndexTTS 自动重启失败：" + err.message);
    });
  }, RESTART_DELAY_MS);
}

function startServer(options) {
  // 并发 / 重复调用（自动启动 + 手动点「启动」、快速双击）共享同一次启动，
  // 避免同时 spawn 出多个 Python 进程。
  if (startPromise) return startPromise;
  startPromise = doStartServer(options).finally(() => {
    startPromise = null;
  });
  return startPromise;
}

async function doStartServer(options) {
  const fromRestart = !!(options && options.fromRestart);
  const cfg = loadConfig();

  if (!cfg.modelDir || !cfg.pythonPath) {
    throw new Error("请先在插件窗口填写「模型目录」与「Python 路径」");
  }
  if (!fs.existsSync(SERVER_SCRIPT)) {
    throw new Error("插件缺少 indextts_server.py");
  }
  if (!fs.existsSync(cfg.modelDir)) {
    throw new Error("模型目录不存在：" + cfg.modelDir);
  }
  if (!fs.existsSync(cfg.pythonPath)) {
    throw new Error("Python 路径不存在：" + cfg.pythonPath);
  }

  if (!fromRestart) restartCount = 0; // 用户主动启动：重置崩溃预算

  const key = fingerprint(cfg);
  if (child) {
    // 已有进程：同一配置且已就绪才复用；否则（配置变化 / 残留 / 未就绪进程）先清掉，
    // 避免重复 spawn 造成多个 Python 进程堆积。注意这里不重置崩溃预算。
    if (running && activeKey === key) return baseUrl(cfg);
    deliberateStop = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    await killChild();
    deliberateStop = false;
  }

  if (restartCount >= MAX_RESTARTS) {
    throw new Error("服务连续启动失败 " + restartCount + " 次，已停止自动重启；修正配置后请手动启动");
  }

  deliberateStop = false;
  stopRequested = false; // 新的启动开始，清除上一次的停止请求
  ready = false;
  lastError = null;

  const args = [
    SERVER_SCRIPT,
    "--model-dir", cfg.modelDir,
    "--host", DEFAULT_HOST,
    "--port", String(cfg.port),
    "--engine", cfg.engineVersion,
    "--nonce", HEALTH_NONCE, // /health 回显，用于确认应答来自本进程
  ];
  if (cfg.emotionGuidance) args.push("--emotion"); // 加载 QwenEmotion + 文本情感引导

  serverLog = [];
  const proc = spawn(cfg.pythonPath, args, {
    cwd: __dirname,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    // USE_MODELSCOPE / HF_ENDPOINT：构造模型时若 hf_cache 不全，上游会按这个变量决定走哪条下载路径。
    env: withEnv(modelSourceEnv(cfg.modelSource)),
  });
  child = proc;
  const feedServer = (d) => {
    for (const line of d.toString().split(/\r\n|\r|\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      serverLog.push(trimmed);
      if (serverLog.length > 120) serverLog.splice(0, serverLog.length - 120);
      // 不直接写宿主 stdout；需要排查时设 CYRENE_INDEXTTS_DEBUG=1 走宿主日志。
      if (ctxRef && process.env.CYRENE_INDEXTTS_DEBUG) ctxRef.log("[IndexTTS] " + trimmed);
    }
  };
  proc.stdout.on("data", feedServer);
  proc.stderr.on("data", feedServer);
  proc.on("error", (err) => {
    if (child !== proc) return; // 旧进程的迟到事件，忽略
    lastError = err.message;
    onGone();
  });
  proc.on("exit", (code) => {
    if (child !== proc) return; // 关键：只处理「当前」子进程
    if (!deliberateStop && code !== 0) lastError = "Python 进程退出，code=" + code;
    onGone();
  });

  const ok = await waitReady(cfg.port);
  if (!ok) {
    // 启动失败（超时 / 进程退出 / 端口被占）：杀掉可能仍在加载模型的 Python 进程，
    // 避免留下不受管的进程。错误里附上服务端最后若干行输出，便于定位（CUDA/OOM 等）。
    // 若是用户/宿主主动停止（或插件正在停止）打断了启动，算「已取消」：不计入崩溃预算。
    const cancelled = stopRequested || (ctxRef && ctxRef.signal.aborted);
    deliberateStop = true;
    await killChild();
    deliberateStop = false;
    if (cancelled) {
      throw new Error("已取消启动");
    }
    restartCount += 1;
    const tail = serverLog.slice(-25).join("\n");
    const joined = serverLog.join("\n");
    const hint = /Checkpoint not found|missing keys|size mismatch/i.test(joined)
      ? "\n\n提示：模型与引擎版本可能不匹配——请确认「引擎版本」与模型目录 config.yaml 里的 version 一致"
        + "（当前引擎：" + cfg.engineVersion + "）。"
      : "";
    throw new Error(
      "IndexTTS 服务启动失败（" + Math.round(STARTUP_TIMEOUT_MS / 1000) + "s 内未就绪，已终止 Python 进程）"
        + (lastError ? "\n原因：" + lastError : "")
        + (tail ? "\n\n服务端输出：\n" + tail : "")
        + hint,
    );
  }

  running = true;
  ready = true;
  activeKey = key;
  markStable(); // 稳定运行 STABLE_RESET_MS 后才重置崩溃预算（就绪即清零会让「起来就崩」无限重启）
  if (ctxRef) ctxRef.log("IndexTTS 服务已就绪：" + baseUrl(cfg));
  return baseUrl(cfg);
}

async function stopServer() {
  stopRequested = true;
  deliberateStop = true;
  clearStableTimer();
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const killFailure = await killChild();
  // 关键：等在途启动流程彻底结束（含它自己的「已取消」失败分支，并清空 startPromise）。
  // 否则调用方随后的 startServer() 会复用那个注定失败的 promise，重启被静默吞掉。
  if (startPromise) await startPromise.catch(() => {});
  deliberateStop = false;
  restartCount = 0;
  // 只清「上一轮的启动失败」，killChild 刚写的「没杀掉」必须留着：
  // 否则 getState()/窗口会显示「服务已停止」，而那个 Python 还在占着端口与显存。
  lastError = killFailure || null;
}

function getState() {
  const cfg = loadConfig();
  return {
    config: cfg,
    running: running,
    ready: ready,
    starting: !!child && !ready,
    pid: child ? child.pid : null,
    baseUrl: baseUrl(cfg),
    lastError: lastError,
    restartCount: restartCount,
    maxRestarts: MAX_RESTARTS,
    bootstrap: bootstrapState,
    serverLog: serverLog.slice(-40),
    installDir: loadInstallDir(),
  };
}

/** 把绝对路径缩短成「盘符…末级目录」，避免完整本机路径进入对话上下文。 */
function shortenPath(p) {
  if (!p) return "";
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  const sep = p.includes("\\") ? "\\" : "/";
  return parts[0] + sep + "…" + sep + parts[parts.length - 1];
}

/** 把一段文本里的绝对路径替换成缩短形式（错误信息里可能夹着 python/模型路径）。 */
function redactPaths(text) {
  if (!text) return "";
  return text
    .replace(/[A-Za-z]:\\[^\s"'<>|]*/g, (m) => shortenPath(m))
    .replace(/\/(?:[\w.-]+\/)+[\w.-]+/g, (m) => shortenPath(m));
}

function statusText() {
  const s = getState();
  const cfg = s.config;
  const lines = [];
  lines.push("IndexTTS 本地服务：" + (s.ready ? "运行中" : s.starting ? "启动中" : "已停止"));
  lines.push("地址：" + s.baseUrl);
  lines.push("模型目录：" + (cfg.modelDir ? shortenPath(cfg.modelDir) : "（未配置）"));
  lines.push("Python：" + (cfg.pythonPath ? shortenPath(cfg.pythonPath) : "（未配置）"));
  lines.push("引擎版本：" + (cfg.engineVersion === "v2_5" ? "v2_5（IndexTTS 2.5）" : "v2（IndexTTS 2.0）"));
  lines.push("模型来源：" + (cfg.modelSource === "modelscope" ? "ModelScope / hf-mirror"
    : cfg.modelSource === "official" ? "官方 HuggingFace" : "自动探测"));
  const mirrorsOn = parseMirrors(cfg.githubMirror).length + parseMirrors(cfg.pypiMirror).length;
  lines.push("下载镜像：" + (mirrorsOn ? "已配置（仅在官方源失败时回退）" : "未配置（只用官方源）"));
  if (s.lastError) lines.push("最近错误：" + redactPaths(s.lastError));
  lines.push("用法：在 Cyrene 的 TTS 设置中选择 GPT-SoVITS，把 API 地址填成上面的地址。");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 插件定义
// ---------------------------------------------------------------------------
const plugin = {
  async register(ctx) {
    ctxRef = ctx;

    // ---- 私有 IPC（窗口用，通道名会被宿主补全为 plugin:indextts-tts:<name>）----
    ctx.registerIpc("getState", () => getState());

    ctx.registerIpc("saveConfig", async (patch) => {
      const before = loadConfig();
      const next = saveConfig(Object.assign({}, before, patch && typeof patch === "object" ? patch : {}));
      const changed = fingerprint(before) !== fingerprint(next);
      // child 存在即视为活跃：启动中（child 已存在、ready 尚未置位）改配置同样必须重启，
      // 否则状态/工具会按新配置报告地址，而 Python 仍监听旧端口。
      // autoStart 的语义是「插件启用时是否自动启动」，不应决定「改配置后是否恢复正在运行的服务」。
      if ((running || child) && changed) {
        await stopServer();
        try {
          await startServer();
        } catch (err) {
          ctx.log("配置变更后重启失败：" + err.message);
        }
      }
      return getState();
    });

    ctx.registerIpc("start", async () => {
      try {
        await startServer();
        return { ok: true, state: getState() };
      } catch (err) {
        return { ok: false, error: err.message, state: getState() };
      }
    });

    ctx.registerIpc("stop", async () => {
      await stopServer();
      return getState();
    });

    ctx.registerIpc("pickModelDir", async () => {
      const { dialog } = require("electron");
      const opts = { title: "选择 IndexTTS 模型目录（含 config.yaml）", properties: ["openDirectory"] };
      const win = pluginWin && !pluginWin.isDestroyed() ? pluginWin : null;
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
    });

    ctx.registerIpc("pickPython", async () => {
      const { dialog } = require("electron");
      const opts = {
        title: "选择已安装 index-tts 与 torch 的 Python 解释器",
        properties: ["openFile"],
      };
      // 只在 Windows 上按 .exe 过滤；macOS/Linux 的解释器是 python3（无扩展名），过滤会选不到。
      if (process.platform === "win32") {
        opts.filters = [{ name: "Python", extensions: ["exe"] }];
      }
      const win = pluginWin && !pluginWin.isDestroyed() ? pluginWin : null;
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
    });

    // ---- 一键配置：已装好则直接配置启动；未装则从 GitHub 全自动安装 ----
    ctx.registerIpc("pickInstallDir", async () => {
      const { dialog } = require("electron");
      const opts = { title: "选择 IndexTTS 安装目录（含 .venv 与 checkpoints）", properties: ["openDirectory"] };
      const win = pluginWin && !pluginWin.isDestroyed() ? pluginWin : null;
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
    });

    ctx.registerIpc("oneclick", async (base) => {
      const dir = typeof base === "string" ? base.trim() : "";
      if (!dir) return { ok: false, error: "请先选择安装目录" };
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        return { ok: false, error: "无法创建目录 " + dir + "：" + err.message };
      }
      saveInstallDir(dir);

      // 快速路径：目录里已经有可用的 Python 与模型
      const detected = detectInstallation(dir);
      if (detected.pythonPath && detected.modelDir) {
        // 辅助模型缺失时首次启动会先下载数 GB，提示用户（不阻塞配置启动）。
        const auxPending = !fs.existsSync(path.join(detected.modelDir, "hf_cache"));
        const next = saveConfig(Object.assign({}, loadConfig(), {
          pythonPath: detected.pythonPath,
          modelDir: detected.modelDir,
        }));
        try {
          await startServer();
          return {
            ok: true, mode: "existing", detected: detected, config: next,
            auxPending: auxPending, state: getState(),
          };
        } catch (err) {
          return {
            ok: false,
            mode: "existing",
            error: "已识别到现有安装，但启动失败：" + err.message,
            detected: detected,
            config: next,
            state: getState(),
          };
        }
      }

      if (bootstrapState.active) {
        return { ok: false, error: "已有安装任务在进行中" };
      }
      // 先占位：确认弹窗期间也算「进行中」，避免连点两次起两个安装。
      sendProgress("confirm", "等待确认…");

      // 从零安装：先确认（数 GB 下载）
      const { dialog } = require("electron");
      const win = pluginWin && !pluginWin.isDestroyed() ? pluginWin : null;
      // 目录非空且不是 IndexTTS 仓库时，安装会把仓库文件铺进这个目录，先告知用户。
      let dirNonEmpty = false;
      try {
        dirNonEmpty = fs.readdirSync(dir).length > 0 && !fs.existsSync(path.join(dir, "pyproject.toml"));
      } catch { dirNonEmpty = false; }
      const confirmOpts = {
        type: "question",
        buttons: ["开始安装", "取消"],
        defaultId: 1,
        cancelId: 1,
        title: "从零安装 IndexTTS",
        message: "未检测到可用的 IndexTTS，是否从 GitHub 下载并安装？",
        detail: "将下载 IndexTTS 仓库、uv、Python 与 torch 等依赖（数 GB）以及模型权重；"
          + "首次约 10–30 分钟，请确保网络通畅、磁盘空间充足。\n\n安装目录：" + dir
          + "\n\n官方源下载失败时会自动改用镜像重试（见「高级选项 → 镜像」，清空即只用官方源）。"
          + (dirNonEmpty ? "\n\n⚠ 该目录不是空的，安装会把 IndexTTS 仓库文件写进这个目录。" : ""),
      };
      const choice = win ? await dialog.showMessageBox(win, confirmOpts) : await dialog.showMessageBox(confirmOpts);
      if (choice.response !== 0) {
        finishProgress(null);
        return { ok: false, canceled: true, error: "已取消安装" };
      }

      try {
        const installed = await bootstrapInstall(dir, ctxRef ? ctxRef.signal : undefined);
        const next = saveConfig(Object.assign({}, loadConfig(), {
          pythonPath: installed.pythonPath,
          modelDir: installed.modelDir,
        }));
        await startServer();
        finishProgress(null);
        return { ok: true, mode: "installed", installed: installed, config: next, state: getState() };
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        finishProgress(message);
        return { ok: false, mode: "installed", error: message, state: getState() };
      }
    });

    // ---- AI 工具（id 必须以 <插件id>_ 开头）----
    ctx.registerTool({
      id: "indextts-tts_status",
      name: "IndexTTS 服务状态",
      description: "查询本机 IndexTTS 本地语音合成服务的运行状态、监听地址与配置。用户问 IndexTTS / 本地语音服务有没有在跑、监听哪个端口时使用。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        return statusText();
      },
    });

    ctx.registerTool({
      id: "indextts-tts_start",
      name: "启动 IndexTTS 服务",
      description: "启动本机 IndexTTS 本地语音合成服务（会拉起一个本地 Python 进程并占用显存，使用插件里已配置的模型目录与 Python 路径）。用户让你启动 IndexTTS / 本地语音服务时使用。",
      enabled: true,
      risk: "shell",
      effectKind: "external_side_effect",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        try {
          const url = await startServer();
          return "IndexTTS 服务已启动：" + url;
        } catch (err) {
          return "启动失败：" + err.message;
        }
      },
    });

    ctx.registerTool({
      id: "indextts-tts_stop",
      name: "停止 IndexTTS 服务",
      description: "停止本机 IndexTTS 本地语音合成服务（会终止该本地 Python 进程并释放显存）。用户让你停止 IndexTTS / 本地语音服务时使用。",
      enabled: true,
      risk: "shell",
      effectKind: "external_side_effect",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        await stopServer();
        return "IndexTTS 服务已停止";
      },
    });

    // ---- 清理：停用 / 刷新 / 退出时都要干净释放（可重复调用）----
    ctx.onDispose(() => {
      killAuxChildren(); // 一键安装期间派生的 uv / python 也要一并终止
      if (pluginWin && !pluginWin.isDestroyed()) pluginWin.close();
      pluginWin = null;
      // 返回 Promise 让宿主等到 Python 真正退出（最坏 5s，仍在宿主单项清理预算内）。
      return stopServer();
    });

    // ---- 启用时按配置自动启动 ----
    const cfg = loadConfig();
    if (cfg.autoStart) {
      if (cfg.modelDir && cfg.pythonPath) {
        // 后台启动：宿主会 await register()，不能在这里阻塞（模型加载最长 240s）。
        // 状态由窗口每 3s 轮询 getState() 获取。
        void startServer().catch((err) => {
          ctx.log("自动启动失败：" + err.message + "（可打开插件窗口检查配置后手动启动）");
        });
      } else {
        ctx.log("尚未配置模型目录 / Python 路径，请打开插件窗口填写后启动");
      }
    } else {
      ctx.log("已关闭自动启动；可在插件窗口手动启动服务");
    }

    ctx.log("IndexTTS 插件已注册");
  },

  async open() {
    if (pluginWin && !pluginWin.isDestroyed()) {
      pluginWin.focus();
      return;
    }
    const { BrowserWindow } = require("electron");
    pluginWin = new BrowserWindow({
      width: 580,
      height: 680,
      minWidth: 480,
      minHeight: 540,
      autoHideMenuBar: true,
      backgroundColor: "#fff9fc",
      title: "IndexTTS 本地语音",
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

  async unregister() {
    killAuxChildren();
    clearStableTimer();
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (pluginWin && !pluginWin.isDestroyed()) pluginWin.close();
    pluginWin = null;
    // 异步停止交给 ctx.onDispose 里的 stopServer()：宿主先 await unregister（5s 预算）
    // 再跑 onDispose，这里再 await 一次最坏会撞上限并重复清理。
  },
};

module.exports = plugin;
module.exports.default = plugin;
