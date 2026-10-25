"use strict";

/**
 * GitHub 令牌保险箱
 *
 * 设计原则：
 * 1. 令牌只保存在本机插件存储里；Windows 下优先用 Electron safeStorage（DPAPI）加密。
 * 2. 默认不给 Agent 明文，而是提供 github 请求代理：Agent 只说「请求哪个路径」，
 *    令牌在插件内部拼接，永远不会出现在工具返回值里。
 * 3. 明文读取单独做成一个工具，描述里写明风险；只在用户明确要求时才调用。
 */

const path = require("node:path");
const https = require("node:https");

let BrowserWindowClass = null;
try {
  BrowserWindowClass = require("electron").BrowserWindow;
} catch {
  BrowserWindowClass = null;
}

const TOKEN_KEY = "githubToken";
const CH = "plugin:gh-vault:";
const MAX_BODY_CHARS = 8000;
const MAX_RESPONSE_BYTES = 400000;

let ctxRef = null;
let panelWin = null;

/* ------------------------------ 存储 ------------------------------ */

function getSafeStorage() {
  try {
    const electron = require("electron");
    const safeStorage = electron.safeStorage;
    if (safeStorage && safeStorage.isEncryptionAvailable()) return safeStorage;
  } catch {
    /* 环境不支持时退回明文存储 */
  }
  return null;
}

async function readRecord() {
  if (!ctxRef) return null;
  try {
    const raw = await ctxRef.storage.get(TOKEN_KEY);
    if (!raw || typeof raw !== "object" || typeof raw.data !== "string" || !raw.data) return null;

    let value = raw.data;
    if (raw.enc) {
      const safeStorage = getSafeStorage();
      if (!safeStorage) return null;
      try {
        value = safeStorage.decryptString(Buffer.from(raw.data, "base64"));
      } catch {
        return null;
      }
    }
    if (!value) return null;
    return {
      value,
      enc: Boolean(raw.enc),
      label: typeof raw.label === "string" ? raw.label : "",
      updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0,
    };
  } catch {
    return null;
  }
}

async function writeRecord(value, label) {
  if (!ctxRef) throw new Error("插件尚未就绪");
  const safeStorage = getSafeStorage();
  const record = {
    v: 2,
    enc: Boolean(safeStorage),
    data: safeStorage ? safeStorage.encryptString(value).toString("base64") : value,
    label: typeof label === "string" ? label.slice(0, 60) : "",
    updatedAt: Date.now(),
  };
  await ctxRef.storage.set(TOKEN_KEY, record);
  return record;
}

async function clearRecord() {
  if (!ctxRef) return;
  await ctxRef.storage.set(TOKEN_KEY, null);
}

function maskToken(value) {
  const text = String(value || "");
  if (!text) return "";
  const tail = text.slice(-4);
  const head = text.startsWith("github_pat_") ? "github_pat_" : text.slice(0, 4);
  return head + "••••••••" + tail;
}

function formatTime(ms) {
  if (!ms) return "未知";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}

/* ------------------------------ 网络 ------------------------------ */

function normalizeApiPath(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("缺少 path，例如 /user");
  if (raw.indexOf("://") >= 0) throw new Error("path 只接受 / 开头的 GitHub API 路径，不能是完整网址");
  if (/[\r\n\s]/.test(raw)) throw new Error("path 里不能有空白字符");
  const withSlash = raw.startsWith("/") ? raw : "/" + raw;
  return withSlash;
}

function githubRequest(token, method, apiPath, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const bodyText = payload === undefined || payload === null ? "" : JSON.stringify(payload);
    const headers = {
      Authorization: "Bearer " + token,
      "User-Agent": "cyrene-gh-vault",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (bodyText) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(bodyText);
    }

    const req = https.request(
      {
        hostname: "api.github.com",
        path: apiPath,
        method: method,
        headers: headers,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
          if (data.length > MAX_RESPONSE_BYTES) req.destroy(new Error("响应体过大，已中断"));
        });
        res.on("end", () => {
          resolve({ status: res.statusCode || 0, headers: res.headers || {}, body: data });
        });
      }
    );

    req.setTimeout(timeoutMs || 20000, () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    if (bodyText) req.write(bodyText);
    req.end();
  });
}

function scrub(text, token) {
  let out = String(text == null ? "" : text);
  if (token) out = out.split(token).join("[REDACTED]");
  return out;
}

/* ------------------------------ 面板 ------------------------------ */

async function openPanel() {
  if (!BrowserWindowClass) throw new Error("当前环境拿不到 BrowserWindow，无法打开面板");
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.show();
    panelWin.focus();
    return;
  }
  panelWin = new BrowserWindowClass({
    width: 480,
    height: 460,
    minWidth: 420,
    minHeight: 420,
    title: "GitHub 令牌保险箱",
    autoHideMenuBar: true,
    backgroundColor: "#fff9fc",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  panelWin.on("closed", () => {
    panelWin = null;
  });
  await panelWin.loadFile(path.join(__dirname, "panel.html"));
}

/* ------------------------------ 工具 ------------------------------ */

function toolStatus() {
  return {
    id: "gh-vault_status",
    name: "查看 GitHub 令牌状态",
    description:
      "查看是否已保存 GitHub 令牌、掩码、保存时间与加密方式。不会返回令牌明文，需要明文请用 gh-vault_reveal。",
    enabled: true,
    risk: "safe",
    effectKind: "read",
    inputSchema: { type: "object", properties: {}, required: [] },
    async execute() {
      const rec = await readRecord();
      if (!rec) return "还没有保存 GitHub 令牌。可以让用户在「GitHub 令牌保险箱」面板里填入。";
      return [
        "已保存 GitHub 令牌",
        "掩码：" + maskToken(rec.value),
        rec.label ? "备注：" + rec.label : "",
        "保存时间：" + formatTime(rec.updatedAt),
        "存储方式：" + (rec.enc ? "本机 DPAPI 加密（Electron safeStorage）" : "本机明文存储（当前环境不支持系统加密）"),
      ]
        .filter(Boolean)
        .join("\n");
    },
  };
}

function toolApi() {
  return {
    id: "gh-vault_api",
    name: "代发 GitHub API 请求",
    description:
      "用本机保存的 GitHub 令牌请求 api.github.com，令牌由插件内部拼接、不会出现在返回结果里。需要查仓库、建分支、提 PR、查用户信息时优先用这个工具。path 传 / 开头的 API 路径，例如 /user 或 /repos/owner/repo。",
    enabled: true,
    risk: "write",
    effectKind: "network",
    inputSchema: {
      type: "object",
      properties: {
        method: {
          type: "string",
          description: "HTTP 方法：GET / POST / PATCH / PUT / DELETE，默认 GET",
        },
        path: {
          type: "string",
          description: "GitHub REST API 路径，以 / 开头，例如 /user、/repos/Playa-Cyrene/Cyrene-Plugins/pulls",
        },
        body: {
          type: "object",
          description: "可选，请求体对象（POST/PATCH/PUT 时使用）",
        },
      },
      required: ["path"],
    },
    async execute(args) {
      const rec = await readRecord();
      if (!rec) return "还没有保存 GitHub 令牌，先让用户在保险箱面板里填入。";

      const method = String((args && args.method) || "GET").toUpperCase();
      if (["GET", "POST", "PATCH", "PUT", "DELETE"].indexOf(method) < 0) {
        return "不支持的 HTTP 方法：" + method;
      }
      let apiPath;
      try {
        apiPath = normalizeApiPath(args && args.path);
      } catch (error) {
        return String(error && error.message ? error.message : error);
      }

      let res;
      try {
        res = await githubRequest(rec.value, method, apiPath, args ? args.body : undefined, 25000);
      } catch (error) {
        return "请求失败：" + String(error && error.message ? error.message : error);
      }

      const body = scrub(res.body, rec.value);
      const trimmed = body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) + "\n…（已截断）" : body;
      const scope = res.headers["x-oauth-scopes"] ? "\nscopes: " + res.headers["x-oauth-scopes"] : "";
      return "HTTP " + res.status + " " + method + " " + apiPath + scope + "\n" + (trimmed || "（空响应）");
    },
  };
}

function toolReveal() {
  return {
    id: "gh-vault_reveal",
    name: "取出 GitHub 令牌明文",
    description:
      "返回本机保存的 GitHub 令牌明文。只在用户明确要求「把令牌显示出来 / 我要核对令牌」时调用；返回值会进入本轮对话上下文并留在记录里，无法撤回。日常操作请改用 gh-vault_api。",
    enabled: true,
    risk: "read",
    effectKind: "read",
    inputSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "string",
          description: "必须传 REVEAL 才会返回明文，用于二次确认",
        },
      },
      required: ["confirm"],
    },
    async execute(args) {
      const confirm = String((args && args.confirm) || "").trim().toUpperCase();
      if (confirm !== "REVEAL") return "没有确认，已取消。需要明文时请传 confirm: \"REVEAL\"。";
      const rec = await readRecord();
      if (!rec) return "还没有保存 GitHub 令牌。";
      return rec.value;
    },
  };
}

function toolClear() {
  return {
    id: "gh-vault_clear",
    name: "删除保存的 GitHub 令牌",
    description: "删除本机保存的 GitHub 令牌。用户要求撤销或更换令牌时使用。",
    enabled: true,
    risk: "write",
    effectKind: "write",
    inputSchema: {
      type: "object",
      properties: {
        confirm: { type: "string", description: "必须传 DELETE 才会删除" },
      },
      required: ["confirm"],
    },
    async execute(args) {
      const confirm = String((args && args.confirm) || "").trim().toUpperCase();
      if (confirm !== "DELETE") return "没有确认，已取消。需要删除时请传 confirm: \"DELETE\"。";
      await clearRecord();
      return "已删除保存的 GitHub 令牌。";
    },
  };
}

/* ------------------------------ 生命周期 ------------------------------ */

module.exports = {
  async open() {
    await openPanel();
  },

  async register(ctx) {
    ctxRef = ctx;

    ctx.registerTool(toolStatus());
    ctx.registerTool(toolApi());
    ctx.registerTool(toolReveal());
    ctx.registerTool(toolClear());

    ctx.registerIpc("state", async () => {
      const rec = await readRecord();
      return {
        saved: Boolean(rec),
        masked: rec ? maskToken(rec.value) : "",
        label: rec ? rec.label : "",
        enc: rec ? rec.enc : Boolean(getSafeStorage()),
        updatedAt: rec ? formatTime(rec.updatedAt) : "",
      };
    });

    ctx.registerIpc("save", async (payload) => {
      const token = String((payload && payload.token) || "").trim();
      const label = String((payload && payload.label) || "").trim();
      if (!token) return { ok: false, message: "令牌不能为空" };
      if (!/^(ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{10,}$/.test(token)) {
        return { ok: false, message: "看起来不是有效的 GitHub 令牌（应以 ghp_ 或 github_pat_ 开头）" };
      }
      await writeRecord(token, label);
      return { ok: true, message: "已保存", masked: maskToken(token) };
    });

    ctx.registerIpc("test", async () => {
      const rec = await readRecord();
      if (!rec) return { ok: false, message: "还没有保存令牌" };
      try {
        const res = await githubRequest(rec.value, "GET", "/user", undefined, 15000);
        if (res.status !== 200) return { ok: false, message: "HTTP " + res.status + "，令牌可能无效或权限不足" };
        const data = JSON.parse(res.body || "{}");
        return { ok: true, message: "连接正常", login: data.login || "", scopes: res.headers["x-oauth-scopes"] || "" };
      } catch (error) {
        return { ok: false, message: "请求失败：" + String(error && error.message ? error.message : error) };
      }
    });

    ctx.registerIpc("clear", async () => {
      await clearRecord();
      return { ok: true, message: "已删除" };
    });

    ctx.log("GitHub 令牌保险箱已注册：gh-vault_status / gh-vault_api / gh-vault_reveal / gh-vault_clear");
  },

  unregister() {
    if (panelWin && !panelWin.isDestroyed()) panelWin.close();
    panelWin = null;
  },
};

module.exports.default = module.exports;
