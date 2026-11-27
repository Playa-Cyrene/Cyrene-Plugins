"use strict";

/**
 * 保险箱（cyrene-vault）
 *
 * 内容用 Windows DPAPI 加密，密钥绑定当前 Windows 账户。
 * 加密文件被拷到别的机器或别的账户下都解不开。
 *
 * 存储：%APPDATA%\Cyrene\plugin-data\cyrene-vault\vault.json
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const ID = "cyrene-vault";
const DATA_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "Cyrene", "plugin-data", ID
);
const DATA_FILE = path.join(DATA_DIR, "vault.json");
const PS1 = path.join(__dirname, "lib", "dpapi.ps1");

let win = null;

/* ---------------- 存储层 ---------------- */

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readStore() {
  try {
    ensureDir();
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeStore(data) {
  ensureDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  try { fs.chmodSync(DATA_FILE, 0o600); } catch { /* 非 POSIX 忽略 */ }
}

/** 调 PowerShell 做 DPAPI 加解密；明文走临时文件，不进命令行参数 */
function runPs(mode, text) {
  return new Promise((resolve, reject) => {
    ensureDir();
    const tmp = path.join(DATA_DIR, `.io-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    try {
      fs.writeFileSync(tmp, text, "utf8");
    } catch (e) {
      return reject(new Error("临时文件写入失败：" + e.message));
    }
    execFile(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1, mode, tmp],
      { timeout: 20000, windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(tmp); } catch { /* 已删 */ }
        if (err) {
          const msg = (stderr || err.message || "").trim();
          return reject(new Error(msg || "DPAPI 调用失败"));
        }
        resolve(stdout.replace(/\r?\n$/, ""));
      }
    );
  });
}

/* ---------------- 业务层 ---------------- */

async function saveSecret(key, value) {
  if (!key || !/^[A-Za-z0-9_.-]{1,64}$/.test(key)) {
    throw new Error("键名只能用字母、数字、下划线、点、连字符，1-64 位");
  }
  if (!value) throw new Error("值不能为空");
  const enc = await runPs("protect", value);
  const data = readStore();
  const now = new Date().toISOString();
  data[key] = {
    v: enc,
    len: String(value).length,
    created: (data[key] && data[key].created) || now,
    updated: now,
  };
  writeStore(data);
  return { key, len: String(value).length };
}

async function getSecret(key) {
  const rec = readStore()[key];
  if (!rec) throw new Error(`保险箱里没有「${key}」`);
  return runPs("unprotect", rec.v);
}

function listSecrets() {
  const data = readStore();
  return Object.keys(data).sort().map((k) => ({
    key: k,
    len: data[k].len || 0,
    created: data[k].created || "",
    updated: data[k].updated || "",
  }));
}

function hasSecret(key) {
  return Object.prototype.hasOwnProperty.call(readStore(), key);
}

function deleteSecret(key) {
  const data = readStore();
  if (!Object.prototype.hasOwnProperty.call(data, key)) return false;
  delete data[key];
  writeStore(data);
  return true;
}

/* ---------------- 插件入口 ---------------- */

module.exports = {
  async register(ctx) {
    ctx.registerTool({
      id: "cyrene-vault_list",
      name: "查看保险箱",
      description:
        "列出保险箱里存了哪些凭据的名字和长度（不返回值本身）。用户问「保险箱里有什么」「存过哪些密码」时使用。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        const items = listSecrets();
        if (!items.length) return "保险箱是空的。";
        return "保险箱里有：\n" + items.map((i) => `- ${i.key}（${i.len} 字符，更新于 ${i.updated.slice(0, 16).replace("T", " ")}）`).join("\n");
      },
    });

    ctx.registerTool({
      id: "cyrene-vault_save",
      name: "存入凭据",
      description:
        "把一条凭据（密码、API Key、授权码）加密存进保险箱。key 是名字，value 是要保存的内容。用户明确说「帮我记住这个密码 / 存一下这个 key」时使用。注意：value 会进入对话上下文，敏感内容建议让用户自己在保险箱界面输入。",
      enabled: true,
      risk: "write",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "凭据名，例如 gmail_app_password" },
          value: { type: "string", description: "要保存的明文内容" },
        },
        required: ["key", "value"],
      },
      async execute(args) {
        const r = await saveSecret(args.key, args.value);
        return `已加密存入「${r.key}」（${r.len} 字符）。用 DPAPI 绑定当前 Windows 账户，文件拷走也解不开。`;
      },
    });

    ctx.registerTool({
      id: "cyrene-vault_get",
      name: "取出凭据",
      description:
        "取出保险箱里某条凭据的明文。只在用户明确要求「把那个密码显示出来 / 我要核对」时使用。日常需要凭据时，应由脚本直接读存储文件，不要调用本工具，以免明文进入对话记录。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "凭据名" },
        },
        required: ["key"],
      },
      async execute(args) {
        return await getSecret(args.key);
      },
    });

    ctx.registerTool({
      id: "cyrene-vault_delete",
      name: "删除凭据",
      description:
        "从保险箱删除一条凭据。key 是凭据名。用户明确要求删除或作废某个凭据时使用，调用前先确认名字。",
      enabled: true,
      risk: "write",
      effectKind: "write",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "要删除的凭据名" },
        },
        required: ["key"],
      },
      async execute(args) {
        const ok = deleteSecret(args.key);
        return ok ? `已删除「${args.key}」。` : `保险箱里没有「${args.key}」。`;
      },
    });

    ctx.registerTool({
      id: "cyrene-vault_open",
      name: "打开保险箱",
      description:
        "打开保险箱管理界面，用户可以在里面查看、新增、删除凭据，密码框不会把内容送到对话里。用户说「打开保险箱」时使用。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute() {
        await module.exports.open();
        return "保险箱窗口已经打开啦，可以自己输入或删除。";
      },
    });

    /* 界面用的 IPC */
    ctx.registerIpc("list", () => listSecrets());
    ctx.registerIpc("save", async (payload) => {
      const { key, value } = payload || {};
      return await saveSecret(key, value);
    });
    ctx.registerIpc("del", (payload) => {
      const { key } = payload || {};
      return deleteSecret(key);
    });
    ctx.registerIpc("reveal", async (payload) => {
      const { key } = payload || {};
      return await getSecret(key);
    });

    ctx.log("保险箱已就绪");
  },

  async open() {
    if (win && !win.isDestroyed()) {
      win.focus();
      return;
    }
    const { BrowserWindow } = require("electron");
    win = new BrowserWindow({
      width: 620,
      height: 640,
      minWidth: 520,
      minHeight: 480,
      autoHideMenuBar: true,
      backgroundColor: "#fff7fa",
      title: "保险箱",
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    win.on("closed", () => { win = null; });
    await win.loadFile(path.join(__dirname, "ui.html"));
  },

  async unregister() {
    if (win && !win.isDestroyed()) {
      win.close();
    }
    win = null;
  },
};
