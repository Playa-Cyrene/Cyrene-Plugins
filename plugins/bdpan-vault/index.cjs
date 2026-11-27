"use strict";

/**
 * 百度网盘 API 保险箱
 *
 * 设计原则：
 * 1. Key 只保存在本机插件存储里；Windows 下优先用 Electron safeStorage（DPAPI）加密。
 * 2. 默认不给 Agent 明文，而是提供请求代理：Agent 只说「请求哪个主机、哪条路径」，
 *    Key 在插件内部拼接，永远不会出现在工具返回值里。
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

const KEY = "bdpanApiKey";
const CH = "plugin:bdpan-vault:";
const MAX_BODY_CHARS = 8000;
const MAX_RESPONSE_BYTES = 400000;

const ALLOWED_HOSTS = [
  "pan.baidu.com",
  "openapi.baidu.com",
  "aippt.baidu.com",
  "apaas.baidu.com",
  "d.pcs.baidu.com",
  "pcs.baidu.com",
  "yun.baidu.com",
];

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
    const raw = await ctxRef.storage.get(KEY);
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
  await ctxRef.storage.set(KEY, record);
  return record;
}

async function clearRecord() {
  if (!ctxRef) return;
  await ctxRef.storage.set(KEY, null);
}

function maskKey(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "••••••••";
  const head = text.slice(0, 7);
  const tail = text.slice(-4);
  return head + "••••" + tail;
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

function normalizePath(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("缺少 path，例如 /rest/2.0/xpan/nas");
  if (raw.indexOf("://") >= 0) throw new Error("path 只接受 / 开头的路径，不能是完整网址");
  if (/[\r\n\s]/.test(raw)) throw new Error("path 里不能有空白字符");
  return raw.startsWith("/") ? raw : "/" + raw;
}

function buildQuery(query) {
  if (!query) return "";
  if (typeof query === "string") return query.replace(/^\?/, "");
  if (typeof query === "object") {
    const params = new URLSearchParams();
    Object.keys(query).forEach((k) => {
      const v = query[k];
      if (v !== undefined && v !== null) params.append(k, String(v));
    });
    return params.toString();
  }
  return "";
}

function apiRequest(apiKey, opts) {
  return new Promise((resolve, reject) => {
    const host = String(opts.host || "pan.baidu.com")
      .trim()
      .toLowerCase();
    if (ALLOWED_HOSTS.indexOf(host) < 0) {
      reject(new Error("不允许的主机：" + host + "（白名单：" + ALLOWED_HOSTS.join(", ") + "）"));
      return;
    }

    const method = String(opts.method || "GET").toUpperCase();
    if (["GET", "POST", "PUT", "PATCH", "DELETE"].indexOf(method) < 0) {
      reject(new Error("不支持的 HTTP 方法：" + method));
      return;
    }

    let apiPath;
    try {
      apiPath = normalizePath(opts.path);
    } catch (error) {
      reject(error);
      return;
    }

    const auth = String(opts.auth || "bearer").toLowerCase();
    let qs = buildQuery(opts.query);
    const headers = { "User-Agent": "cyrene-bdpan-vault" };

    if (auth === "bearer") headers["Authorization"] = "Bearer " + apiKey;
    else if (auth === "header") headers["X-API-Key"] = apiKey;
    else if (auth === "query") {
      const kv = "api_key=" + encodeURIComponent(apiKey);
      qs = qs ? qs + "&" + kv : kv;
    }

    const bodyText =
      opts.body === undefined || opts.body === null
        ? ""
        : typeof opts.body === "string"
          ? opts.body
          : JSON.stringify(opts.body);

    if (bodyText) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(bodyText);
    }

    const req = https.request(
      {
        hostname: host,
        path: apiPath + (qs ? "?" + qs : ""),
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
          resolve({ status: res.statusCode || 0, headers: res.headers || {}, body: data, host, apiPath });
        });
      }
    );

    req.setTimeout(Number(opts.timeoutMs) || 20000, () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    if (bodyText) req.write(bodyText);
    req.end();
  });
}

function scrub(text, apiKey) {
  let out = String(text == null ? "" : text);
  if (apiKey) out = out.split(apiKey).join("[REDACTED]");
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
    height: 520,
    minWidth: 420,
    minHeight: 460,
    title: "百度网盘 API 保险箱",
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
    id: "bdpan-vault_status",
    name: "查看百度网盘 API Key 状态",
    description:
      "查看是否已保存百度网盘 API Key、掩码、保存时间与加密方式。不会返回 Key 明文，需要明文请用 bdpan-vault_reveal。",
    enabled: true,
    risk: "safe",
    effectKind: "read",
    inputSchema: { type: "object", properties: {}, required: [] },
    async execute() {
      const rec = await readRecord();
      if (!rec) return "还没有保存百度网盘 API Key。可以让用户在「百度网盘 API 保险箱」面板里填入。";
      return [
        "已保存百度网盘 API Key",
        "掩码：" + maskKey(rec.value),
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
    id: "bdpan-vault_api",
    name: "代发百度网盘 API 请求",
    description:
      "用本机保存的百度网盘 API Key 发起请求，Key 由插件内部拼接、不会出现在返回结果里。需要调用百度网盘 AI 能力或开放平台接口时优先用这个工具。host 只允许白名单（pan.baidu.com、openapi.baidu.com、aippt.baidu.com、apaas.baidu.com 等）；path 传 / 开头的路径；auth 可选 bearer / header / query / none。",
    enabled: true,
    risk: "write",
    effectKind: "network",
    inputSchema: {
      type: "object",
      properties: {
        host: {
          type: "string",
          description: "目标主机，默认 pan.baidu.com；必须是白名单内的主机",
        },
        method: {
          type: "string",
          description: "HTTP 方法：GET / POST / PUT / PATCH / DELETE，默认 GET",
        },
        path: {
          type: "string",
          description: "接口路径，以 / 开头，例如 /rest/2.0/xpan/nas",
        },
        query: {
          type: "object",
          description: "可选，查询参数对象，例如 {\"method\":\"uinfo\"}",
        },
        body: {
          type: "object",
          description: "可选，请求体对象（POST/PUT/PATCH 时使用）",
        },
        auth: {
          type: "string",
          description: "Key 的传递方式：bearer（Authorization: Bearer）默认 / header（X-API-Key）/ query（?api_key=）/ none",
        },
      },
      required: ["path"],
    },
    async execute(args) {
      const rec = await readRecord();
      if (!rec) return "还没有保存百度网盘 API Key，先让用户在保险箱面板里填入。";

      let res;
      try {
        res = await apiRequest(rec.value, {
          host: args && args.host,
          method: args && args.method,
          path: args && args.path,
          query: args && args.query,
          body: args && args.body,
          auth: args && args.auth,
          timeoutMs: 25000,
        });
      } catch (error) {
        return "请求失败：" + String(error && error.message ? error.message : error);
      }

      const raw = scrub(res.body, rec.value);
      const trimmed = raw.length > MAX_BODY_CHARS ? raw.slice(0, MAX_BODY_CHARS) + "\n…（已截断）" : raw;
      return (
        "HTTP " +
        res.status +
        " " +
        res.host +
        res.apiPath +
        "\n" +
        (trimmed || "（空响应）")
      );
    },
  };
}

function toolReveal() {
  return {
    id: "bdpan-vault_reveal",
    name: "取出百度网盘 API Key 明文",
    description:
      "返回本机保存的百度网盘 API Key 明文。只在用户明确要求「把 Key 显示出来 / 我要核对 Key」时调用；返回值会进入本轮对话上下文并留在记录里，无法撤回。日常调用接口请改用 bdpan-vault_api。",
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
      const confirm = String((args && args.confirm) || "")
        .trim()
        .toUpperCase();
      if (confirm !== "REVEAL") return '没有确认，已取消。需要明文时请传 confirm: "REVEAL"。';
      const rec = await readRecord();
      if (!rec) return "还没有保存百度网盘 API Key。";
      return rec.value;
    },
  };
}

function toolClear() {
  return {
    id: "bdpan-vault_clear",
    name: "删除保存的百度网盘 API Key",
    description: "删除本机保存的百度网盘 API Key。用户要求撤销或更换 Key 时使用。",
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
      const confirm = String((args && args.confirm) || "")
        .trim()
        .toUpperCase();
      if (confirm !== "DELETE") return '没有确认，已取消。需要删除时请传 confirm: "DELETE"。';
      await clearRecord();
      return "已删除保存的百度网盘 API Key。";
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
        masked: rec ? maskKey(rec.value) : "",
        label: rec ? rec.label : "",
        enc: rec ? rec.enc : Boolean(getSafeStorage()),
        updatedAt: rec ? formatTime(rec.updatedAt) : "",
      };
    });

    ctx.registerIpc("save", async (payload) => {
      const apiKey = String((payload && payload.token) || "").trim();
      const label = String((payload && payload.label) || "").trim();
      if (!apiKey) return { ok: false, message: "Key 不能为空" };
      if (/\s/.test(apiKey)) return { ok: false, message: "Key 里不能有空格或换行" };
      if (apiKey.length < 12) return { ok: false, message: "Key 看起来太短了，检查一下有没有复制完整" };
      await writeRecord(apiKey, label);
      return { ok: true, message: "已保存", masked: maskKey(apiKey) };
    });

    ctx.registerIpc("test", async () => {
      const rec = await readRecord();
      if (!rec) return { ok: false, message: "还没有保存 Key" };
      try {
        const res = await apiRequest(rec.value, {
          host: "pan.baidu.com",
          path: "/rest/2.0/xpan/nas",
          query: { method: "uinfo" },
          method: "GET",
          auth: "bearer",
          timeoutMs: 15000,
        });
        const body = scrub(res.body, rec.value).slice(0, 240);
        let errno = null;
        try {
          errno = JSON.parse(res.body || "{}").errno;
        } catch {
          errno = null;
        }
        if (res.status === 200 && errno === 0) {
          return { ok: true, message: "连接正常", detail: body };
        }
        return {
          ok: false,
          message: "HTTP " + res.status + (errno === null ? "" : "，errno=" + errno),
          detail: body,
        };
      } catch (error) {
        return { ok: false, message: "请求失败：" + String(error && error.message ? error.message : error) };
      }
    });

    ctx.registerIpc("clear", async () => {
      await clearRecord();
      return { ok: true, message: "已删除" };
    });

    ctx.log("百度网盘 API 保险箱已注册：bdpan-vault_status / bdpan-vault_api / bdpan-vault_reveal / bdpan-vault_clear");
  },

  unregister() {
    if (panelWin && !panelWin.isDestroyed()) panelWin.close();
    panelWin = null;
  },
};

module.exports.default = module.exports;
