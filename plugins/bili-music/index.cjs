"use strict";
/**
 * bili-music v0.3.0 — Cyrene 插件
 * 用 B 站视频分 P 当音乐音源：搜索 → 定位分 P → 拉 DASH 音频流 → ffmpeg 转 M4A → 落到 plugin-data。
 * 支持扫码登录（可选），匿名也可用。
 *
 * 工具（语音听歌全链路）：
 *   bili-music_search       按关键词搜视频，返回最多 N 条候选（标题/bvid/UP主/时长/播放量）
 *   bili-music_video_info   输入 BV 号，列出全部可交付分 P
 *   bili-music_play         下载指定分 P 音频转 M4A，并用内置隐藏播放器直接出声（enqueueOnly 可只入队）
 *   bili-music_playback     播放控制：pause/resume/stop/next/volume/status
 *   bili-music_probe_ffmpeg 体检 ffmpeg 可用性
 *   bili-music_login_status 查询 B 站扫码登录状态
 *
 * v0.2.0：内置播放器（语音听歌闭环）
 * - 隐藏 BrowserWindow + <audio> 出声，不依赖宿主音乐服务（网易云 OpenAPI 未配置也能播）
 * - 播放队列：播放中再点播自动入队，播完自动切下一首；stop 清空队列
 *
 * v0.3.0：B 站扫码登录（零门槛：产品 Cookie 协议，非开放平台，无需注册开发者）
 * - 流程：passport generate → 面板画二维码（内嵌 qrcode-generator）→ 2s 轮询 poll
 *   → 86101 未扫 / 86090 已扫待确认 / 86038 失效 / 0 成功 → Set-Cookie 收 SESSDATA/bili_jct/DedeUserID + refresh_token
 * - 登录前先取 buvid3/buvid4 设备指纹（finger/spi）降风控
 * - Cookie 落盘 bili-cookies.json；SESSDATA 约 30 天，到期走官方刷新链：
 *   cookie/info → correspondPath(RSA-OAEP-SHA256, refresh_<ts>) → correspond/1/<path> 取 refresh_csrf
 *   → cookie/refresh POST → confirm/refresh 使旧 refresh_token 失效
 * - 登录后收益：DASH 高码率音频档、放宽体积门禁、降低限流
 *
 * v0.3.1：搜索风控修复
 * - UA 换标准 Chrome（自定义 UA 被 B 站风控拦，返回 HTML）
 * - search/type 加 WBI 签名（w_rid/wts，nav 取 key + 混淆表 + md5）
 *
 * 已知限制：
 *   - 匿名单个分 P > 50 MiB 拒绝；登录后放宽到 200 MiB
 *   - 付费（fee=1）/试听（fee=8）/地区受限 等曲目 B 站会返回 404，自动失败
 *   - 扫码协议为非官方逆向接口，存在变动可能
 */

const fs   = require("node:fs");
const fsp  = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const https = require("node:https");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

// ---------------------------------------------------------------------------
// 持久化数据目录（plugin-data/bili-music/audio）。app ready 后再取值。
// ---------------------------------------------------------------------------
let DATA_DIR = null;          // .../<userData>/plugin-data/bili-music
let AUDIO_DIR = null;         // DATA_DIR/audio
let FFMPEG_PATH = null;       // 首次探到后缓存

// ---------------------------------------------------------------------------
// UI 窗口与 IPC 通道
// ---------------------------------------------------------------------------
const PLUGIN_ID = "bili-music";
const CH_MIN = "plugin:bili-music:win-minimize";
const CH_CLOSE = "plugin:bili-music:win-close";
const CH_PLAYER_ENDED = "plugin:bili-music:player-ended";   // player.html → main（audio ended）
const CH_PLAYER_EVENT = "plugin:bili-music:player-event";   // player.html → main（错误等）
let pluginWin = null;
let ipcHandlers = null;       // 闭包用于解绑
let pluginCtxRef = null;      // register 时存的 ctx（日志用）

// ---------------------------------------------------------------------------
// 内置播放器（隐藏窗口 + <audio>，语音听歌出声层）
// ---------------------------------------------------------------------------
let playerWin = null;         // 隐藏播放器窗口
let playerLoaded = false;     // player.html 是否已加载
let currentTrack = null;      // { path, title, author } 正在播的
const playQueue = [];         // 待播队列
let lastPlayerError = "";     // player.html 上报的最近错误

function ensureDataDir() {
  if (DATA_DIR) return DATA_DIR;
  // electron 在主进程 require 是安全的；app.getPath 在 register 时也 OK
  const { app } = require("electron");
  const userData = app.getPath("userData");
  DATA_DIR = path.join(userData, "plugin-data", "bili-music");
  AUDIO_DIR = path.join(DATA_DIR, "audio");
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  return DATA_DIR;
}

// ---------------------------------------------------------------------------
// 用户设置：ffmpeg 路径 / 下载目录（settings.json，UI 可改）
// ---------------------------------------------------------------------------
let SETTINGS = null;

function loadSettings() {
  ensureDataDir();
  if (SETTINGS) return SETTINGS;
  try { SETTINGS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "settings.json"), "utf8")) || {}; }
  catch { SETTINGS = {}; }
  if (typeof SETTINGS.ffmpegPath !== "string") SETTINGS.ffmpegPath = "";
  if (typeof SETTINGS.downloadDir !== "string") SETTINGS.downloadDir = "";
  return SETTINGS;
}

function saveSettings(next) {
  const cur = loadSettings();
  if (typeof next.ffmpegPath === "string") cur.ffmpegPath = next.ffmpegPath.trim();
  if (typeof next.downloadDir === "string") cur.downloadDir = next.downloadDir.trim();
  fs.writeFileSync(path.join(DATA_DIR, "settings.json"), JSON.stringify(cur, null, 2), "utf8");
  FFMPEG_PATH = null;      // 强制下次重新解析 ffmpeg
  return { ok: true, settings: { ...cur } };
}

// 实际生效的下载目录：用户设置优先，否则默认 plugin-data/bili-music/audio
function getAudioDir() {
  const s = loadSettings();
  const dir = s.downloadDir || AUDIO_DIR;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// 登录态 / Cookie 保险库（v0.3.0 扫码登录）
// ---------------------------------------------------------------------------
let COOKIES = null;            // { SESSDATA, bili_jct, DedeUserID, buvid3, buvid4, refresh_token, savedAt }
let loginSession = null;       // 进行中的扫码会话 { qrcodeKey, qrContent, phase, timer }
let refreshAttempted = false;  // 每进程只主动尝试刷新一次，防止循环

function cookieFilePath() {
  ensureDataDir();
  return path.join(DATA_DIR, "bili-cookies.json");
}

function loadCookies() {
  if (COOKIES) return COOKIES;
  try { COOKIES = JSON.parse(fs.readFileSync(cookieFilePath(), "utf8")); }
  catch { COOKIES = null; }
  return COOKIES;
}

function saveCookies() {
  ensureDataDir();
  fs.writeFileSync(cookieFilePath(), JSON.stringify(COOKIES, null, 2), "utf8");
}

function clearCookies() {
  COOKIES = null;
  try { fs.rmSync(cookieFilePath(), { force: true }); } catch { /* noop */ }
}

/** 请求用 Cookie 头（有登录态才返回非空） */
function authCookieHeader() {
  const c = loadCookies();
  if (!c || !c.SESSDATA) return "";
  const parts = [`SESSDATA=${c.SESSDATA}`, `bili_jct=${c.bili_jct || ""}`, `DedeUserID=${c.DedeUserID || ""}`];
  if (c.buvid3) parts.push(`buvid3=${c.buvid3}`);
  if (c.buvid4) parts.push(`buvid4=${c.buvid4}`);
  return parts.join("; ");
}

/** 从 set-cookie 数组里挑出某 cookie 的值 */
function pickCookie(setCookies, name) {
  for (const line of setCookies || []) {
    const first = String(line).split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0 && first.slice(0, eq).trim() === name) return first.slice(eq + 1);
  }
  return null;
}

/** 登录前取 buvid3/buvid4 设备指纹（降风控；拿不到不阻塞） */
async function ensureBuvid() {
  const c = loadCookies();
  if (c && c.buvid3) return c;
  try {
    const { json } = await httpGetRaw("https://api.bilibili.com/x/frontend/finger/spi");
    if (json && json.code === 0 && json.data && json.data.b_3) {
      COOKIES = c || {};
      COOKIES.buvid3 = json.data.b_3;
      COOKIES.buvid4 = json.data.b_4 || "";
      if (COOKIES.SESSDATA) saveCookies();
    }
  } catch { /* 指纹失败不阻塞扫码 */ }
  return COOKIES;
}

// ---------------------------------------------------------------------------
// HTTP 工具：内置 https，带 UA / Referer（B 站裸 fetch 直接 403）
// ---------------------------------------------------------------------------
// v0.3.1：UA 换标准 Chrome——非标 UA（带 Cyrene 后缀）被 B 站风控拦，搜索返回 HTML 验证页
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
const REFERER = "https://www.bilibili.com";

// ---------------------------------------------------------------------------
// WBI 签名（v0.3.1）：search/type 现要求 w_rid+wts，裸调必被风控
// 流程：nav 取 img_key/sub_key → 混淆表重排取 32 位 mixin_key → 参数排序拼 query → md5(query+mixin_key)
// keys 每天变，缓存 12 小时；nav 失败则退回无签名（死马当活马医）
// ---------------------------------------------------------------------------
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];
let wbiCache = null; // { mixinKey, fetchedAt }

function getMixinKey(orig) {
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join("").slice(0, 32);
}

async function getMixinKeyCached() {
  if (wbiCache && Date.now() - wbiCache.fetchedAt < 12 * 3600 * 1000) return wbiCache.mixinKey;
  const json = await httpJson("https://api.bilibili.com/x/web-interface/nav");
  const img = json?.data?.wbi_img?.img_url || "";
  const sub = json?.data?.wbi_img?.sub_url || "";
  if (!img || !sub) throw new Error("E_WBI_KEYS_EMPTY");
  const imgKey = img.slice(img.lastIndexOf("/") + 1, img.lastIndexOf("."));
  const subKey = sub.slice(sub.lastIndexOf("/") + 1, sub.lastIndexOf("."));
  wbiCache = { mixinKey: getMixinKey(imgKey + subKey), fetchedAt: Date.now() };
  return wbiCache.mixinKey;
}

/** 对参数做 WBI 签名，返回合并了 wts/w_rid 的新参数对象 */
async function wbiSign(params) {
  let mixinKey = "";
  try { mixinKey = await getMixinKeyCached(); }
  catch { return params; } // nav 拿不到 key 就不签（旧行为）
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(p)
    .sort()
    .map((k) => {
      const v = String(p[k]).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
      return `${k}=${encodeURIComponent(v)}`;
    })
    .join("&");
  const wRid = crypto.createHash("md5").update(query + mixinKey).digest("hex");
  return { ...p, w_rid: wRid };
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const headers = { "User-Agent": UA, Referer: REFERER, Accept: "application/json" };
    const ck = authCookieHeader();
    if (ck) headers.Cookie = ck; // 登录态自动附带（音质/风控收益）
    const req = https.get(url, { headers }, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) return reject(new Error(`E_HTTP_${res.statusCode} ${text.slice(0, 200)}`));
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error(`E_NON_JSON: ${text.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("E_TIMEOUT")));
  });
}

function httpStream(url) {
  // 返回 Promise<{status, stream}>，调用方 stream.on('data') 自取
  return new Promise((resolve, reject) => {
    const headers = { "User-Agent": UA, Referer: REFERER };
    const ck = authCookieHeader();
    if (ck) headers.Cookie = ck;
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`E_HTTP_${res.statusCode} (audio stream)`));
      }
      // 暴露 content-length 给上层做大小门禁
      res.contentLength = Number(res.headers["content-length"]) || null;
      resolve({ status: res.statusCode, stream: res, contentLength: res.contentLength });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("E_TIMEOUT_STREAM")));
  });
}

/** 原始 GET：返回 {status, json, text, setCookies}（登录轮询要从 Set-Cookie 收凭证） */
function httpGetRaw(url) {
  return new Promise((resolve, reject) => {
    const headers = { "User-Agent": UA, Referer: REFERER, Accept: "application/json" };
    const ck = authCookieHeader();
    if (ck) headers.Cookie = ck;
    const req = https.get(url, { headers }, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const out = { status: res.statusCode, json: null, text, setCookies: res.headers["set-cookie"] || [] };
        try { out.json = JSON.parse(text); } catch { /* 非 JSON 由调用方处理 */ }
        resolve(out);
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("E_TIMEOUT")));
  });
}

/** GET 文本（correspond 页面解析 refresh_csrf 用） */
function httpGetText(url) {
  return new Promise((resolve, reject) => {
    const headers = { "User-Agent": UA, Referer: REFERER };
    const ck = authCookieHeader();
    if (ck) headers.Cookie = ck;
    const req = https.get(url, { headers }, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("E_TIMEOUT")));
  });
}

/** POST application/x-www-form-urlencoded；返回 {status, json, setCookies}（Cookie 刷新链用） */
function httpPostForm(url, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const headers = {
      "User-Agent": UA,
      Referer: "https://passport.bilibili.com/",
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
    const ck = authCookieHeader();
    if (ck) headers.Cookie = ck;
    const req = https.request(url, { method: "POST", headers }, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const out = { status: res.statusCode, json: null, text, setCookies: res.headers["set-cookie"] || [] };
        try { out.json = JSON.parse(text); } catch { /* 同上 */ }
        resolve(out);
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("E_TIMEOUT")));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 公共工具
// ---------------------------------------------------------------------------
function safeFilename(s) {
  // Windows 非法字符 / 长度截断
  return String(s || "untitled")
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "untitled";
}

// "12:34" / "1:23:45" → 秒
function parseDuration(s) {
  if (typeof s === "number") return s;
  if (!s) return 0;
  const parts = String(s).split(":").map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function formatDuration(sec) {
  sec = Math.round(Number(sec) || 0);
  if (sec >= 3600) return `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// ffmpeg 查找：where / which / 常见路径
// ---------------------------------------------------------------------------
async function findFfmpeg() {
  // 0) 用户显式设置的路径最优先
  const s = loadSettings();
  if (s.ffmpegPath) {
    try { await fsp.access(s.ffmpegPath); FFMPEG_PATH = s.ffmpegPath; return FFMPEG_PATH; } catch {}
  }
  if (FFMPEG_PATH) {
    try { await fsp.access(FFMPEG_PATH); return FFMPEG_PATH; } catch { FFMPEG_PATH = null; }
  }
  const tries = [
    // PATH 里直接调（where 输出是 GBK 编码，按 utf8 解码中文路径会乱码导致 spawn ENOENT）
    async () => new Promise((r) => execFile("where", ["ffmpeg"], { windowsHide: true, encoding: "buffer" }, (e, so) => {
      if (e) return r(null);
      let text;
      try { text = new TextDecoder("gbk").decode(so); } catch { text = so.toString("utf8"); }
      const p = text.split(/\r?\n/).map((x) => x.trim()).find((x) => x && /\.exe$/i.test(x));
      r(p || null);
    })),
    // PATH 目录逐个核实（比 where 可靠：直接对文件系统验证，不依赖命令行输出编码）
    async () => {
      const sep = process.platform === "win32" ? ";" : ":";
      const dirs = (process.env.PATH || "").split(sep).filter(Boolean);
      for (const dir of dirs) {
        // 直接命中
        const direct = path.join(dir, "ffmpeg.exe");
        try { await fsp.access(direct); return direct; } catch {}
        // 嵌套布局：PATH 目录下 ffmpeg-*/bin/ffmpeg.exe（如解压版 essentials_build）
        try {
          const names = await fsp.readdir(dir, { withFileTypes: true });
          for (const n of names) {
            if (!n.isDirectory() || !/^ffmpeg/i.test(n.name)) continue;
            const cand = path.join(dir, n.name, "bin", "ffmpeg.exe");
            try { await fsp.access(cand); return cand; } catch {}
          }
        } catch {}
      }
      return null;
    },
    // 常见 Windows 安装路径
    async () => {
      const fixed = [
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
        "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
        "C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe",
        "D:\\ffmpeg\\bin\\ffmpeg.exe",
        "D:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
      ];
      for (const p of fixed) {
        try { await fsp.access(p); return p; } catch {}
      }
      return null;
    },
    // 兜底：直接 ffmpeg（Linux/macOS 或 PATH 已配）
    async () => new Promise((r) => execFile("ffmpeg", ["-version"], { windowsHide: true }, (e, so) => r(e ? null : "ffmpeg"))),
  ];
  for (const t of tries) {
    const p = await t();
    if (!p) continue;
    if (p !== "ffmpeg") {
      // 候选必须真实存在（PATH 命中但文件被移动/删除的情况直接跳过）
      try { await fsp.access(p); } catch { continue; }
    }
    FFMPEG_PATH = p;
    return p;
  }
  return null;
}

async function getFfmpegVersion(ffp) {
  return new Promise((r) => execFile(ffp, ["-version"], { windowsHide: true }, (e, so) => {
    if (e) return r(null);
    const m = String(so).match(/ffmpeg version ([^\s]+)/i);
    r(m ? m[1] : String(so).split(/\r?\n/)[0] || "unknown");
  }));
}

// ---------------------------------------------------------------------------
// ffmpeg 一键安装：npmmirror 国内镜像下载静态单文件 → 存 DATA_DIR/bin → 自动配置
// ---------------------------------------------------------------------------
const FFMPEG_MIRROR = "https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.0/ffmpeg-win32-x64";

/** 跟随重定向下载文件（npmmirror 会 302 到 CDN） */
function downloadToFile(url, dest, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(downloadToFile(next, dest, maxRedirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`E_DOWNLOAD_HTTP_${res.statusCode}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve(dest)));
      out.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(120000, () => req.destroy(new Error("E_DOWNLOAD_TIMEOUT")));
  });
}

/**
 * 一键安装 ffmpeg：
 * 1. 下静态单文件（约 78MB）到 DATA_DIR/bin/ffmpeg.exe
 * 2. 跑 -version 验证
 * 3. 写进 settings.ffmpegPath（立即生效）
 */
async function installFfmpeg() {
  ensureDataDir();
  const binDir = path.join(DATA_DIR, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const dest = path.join(binDir, "ffmpeg.exe");
  const tmp = dest + ".downloading";
  try {
    await downloadToFile(FFMPEG_MIRROR, tmp);
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`E_FFMPEG_DOWNLOAD_FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
  const ver = await getFfmpegVersion(dest);
  if (!ver) throw new Error("E_FFMPEG_VERIFY_FAILED — 下载的文件无法执行，可能被安全软件拦截");
  saveSettings({ ffmpegPath: dest });
  return { ok: true, path: dest, version: ver };
}

// ---------------------------------------------------------------------------
// B 站 API
// ---------------------------------------------------------------------------

// 搜索视频：search_type=video；返回 [{bvid,title,author,durationSec,durationStr,playCount,url}]
// v0.3.1：走 WBI 签名（该接口无签名直接被风控返回 HTML）
async function searchVideos(keyword, limit) {
  const lim = Math.max(1, Math.min(limit || 10, 20));
  const signed = await wbiSign({
    search_type: "video",
    keyword,
    page: 1,
    page_size: lim,
  });
  const qs = new URLSearchParams(signed).toString();
  // v0.3.1：必须打 /wbi/ 专用路径——旧路径 /search/type 现直接返回 aba 出错页（HTML）
  const url = `https://api.bilibili.com/x/web-interface/wbi/search/type?${qs}`;
  const json = await httpJson(url);
  if (json?.code !== 0) throw new Error(`E_SEARCH_FAILED code=${json?.code} msg=${json?.message || json?.msg || "unknown"}`);
  const results = Array.isArray(json.data?.result) ? json.data.result : [];
  return results.map((v) => ({
    bvid: v.bvid,
    title: String(v.title || "").replace(/<[^>]+>/g, ""),
    author: v.author || v.upower || "",
    durationSec: parseDuration(v.duration),
    durationStr: v.duration || "",
    playCount: v.play || 0,
    url: v.arcurl || (v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : ""),
  }));
}

// 视频详情 + 分P：返回 {title, author, bvid, pages:[{page,cid,part,durationSec}]}
async function getVideoInfo(bvid) {
  if (!/^BV1[0-9A-Za-z]{8,}$/.test(String(bvid || ""))) throw new Error("E_INVALID_BVID");
  const json = await httpJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  if (json?.code !== 0) throw new Error(`E_VIEW_FAILED code=${json?.code} msg=${json?.message || json?.msg || "unknown"}`);
  const d = json.data || {};
  const pages = Array.isArray(d.pages) ? d.pages.map((p) => ({
    page: p.page,
    cid: p.cid,
    part: p.part || "",
    durationSec: p.duration || 0,
  })) : [];
  return {
    bvid: d.bvid,
    aid: d.aid,
    title: d.title || "",
    author: d.owner?.name || "",
    cover: d.pic || "",
    durationSec: d.duration || 0,
    pages,
  };
}

// 拿 DASH 音频流：选 audio 数组里 id 最大的（最高音质）
async function getDashAudioUrl(bvid, cid) {
  // fnval=16=DASH, fourk=1, platform=html5, high_quality=1 触发高音质
  const url = `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&qn=80&fnval=16&fnver=0&fourk=1&platform=html5&high_quality=1`;
  const json = await httpJson(url);
  if (json?.code !== 0) throw new Error(`E_PLAYURL_FAILED code=${json?.code} msg=${json?.message || json?.msg || "unknown"}`);
  const dash = json.data?.dash;
  if (!dash || !Array.isArray(dash.audio) || dash.audio.length === 0) {
    throw new Error("E_DASH_AUDIO_MISSING (可能是付费/地区限制/试听曲目)");
  }
  // id 最大 = 最高音质（30280=192k, 30232=128k, 30216=64k）
  const sorted = [...dash.audio].sort((a, b) => (b.id || 0) - (a.id || 0));
  const best = sorted[0];
  const streamUrl = best.baseUrl || (Array.isArray(backupUrlOrBase(best)) ? backupUrlOrBase(best)[0] : null);
  if (!streamUrl) throw new Error("E_DASH_AUDIO_NO_URL");
  return {
    url: streamUrl,
    quality: best.id,
    bandwidth: best.bandwidth || 0,
    codecs: best.codecs || "",
    contentLength: null, // playurl 接口不返回音频流大小
  };
}

function backupUrlOrBase(audio) {
  return Array.isArray(audio.backupUrl) ? audio.backupUrl : [];
}

// 下载 + 转 M4A
// 入参：{ bvid, page, title }；返回 { audioPath, durationSec, fileSize, quality, bandwidth }
// 体积门禁：匿名 50 MiB，登录后放宽到 200 MiB（高码率档体积更大）
function maxAudioBytes() {
  const c = loadCookies();
  return (c && c.SESSDATA) ? 200 * 1024 * 1024 : 50 * 1024 * 1024;
}

async function downloadAndTranscode({ bvid, page, title }) {
  ensureDataDir();
  const ffp = await findFfmpeg();
  if (!ffp) throw new Error("E_FFMPEG_NOT_FOUND — 请安装 ffmpeg 并加入 PATH，或在插件「设置」里填写 ffmpeg.exe 完整路径");

  const info = await getVideoInfo(bvid);
  if (!info.pages.length) throw new Error("E_NO_PAGE");
  const p = info.pages.find((x) => x.page === page) || info.pages[0];
  const dash = await getDashAudioUrl(bvid, p.cid);

  // 大小门禁：head 请求拿 content-length（音频流不一定给，但 DASH 多数会给）
  // 直接下载时再校验最终字节数
  const outDir = getAudioDir();
  const tmpM4s = path.join(outDir, `.tmp-${bvid}-p${p.page}-${Date.now()}.m4s`);
  const outM4a = path.join(outDir, `${safeFilename(info.title || bvid)} - p${p.page} - ${safeFilename(p.part)}.m4a`);

  // 1) 下载 DASH 音频
  const { stream } = await httpStream(dash.url);
  let total = 0;
  let aborted = false;
  const maxBytes = maxAudioBytes();
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmpM4s);
    stream.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        stream.destroy();
        ws.destroy();
        fs.rmSync(tmpM4s, { force: true });
        reject(new Error(`E_AUDIO_TOO_LARGE >${Math.round(maxBytes / 1048576)}MiB（登录后可放宽到 200MiB）`));
        return;
      }
      ws.write(chunk);
    });
    stream.on("end", () => ws.end());
    stream.on("error", (e) => { fs.rmSync(tmpM4s, { force: true }); reject(e); });
    ws.on("finish", resolve);
    ws.on("error", (e) => { fs.rmSync(tmpM4s, { force: true }); reject(e); });
  });
  if (aborted) return; // 已被上面 reject 跳出

  // 2) ffmpeg 转 M4A：dash 音频本身就是 m4s 容器（fmp4），用 -c:a copy 直接封 m4a 即可
  //    万一是裸 AAC 流就 re-encode；都走 copy 保持音质
  await new Promise((resolve, reject) => {
    execFile(ffp, [
      "-y",
      "-i", tmpM4s,
      "-c:a", "copy",
      "-movflags", "+faststart",
      outM4a,
    ], { windowsHide: true, timeout: 60000 }, (e, so, se) => {
      fs.rmSync(tmpM4s, { force: true });
      if (e) {
        // copy 失败 → 重试 re-encode（AAC-LC）
        execFile(ffp, [
          "-y",
          "-i", tmpM4s,
          "-c:a", "aac",
          "-b:a", "192k",
          "-movflags", "+faststart",
          outM4a,
        ], { windowsHide: true, timeout: 60000 }, (e2) => {
          if (e2) reject(new Error(`E_FFMPEG_FAILED: ${e.message} / re-encode: ${e2.message}`));
          else resolve();
        });
      } else resolve();
    });
  });

  const stat = await fsp.stat(outM4a);
  return {
    audioPath: outM4a,
    durationSec: p.durationSec || info.durationSec || 0,
    fileSize: stat.size,
    quality: dash.quality,
    bandwidth: dash.bandwidth,
    codecs: dash.codecs,
    title: info.title,
    author: info.author,
    page: p.page,
    part: p.part,
  };
}

// ---------------------------------------------------------------------------
// UI 配套：列已下载 / 打开文件 / 定位 / 删除
// ---------------------------------------------------------------------------
async function listDownloaded() {
  const audioDir = getAudioDir();
  const entries = await fsp.readdir(audioDir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!/\.m4a$/i.test(e.name)) continue;
    const full = path.join(audioDir, e.name);
    const st = await fsp.stat(full).catch(() => null);
    if (!st) continue;
    files.push({ name: e.name, path: full, size: st.size, mtime: st.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return { ok: true, files };
}

async function revealFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: "文件不存在" };
  const { shell } = require("electron");
  shell.showItemInFolder(filePath);
  return { ok: true };
}

async function openFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: "文件不存在" };
  const { shell } = require("electron");
  const err = await shell.openPath(filePath);
  if (err) return { ok: false, error: err };
  return { ok: true };
}

async function deleteFile(filePath) {
  if (!filePath) return { ok: false, error: "路径为空" };
  // 安全门禁：只允许删默认 audio/ 或用户设置的下载目录下的文件
  const resolved = path.resolve(filePath);
  const bases = [path.resolve(AUDIO_DIR), path.resolve(getAudioDir())];
  if (!bases.some((b) => resolved.startsWith(b + path.sep))) {
    return { ok: false, error: "只允许删除下载目录下的文件" };
  }
  try {
    await fsp.unlink(resolved);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// 扫码登录（v0.3.0）+ Cookie 刷新链
// ---------------------------------------------------------------------------
const BILI_QR_GENERATE = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
const BILI_QR_POLL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=";

// 官方 Web 端 Cookie 刷新公钥（1024-bit RSA，bilibili-API-collect 社区文档，1024 位模数已本地验证）
const BILI_REFRESH_PEM = [
  "-----BEGIN PUBLIC KEY-----",
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg",
  "Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71",
  "nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40",
  "JNrRuoEUXpabUzGB8QIDAQAB",
  "-----END PUBLIC KEY-----",
].join("\n");

/** correspondPath = RSA-OAEP-SHA256("refresh_<毫秒时间戳>") 的小写 hex */
function correspondPath(ts) {
  const enc = crypto.publicEncrypt(
    { key: BILI_REFRESH_PEM, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(`refresh_${ts}`)
  );
  return enc.toString("hex");
}

function stopLoginPolling() {
  if (loginSession && loginSession.timer) clearInterval(loginSession.timer);
  if (loginSession) loginSession.timer = null;
}

/** 发起扫码：生成二维码并启动 2s 轮询。返回 { qrContent } 给面板画码 */
async function loginStart() {
  await ensureBuvid();
  const { json } = await httpGetRaw(BILI_QR_GENERATE);
  if (!json || json.code !== 0 || !json.data || !json.data.qrcode_key) {
    throw new Error(`E_QR_GENERATE code=${json && json.code}`);
  }
  stopLoginPolling();
  loginSession = {
    qrcodeKey: json.data.qrcode_key,
    qrContent: json.data.url,
    phase: "waiting_scan",
    startedAt: Date.now(),
    timer: null,
  };
  loginSession.timer = setInterval(() => { loginPollOnce().catch(() => { /* 单次轮询失败忽略 */ }); }, 2000);
  loginPollOnce().catch(() => {});
  return { ok: true, qrContent: loginSession.qrContent, expiresInSec: 180 };
}

/** 一次轮询：86101 未扫 / 86090 已扫待确认 / 86038 失效 / 0 成功收 Cookie */
async function loginPollOnce() {
  if (!loginSession) return;
  const { json, setCookies } = await httpGetRaw(BILI_QR_POLL + encodeURIComponent(loginSession.qrcodeKey));
  const code = json && json.data && json.data.code;
  if (code === 0) {
    COOKIES = {
      SESSDATA: pickCookie(setCookies, "SESSDATA") || "",
      bili_jct: pickCookie(setCookies, "bili_jct") || "",
      DedeUserID: pickCookie(setCookies, "DedeUserID") || "",
      buvid3: (COOKIES && COOKIES.buvid3) || "",
      buvid4: (COOKIES && COOKIES.buvid4) || "",
      refresh_token: (json.data && json.data.refresh_token) || "",
      savedAt: Date.now(),
    };
    saveCookies();
    loginSession.phase = "success";
    stopLoginPolling();
  } else if (code === 86090) {
    loginSession.phase = "waiting_confirm";
  } else if (code === 86038) {
    loginSession.phase = "expired";
    stopLoginPolling();
  }
  // 86101 → 保持 waiting_scan
}

/** 状态查询（面板 1.5s 轮询 + LLM 工具共用） */
async function loginState() {
  if (loginSession && loginSession.phase !== "success") {
    return { phase: loginSession.phase, qrContent: loginSession.qrContent };
  }
  const c = loadCookies();
  if (!c || !c.SESSDATA) return { phase: "logged_out" };
  try {
    const json = await httpJson("https://api.bilibili.com/x/web-interface/nav");
    const d = (json && json.data) || {};
    if (json && json.code === 0 && d.isLogin) {
      maybeRefreshCookies().catch(() => { /* 刷新失败不影响登录态展示 */ });
      return {
        phase: "logged_in",
        user: { mid: d.mid, uname: d.uname || "", face: d.face || "", vip: d.vipStatus === 1 },
      };
    }
    return { phase: "expired" };
  } catch (e) {
    return { phase: "unknown", error: String((e && e.message) || e) };
  }
}

async function loginLogout() {
  stopLoginPolling();
  loginSession = null;
  clearCookies();
  return { ok: true };
}

/**
 * Cookie 到期刷新（官方链路，SESSDATA 约 30 天有效）：
 * cookie/info(refresh=true) → correspondPath → correspond/1/<path> 取 refresh_csrf
 * → cookie/refresh 换新 Cookie + 新 refresh_token → confirm/refresh 使旧 token 失效
 */
async function maybeRefreshCookies() {
  if (refreshAttempted) return;
  const c = loadCookies();
  if (!c || !c.SESSDATA) return;
  refreshAttempted = true; // 无论成败，本进程只试一次，防循环
  const oldRefreshToken = c.refresh_token || "";
  try {
    const { json: info } = await httpGetRaw("https://passport.bilibili.com/x/passport-login/web/cookie/info");
    if (!info || info.code !== 0 || !info.data || !info.data.refresh) return;
    const cp = correspondPath(info.data.timestamp);
    const { status, text } = await httpGetText(`https://www.bilibili.com/correspond/1/${cp}`);
    if (status !== 200) throw new Error(`E_CORRESPOND_HTTP_${status}`);
    const m = text.match(/<div[^>]*id="1-name"[^>]*>([^<]+)</);
    if (!m) throw new Error("E_REFRESH_CSRF_NOT_FOUND");
    const { json: refreshed, setCookies } = await httpPostForm(
      "https://passport.bilibili.com/x/passport-login/web/cookie/refresh",
      { csrf: c.bili_jct || "", refresh_csrf: m[1].trim(), source: "main_web", refresh_token: oldRefreshToken }
    );
    if (!refreshed || refreshed.code !== 0) {
      throw new Error(`E_REFRESH_FAILED code=${refreshed && refreshed.code} msg=${refreshed && refreshed.message}`);
    }
    COOKIES.SESSDATA = pickCookie(setCookies, "SESSDATA") || COOKIES.SESSDATA;
    COOKIES.bili_jct = pickCookie(setCookies, "bili_jct") || COOKIES.bili_jct;
    COOKIES.DedeUserID = pickCookie(setCookies, "DedeUserID") || COOKIES.DedeUserID;
    COOKIES.refresh_token = (refreshed.data && refreshed.data.refresh_token) || oldRefreshToken;
    saveCookies();
    // 确认步：新 csrf + 旧 refresh_token，使旧会话失效
    await httpPostForm(
      "https://passport.bilibili.com/x/passport-login/web/confirm/refresh",
      { csrf: COOKIES.bili_jct || "", refresh_token: oldRefreshToken }
    );
    ctxLogSafe("B 站 Cookie 已自动刷新");
  } catch {
    ctxLogSafe("B 站 Cookie 自动刷新失败（不影响当前登录态；失效后请重新扫码）");
  }
}

function ctxLogSafe(msg) {
  try { if (typeof pluginCtxRef !== "undefined" && pluginCtxRef) pluginCtxRef.log(msg); } catch { /* noop */ }
}

// ---------------------------------------------------------------------------
// UI 窗口：open() 时弹出
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 内置播放器实现（隐藏窗口，语音听歌出声层）
// 设计：不依赖宿主音乐服务（其网易云 OpenAPI 未配置时主进程门禁会拦），
// 用一个 show:false 的 BrowserWindow 里的 <audio> 出声，主进程发指令、
// 收 ended 事件自动切队列下一首。
// ---------------------------------------------------------------------------
let playerEventBound = false; // ipcMain 事件只绑一次（插件可能多次 register）

function ensurePlayerWin() {
  const { BrowserWindow } = require("electron");
  if (playerWin && !playerWin.isDestroyed()) return playerWin;
  playerWin = new BrowserWindow({
    show: false,
    width: 2,
    height: 2,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  playerLoaded = false;
  playerWin.on("closed", () => {
    playerWin = null;
    playerLoaded = false;
    currentTrack = null;
    playQueue.length = 0;
  });
  return playerWin;
}

/** 播一个曲目对象（已确保窗口与页面就绪） */
async function playerPlayNow(item) {
  const win = ensurePlayerWin();
  if (!playerLoaded) {
    await win.loadFile(path.join(__dirname, "player.html"));
    playerLoaded = true;
  }
  currentTrack = item;
  win.webContents.send("plugin:bili-music:player-cmd", { action: "load", url: pathToFileURL(item.path).href });
  return true;
}

/** audio 播完 → 自动切队列下一首（无队尾则清 current） */
function onTrackEnded() {
  const next = playQueue.shift();
  if (next) {
    playerPlayNow(next).catch((e) => { lastPlayerError = String(e && e.message || e); });
  } else {
    currentTrack = null;
  }
}

function bindPlayerEvents() {
  if (playerEventBound) return;
  const { ipcMain } = require("electron");
  ipcMain.on(CH_PLAYER_ENDED, onTrackEnded);
  ipcMain.on(CH_PLAYER_EVENT, (_e, ev) => {
    if (ev && ev.type === "error") lastPlayerError = String(ev.message || ev);
  });
  playerEventBound = true;
}

function unbindPlayerEvents() {
  if (!playerEventBound) return;
  const { ipcMain } = require("electron");
  ipcMain.removeListener(CH_PLAYER_ENDED, onTrackEnded);
  playerEventBound = false;
}

/** 入队或立即播放；返回给 LLM 的播放描述 */
async function enqueueOrPlay(item, enqueueOnly) {
  if (enqueueOnly || (currentTrack && playerWin && !playerWin.isDestroyed())) {
    playQueue.push(item);
    return { playing: false, queued: true, queueLength: playQueue.length };
  }
  await playerPlayNow(item);
  return { playing: true, queued: false, queueLength: playQueue.length };
}

/** 播放控制：pause/resume/stop/next/volume/status */
async function playerControl(action, value) {
  if (action === "status") {
    const base = {
      hasPlayer: !!(playerWin && !playerWin.isDestroyed()),
      current: currentTrack ? { title: currentTrack.title, author: currentTrack.author || "" } : null,
      queueLength: playQueue.length,
      lastError: lastPlayerError || "",
    };
    if (!playerWin || playerWin.isDestroyed() || !playerLoaded) {
      return { ...base, playing: false, paused: false, currentTime: 0, duration: 0, volume: 1 };
    }
    try {
      const s = await playerWin.webContents.executeJavaScript(
        "typeof playerStatus === 'function' ? playerStatus() : null", true);
      return { ...base, ...(s || {}), playing: !!(s && s.hasSrc && !s.paused) };
    } catch (e) {
      return { ...base, playing: false, probeError: String(e && e.message || e) };
    }
  }
  if (!playerWin || playerWin.isDestroyed() || !playerLoaded) {
    if (action === "stop") { playQueue.length = 0; currentTrack = null; return { ok: true, stopped: true }; }
    throw new Error("E_PLAYER_NOT_ACTIVE");
  }
  switch (action) {
    case "pause":
      playerWin.webContents.send("plugin:bili-music:player-cmd", { action: "pause" });
      return { ok: true, paused: true };
    case "resume":
      playerWin.webContents.send("plugin:bili-music:player-cmd", { action: "resume" });
      return { ok: true, resumed: true };
    case "stop":
      playQueue.length = 0;
      currentTrack = null;
      playerWin.webContents.send("plugin:bili-music:player-cmd", { action: "stop" });
      return { ok: true, stopped: true, queueCleared: true };
    case "next": {
      const next = playQueue.shift();
      if (!next) {
        currentTrack = null;
        playerWin.webContents.send("plugin:bili-music:player-cmd", { action: "stop" });
        return { ok: true, skipped: true, queueEmpty: true };
      }
      await playerPlayNow(next);
      return { ok: true, playing: true, title: next.title, queueLength: playQueue.length };
    }
    case "volume": {
      const v = Math.min(100, Math.max(0, Math.floor(Number(value) || 0)));
      playerWin.webContents.send("plugin:bili-music:player-cmd", { action: "volume", value: v / 100 });
      return { ok: true, volume: v };
    }
    default:
      throw new Error("E_INVALID_ACTION");
  }
}

async function openWindow() {
  if (pluginWin && !pluginWin.isDestroyed()) {
    pluginWin.focus();
    return;
  }
  const { BrowserWindow, ipcMain } = require("electron");
  pluginWin = new BrowserWindow({
    width: 880,
    height: 680,
    minWidth: 520,
    minHeight: 480,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#f7f9fc",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  const onMin = () => { if (pluginWin && !pluginWin.isDestroyed()) pluginWin.minimize(); };
  const onClose = () => { if (pluginWin && !pluginWin.isDestroyed()) pluginWin.close(); };
  ipcMain.on(CH_MIN, onMin);
  ipcMain.on(CH_CLOSE, onClose);
  pluginWin.on("closed", () => {
    ipcMain.removeListener(CH_MIN, onMin);
    ipcMain.removeListener(CH_CLOSE, onClose);
    pluginWin = null;
  });
  await pluginWin.loadFile(path.join(__dirname, "ui.html"));
}

// ---------------------------------------------------------------------------
// 工具注册
// ---------------------------------------------------------------------------
const biliMusicPlugin = {
  register(ctx) {
    pluginCtxRef = ctx;
    // ----- IPC（弹窗 UI 调用） -----
    ctx.registerIpc("search", async (keyword, limit) => {
      try {
        const kw = String(keyword || "").trim();
        if (!kw) return { ok: false, error: "请输入关键词" };
        if (kw.length > 100) return { ok: false, error: "关键词过长" };
        const items = await searchVideos(kw, Number(limit) || 10);
        return { ok: true, keyword: kw, items };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
    ctx.registerIpc("videoInfo", async (bvid) => {
      try {
        const info = await getVideoInfo(String(bvid || ""));
        return { ok: true, ...info };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
    ctx.registerIpc("play", async (bvid, page) => {
      try {
        const r = await downloadAndTranscode({
          bvid: String(bvid || ""),
          page: Math.max(1, Math.floor(Number(page) || 1)),
          title: "",
        });
        return { ok: true, ...r };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
    ctx.registerIpc("probeFfmpeg", async () => {
      const p = await findFfmpeg();
      if (!p) return { ok: true, available: false, hint: "未找到 ffmpeg。可在下方「设置」里填 ffmpeg.exe 完整路径，或安装后加入 PATH。" };
      const ver = await getFfmpegVersion(p);
      // 版本都拿不到说明 spawn 必挂（路径假存在/乱码），不算可用
      if (!ver) return { ok: true, available: false, hint: `ffmpeg 路径无效（无法执行）：${p}，请在「设置」里修正。` };
      return { ok: true, available: true, path: p, version: ver };
    });
    // 一键安装 ffmpeg（npmmirror 镜像 → DATA_DIR/bin → 自动配置）
    ctx.registerIpc("installFfmpeg", async () => {
      try { return await installFfmpeg(); }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    });
    ctx.registerIpc("getSettings", async () => {
      const s = loadSettings();
      return { ok: true, ffmpegPath: s.ffmpegPath, downloadDir: s.downloadDir, defaultAudioDir: AUDIO_DIR };
    });
    ctx.registerIpc("saveSettings", async (next) => {
      try { return saveSettings(next || {}); }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    });
    // 弹「我的电脑」目录选择框（父窗口 = 插件面板）
    ctx.registerIpc("pickDirectory", async () => {
      try {
        const { dialog } = require("electron");
        const r = await dialog.showOpenDialog(pluginWin, {
          title: "选择下载目录",
          properties: ["openDirectory", "createDirectory"],
        });
        if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
        return { ok: true, path: r.filePaths[0] };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
    // 弹文件选择框选 ffmpeg.exe
    ctx.registerIpc("pickFfmpeg", async () => {
      try {
        const { dialog } = require("electron");
        const r = await dialog.showOpenDialog(pluginWin, {
          title: "选择 ffmpeg.exe",
          properties: ["openFile"],
          filters: [{ name: "ffmpeg.exe", extensions: ["exe"] }],
        });
        if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
        return { ok: true, path: r.filePaths[0] };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
    ctx.registerIpc("listDownloaded", () => listDownloaded());
    ctx.registerIpc("revealFile", (filePath) => revealFile(filePath));
    ctx.registerIpc("openFile", (filePath) => openFile(filePath));
    ctx.registerIpc("deleteFile", (filePath) => deleteFile(filePath));
    // UI「播放」按钮：走内置播放器（系统播放器会和语音听歌抢声道）
    ctx.registerIpc("playLocalFile", async (filePath) => {
      try {
        const st = await fsp.stat(String(filePath || "")).catch(() => null);
        if (!st) return { ok: false, error: "文件不存在" };
        const r = await enqueueOrPlay({ path: String(filePath), title: path.basename(String(filePath)), author: "" }, false);
        return { ok: true, ...r };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
    // ----- 扫码登录 IPC -----
    ctx.registerIpc("loginStart", async () => {
      try { return await loginStart(); }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    });
    ctx.registerIpc("loginState", async () => {
      try { return { ok: true, ...(await loginState()) }; }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    });
    ctx.registerIpc("loginLogout", async () => {
      try { return await loginLogout(); }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    });
    bindPlayerEvents();
    // 工具 1：搜索
    ctx.registerTool({
      id: "bili-music_search",
      name: "搜索 B 站歌曲候选",
      description:
        "按关键词在 B 站搜索视频，返回最多 N 条候选（标题、UP主、时长、播放量、bvid）。时长超过 15 分钟的会标记为「仅可下载」。用 LLM 直听或下载前必先调用本工具获取候选再选定。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "搜索关键词（1-100 字）" },
          limit:   { type: "number", description: "返回候选数（1-20，默认 10）" },
        },
        required: ["keyword"],
      },
      async execute(args) {
        const kw = String(args.keyword || "").trim();
        if (!kw) throw new Error("E_INVALID_KEYWORD_EMPTY");
        if (kw.length > 100) throw new Error("E_INVALID_KEYWORD_TOO_LONG");
        const items = await searchVideos(kw, args.limit);
        return JSON.stringify({
          kind: "search",
          keyword: kw,
          total: items.length,
          items: items.map((v) => ({
            bvid: v.bvid,
            title: v.title,
            author: v.author,
            durationSec: v.durationSec,
            durationStr: v.durationStr || formatDuration(v.durationSec),
            playCount: v.playCount,
            url: v.url,
            over15min: v.durationSec > 15 * 60,
          })),
        });
      },
    });

    // 工具 2：精确视频 + 分P列表
    ctx.registerTool({
      id: "bili-music_video_info",
      name: "查看 B 站视频分 P",
      description:
        "输入 BV 号，列出该视频全部可交付的分 P（cid/分P名/时长）。用户给了精确视频 URL 或 AV/BV 号时使用，列出分 P 后让用户选一个再调 bili-music_play。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          bvid: { type: "string", description: "B 站视频 BV 号（BV1xxxxxxxxxx）" },
        },
        required: ["bvid"],
      },
      async execute(args) {
        const info = await getVideoInfo(args.bvid);
        return JSON.stringify({
          kind: "video_info",
          bvid: info.bvid,
          title: info.title,
          author: info.author,
          durationSec: info.durationSec,
          pages: info.pages.map((p) => ({
            page: p.page,
            cid: p.cid,
            part: p.part,
            durationSec: p.durationSec,
            over15min: p.durationSec > 15 * 60,
          })),
        });
      },
    });

    // 工具 3：下载 + 转码 + 播放（语音听歌主入口）
    ctx.registerTool({
      id: "bili-music_play",
      name: "下载 B 站音频并用内置播放器播放",
      description:
        "下载指定 BV 号 + 分 P 的 DASH 音频流，用 ffmpeg 转 M4A，然后用内置播放器直接出声（语音听歌）。默认立即播放；正在播放时新的点播自动入队，播完自动切下一首。传 enqueueOnly=true 只入队不插播。匿名可用，无需登录。单个分 P > 50 MiB 直接拒绝。",
      enabled: true,
      risk: "mutation",
      effectKind: "external_side_effect",
      inputSchema: {
        type: "object",
        properties: {
          bvid: { type: "string", description: "B 站视频 BV 号（BV1xxxxxxxxxx）" },
          page: { type: "number", description: "分 P 索引（默认 1，video_info 工具的 page 字段）" },
          enqueueOnly: { type: "boolean", description: "true=只加入队列不立即播放（默认 false 立即播）" },
        },
        required: ["bvid"],
      },
      async execute(args) {
        const bvid = String(args.bvid || "");
        const page = Math.max(1, Math.floor(Number(args.page) || 1));
        const result = await downloadAndTranscode({ bvid, page, title: "" });
        const item = {
          path: result.audioPath,
          title: result.title || result.part || path.basename(result.audioPath),
          author: result.author || "",
        };
        const playback = await enqueueOrPlay(item, !!args.enqueueOnly);
        return JSON.stringify({
          kind: "playback_ready",
          ...playback,
          audioPath: result.audioPath,
          title: result.title,
          author: result.author,
          page: result.page,
          part: result.part,
          durationSec: result.durationSec,
          fileSize: result.fileSize,
          quality: result.quality,
          bandwidth: result.bandwidth,
          codecs: result.codecs,
        });
      },
    });

    // 工具 4：播放控制
    ctx.registerTool({
      id: "bili-music_playback",
      name: "B 站听歌播放控制",
      description:
        "控制内置播放器：pause 暂停 / resume 继续 / stop 停止并清空队列 / next 跳到队列下一首 / volume 调音量(0-100) / status 查询当前播放与队列状态。用户说「暂停/继续/下一首/声音大点/小点/现在放的什么」时使用。",
      enabled: true,
      risk: "safe",
      effectKind: "external_side_effect",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["pause", "resume", "stop", "next", "volume", "status"],
            description: "控制动作",
          },
          value: { type: "number", description: "volume 时的音量 0-100（其他动作不需要）" },
        },
        required: ["action"],
      },
      async execute(args) {
        const r = await playerControl(String(args.action || ""), args.value);
        return JSON.stringify({ kind: "playback_control", action: String(args.action || ""), ...r });
      },
    });

    // 工具 5：ffmpeg 体检
    ctx.registerTool({
      id: "bili-music_probe_ffmpeg",
      name: "检查 ffmpeg 可用性",
      description:
        "体检本机 ffmpeg：尝试从 PATH / 常见 Windows 安装路径查找，返回路径与版本。bili-music_play 前置依赖。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        const p = await findFfmpeg();
        if (!p) return JSON.stringify({ kind: "ffmpeg", available: false, hint: "请安装 ffmpeg：https://www.gyan.dev/ffmpeg/builds/ ，并把 bin 加到 PATH，或放到 C:\\ffmpeg\\bin\\ffmpeg.exe" });
        const ver = await getFfmpegVersion(p);
        return JSON.stringify({ kind: "ffmpeg", available: true, path: p, version: ver });
      },
    });

    // 工具 6：B 站登录状态
    ctx.registerTool({
      id: "bili-music_login_status",
      name: "查询 B 站登录状态",
      description:
        "查询本插件的 B 站扫码登录状态：logged_in（含昵称与大会员标记）/ logged_out / expired。用户问「B站登录了吗」「用的什么账号」时调用。登录入口在插件面板（打开 B 站听歌窗口 → 账号卡片 → 扫码登录），面板操作即可，无需你代为执行。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        const s = await loginState();
        return JSON.stringify({
          kind: "login_status",
          ...s,
          benefit: s.phase === "logged_in" ? "已登录：高码率音源 + 200MiB 体积门禁" : "未登录：匿名低码率 + 50MiB 体积门禁",
        });
      },
    });

    ctx.log("B 站听歌插件已注册: bili-music_search / bili-music_video_info / bili-music_play / bili-music_playback / bili-music_probe_ffmpeg / bili-music_login_status");
  },

  async open() {
    await openWindow();
  },
  async unregister() {
    stopLoginPolling();
    loginSession = null;
    if (playerWin && !playerWin.isDestroyed()) playerWin.destroy();
    playerWin = null;
    playerLoaded = false;
    currentTrack = null;
    playQueue.length = 0;
    unbindPlayerEvents();
    if (pluginWin && !pluginWin.isDestroyed()) pluginWin.close();
  },
};

module.exports = biliMusicPlugin;
module.exports.default = biliMusicPlugin;
