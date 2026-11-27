"use strict";

/**
 * 钥匙环（cyrene-keyring）
 *
 * P0 范围：加密库、锁状态机、四类条目的增删改查、面板、加密导出导入。
 * Windows Hello 门禁在 P1 接入，这里先把主密码这条路走通。
 *
 * 安全边界：
 * - DEK 只在主进程内存里，锁定即清零
 * - 面板拿到的列表永远是脱敏视图，只有点开某一条才单独 reveal
 * - Agent 拿不到整库；password / note 默认连单条都拿不到
 * - 任何秘密值都不会出现在工具返回值里，除非该条目的 access 明确允许
 */

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const {
  createVault,
  unlockVault,
  openWithDek,
  saveVault,
  changePassword,
  inspectVault,
} = require("./crypto-store.cjs");
const {
  normalizeEntry,
  publicView,
  listView,
  secretOf,
  sortEntries,
  normalizeAccess,
} = require("./entries.cjs");
const { generateTotp, formatCode, parseOtpauth } = require("./totp.cjs");
const { scanLegacy, collectLegacy } = require("./migrate.cjs");
const guardLib = require("./guard.cjs");
const {
  helloAvailability,
  helloVerify,
  dpapiProtect,
  dpapiUnprotect,
} = require("./windows-hello.cjs");

let Electron = null;
try {
  Electron = require("electron");
} catch {
  Electron = null;
}

const VAULT_KEY = "keyringVault";
const AUDIT_KEY = "keyringAudit";
const SETTINGS_KEY = "keyringSettings";
const MAX_AUDIT = 200;
const IDLE_DEFAULT_MS = 5 * 60 * 1000;
const IDLE_MIN_MS = 60 * 1000;
const IDLE_MAX_MS = 24 * 60 * 60 * 1000;
const CLIPBOARD_CLEAR_MS = 30 * 1000;
// idleLockMs 为 0 表示不按无操作自动锁，只保留主动锁定和关闭宿主两个结束条件。
const DEFAULT_SETTINGS = { hiddenLockMs: 10 * 1000, idleLockMs: IDLE_DEFAULT_MS };
const HIDDEN_LOCK_MIN_MS = 5 * 1000;
const HIDDEN_LOCK_MAX_MS = 60 * 60 * 1000;
const TOKEN_TTL_MS = 60 * 1000;
const MAX_PENDING = 20;

let ctxRef = null;
let panelWin = null;

let vaultFile = null;
let dek = null;
let entries = [];

/** 读旧库时把 access 迁到当前枚举（always → session），别让旧条目退化成每次询问。 */
function adoptEntries(rawEntries) {
  return (Array.isArray(rawEntries) ? rawEntries : []).map((entry) => ({
    ...entry,
    access: normalizeAccess(entry.access, entry.type),
  }));
}
let lastActive = 0;
let guardData = guardLib.normalize(null, 0);
let idleTimer = null;
let clipboardTimer = null;
let settings = { ...DEFAULT_SETTINGS };
let pendingRequests = [];
let oneTimeTokens = new Map();
// 本次解锁内免确认的条目 id。锁定时清空，不落盘。
let sessionGrants = new Set();
let idSeq = 0;

// Windows Hello 当前探测结果，register 时填一次
let hello = { available: false, code: "Unknown", text: "还没检查" };

function messageOf(error) {
  return String(error && error.message ? error.message : error);
}

function isUnlocked() {
  return Boolean(dek);
}

function requireUnlocked() {
  if (!dek) throw new Error("钥匙环已锁定，请先在面板里解锁");
}

function touch() {
  lastActive = Date.now();
}

function lock(reason) {
  pendingRequests = [];
  oneTimeTokens.clear();
  sessionGrants.clear();
  if (!dek) return;
  try {
    dek.fill(0);
  } catch {
    /* 忽略 */
  }
  dek = null;
  entries = [];
  if (reason) {
    appendAudit({ action: "lock", reason }).catch(() => {});
  }
}

/* ------------------------------ 存储 ------------------------------ */

async function readVaultFile() {
  if (!ctxRef) return null;
  const raw = await ctxRef.storage.get(VAULT_KEY);
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("本地库文件不是合法 JSON");
    }
  }
  return raw;
}

async function persist() {
  requireUnlocked();
  vaultFile = saveVault(vaultFile, dek, entries);
  await ctxRef.storage.set(VAULT_KEY, vaultFile);
}

/** 只写头部，不动条目密文。限流计数走这条路。 */
async function persistGuard() {
  if (!ctxRef || !vaultFile) return;
  vaultFile.guard = guardData;
  await ctxRef.storage.set(VAULT_KEY, vaultFile);
}

/** 推进窗口并返回当前限流状态。 */
function guardStatus(now = Date.now()) {
  const state = guardLib.status(guardData, now);
  guardData = state.guard;
  return state;
}

/** 给面板看的精简版，不含内部字段。 */
function guardView(state) {
  return {
    stage: state.stage,
    stageLabel: state.stageLabel,
    limit: state.limit,
    used: state.used,
    remaining: state.remaining,
    locked: state.locked,
    retryAt: state.retryAt,
    waitMs: state.waitMs,
    waitText: guardLib.describeWait(state.waitMs),
    unlockMode: state.unlockMode,
    tamper: state.tamper,
    jumpDir: state.jumpDir,
    jumpMs: state.jumpMs,
  };
}

async function appendAudit(record) {
  if (!ctxRef) return;
  try {
    const raw = await ctxRef.storage.get(AUDIT_KEY);
    const list = Array.isArray(raw) ? raw : [];
    list.unshift({ at: Date.now(), ...record });
    await ctxRef.storage.set(AUDIT_KEY, list.slice(0, MAX_AUDIT));
  } catch {
    /* 审计失败不影响主流程 */
  }
}

/* ------------------------------ 剪贴板 ------------------------------ */

function copySecret(text) {
  if (!Electron || !Electron.clipboard) throw new Error("当前环境拿不到剪贴板");
  const value = String(text || "");
  if (!value) throw new Error("没有可复制的内容");
  Electron.clipboard.writeText(value);

  clearTimeout(clipboardTimer);
  clipboardTimer = setTimeout(() => {
    try {
      if (Electron.clipboard.readText() === value) Electron.clipboard.clear();
    } catch {
      /* 忽略 */
    }
  }, CLIPBOARD_CLEAR_MS);
  // 别让清除计时器拖着进程不退出（测试和非 Electron 环境会用到）
  if (typeof clipboardTimer.unref === "function") clipboardTimer.unref();
}

/* ------------------------------ 取用通道 ------------------------------ */

function newId(prefix) {
  idSeq += 1;
  return prefix + "-" + Date.now().toString(36) + "-" + idSeq.toString(36);
}

function purgeExpired(now = Date.now()) {
  pendingRequests = pendingRequests.filter((item) => item.expiresAt > now);
  for (const [token, item] of oneTimeTokens) {
    if (item.expiresAt <= now) oneTimeTokens.delete(token);
  }
}

function requestView(item, now = Date.now()) {
  return {
    id: item.id,
    entryId: item.entryId,
    title: item.title,
    type: item.type,
    access: item.access,
    purpose: item.purpose,
    reason: item.reason,
    waitMs: Math.max(0, item.expiresAt - now),
  };
}

function pendingView() {
  purgeExpired();
  return pendingRequests.map((item) => requestView(item));
}

/** Agent 发起取用请求。同一条目同一用途在有效期内只保留一条。 */
function pushRequest(entry, purpose, reason) {
  purgeExpired();
  const same = pendingRequests.find(
    (item) => item.entryId === entry.id && item.purpose === purpose
  );
  if (same) return same;
  const item = {
    id: newId("req"),
    entryId: entry.id,
    title: entry.title,
    type: entry.type,
    access: entry.access,
    purpose,
    reason,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  };
  pendingRequests.unshift(item);
  if (pendingRequests.length > MAX_PENDING) pendingRequests.length = MAX_PENDING;
  return item;
}

/** 发一枚一次性令牌，绑定条目与用途，60 秒过期。 */
function issueToken(entry, purpose) {
  purgeExpired();
  const token = crypto.randomBytes(32).toString("hex");
  oneTimeTokens.set(token, {
    entryId: entry.id,
    type: entry.type,
    purpose,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return token;
}

/** 兑换并立刻销毁令牌，返回条目当前的值。 */
function takeToken(rawToken) {
  purgeExpired();
  const token = String(rawToken || "").trim();
  const item = oneTimeTokens.get(token);
  if (!item) throw new Error("令牌无效或已过期");
  oneTimeTokens.delete(token);

  const entry = entries.find((e) => e.id === item.entryId);
  if (!entry) throw new Error("条目已经不存在");

  if (item.purpose === "totp") {
    const out = generateTotp({
      secret: entry.secret,
      digits: entry.digits,
      period: entry.period,
      algorithm: entry.algorithm,
    });
    // value 保持纯数字，剪贴板和 OTP 输入框都认；display 只给面板看。
    return {
      entry,
      value: out.code,
      display: formatCode(out.code),
      remaining: out.remaining,
    };
  }
  return { entry, value: secretOf(entry) };
}

function ymd(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate());
}

/* ------------------------------ 查找 ------------------------------ */

function findEntry(args) {
  const id = String((args && args.id) || "").trim();
  const query = String((args && args.query) || "").trim().toLowerCase();

  if (id) {
    const hit = entries.find((entry) => entry.id === id);
    return hit ? { entry: hit, matches: [hit] } : { entry: null, matches: [] };
  }
  if (!query) return { entry: null, matches: [], needQuery: true };

  const matches = entries.filter((entry) => {
    const hay = [entry.title, entry.username, entry.issuer, entry.account, entry.service, entry.group]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(query);
  });
  return { entry: matches.length === 1 ? matches[0] : null, matches };
}

const ACCESS_LABEL = {
  "panel-only": "仅面板",
  ask: "每次确认",
  session: "本次解锁免确认",
  plaintext: "明文直读",
};

function describe(entry) {
  const bits = [entry.title];
  if (entry.type === "password" && entry.username) bits.push(entry.username);
  if (entry.type === "totp" && entry.account) bits.push(entry.account);
  if (entry.type === "api_key" && entry.service) bits.push(entry.service);
  return bits.filter(Boolean).join(" · ");
}

/* ------------------------------ 面板 ------------------------------ */

async function openPanel() {
  if (!Electron || !Electron.BrowserWindow) {
    throw new Error("当前环境拿不到 BrowserWindow，无法打开面板");
  }
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.show();
    panelWin.focus();
    return;
  }
  panelWin = new Electron.BrowserWindow({
    width: 720,
    height: 820,
    minWidth: 560,
    minHeight: 640,
    title: "钥匙环",
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

function toolList() {
  return {
    id: "cyrene-keyring_list",
    name: "列出钥匙环里的条目",
    description:
      "列出本机钥匙环里的条目（标题、类型、分组、账号），不返回任何密码、Key 或 TOTP secret。需要具体内容请用 cyrene-keyring_get。",
    enabled: true,
    risk: "safe",
    effectKind: "read",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "只看某一类：password / totp / api_key / note" },
        query: { type: "string", description: "按标题、账号、服务名过滤" },
      },
      required: [],
    },
    async execute(args) {
      if (!isUnlocked()) {
        return "钥匙环已锁定。请让用户在「钥匙环」面板里解锁后再试。";
      }
      touch();
      const type = String((args && args.type) || "").trim();
      const query = String((args && args.query) || "").trim().toLowerCase();

      let list = entries;
      if (type) list = list.filter((entry) => entry.type === type);
      if (query) {
        list = list.filter((entry) =>
          [entry.title, entry.username, entry.issuer, entry.account, entry.service, entry.group]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(query)
        );
      }

      if (!list.length) return "没有匹配的条目。";
      return (
        "共 " + list.length + " 条：\n" +
        sortEntries(list)
          .map(
            (entry) =>
              "- " +
              entry.id +
              " | " +
              entry.type +
              " | " +
              describe(entry) +
              "（" +
              (ACCESS_LABEL[entry.access] || entry.access) +
              "）"
          )
          .join("\n")
      );
    },
  };
}

function toolGet() {
  return {
    id: "cyrene-keyring_get",
    name: "查看钥匙环里的一条",
    description:
      "按 id 或标题查看一条条目的引用。只返回 secret://<id> 引用、类型和长度，不返回任何明文。需要取用时，请让用户在「钥匙环」面板里确认，确认后走一次性令牌。",
    enabled: true,
    risk: "read",
    effectKind: "read",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "条目 id" },
        query: { type: "string", description: "按标题或账号模糊匹配；匹配多条时会列出候选" },
        reason: { type: "string", description: "用户为什么需要这条内容，会记入审计" },
      },
      required: [],
    },
    async execute(args) {
      if (!isUnlocked()) {
        return "钥匙环已锁定。请让用户在「钥匙环」面板里解锁后再试。";
      }
      touch();

      const found = findEntry(args);
      if (found.needQuery) return "请提供 id 或 query。";
      if (!found.entry) {
        if (!found.matches.length) return "没有匹配的条目。";
        return (
          "匹配到多条，请指定一条：\n" +
          found.matches.map((entry) => "- " + entry.id + " | " + describe(entry)).join("\n")
        );
      }

      const entry = found.entry;
      const reason = String((args && args.reason) || "").trim();

      if (entry.access === "panel-only") {
        await appendAudit({ action: "deny", id: entry.id, type: entry.type, reason, source: "agent" });
        return "这条被设置为「只给面板」，Agent 读不到。需要的话请让用户在面板里复制。";
      }

      await appendAudit({ action: "ref", id: entry.id, type: entry.type, reason, source: "agent" });
      return [
        "secret://" + entry.id,
        "类型：" + entry.type,
        "标题：" + describe(entry),
        "长度：" + String(secretOf(entry) || "").length,
        "明文不会经过 Agent。取用请让用户在「钥匙环」面板里确认，确认后发一次性令牌，60 秒过期、用一次即作废。",
      ].join("\n");
    },
  };
}

function toolUse() {
  return {
    id: "cyrene-keyring_use",
    name: "请求取用一条条目",
    description:
      "向面板发起一次取用请求，用户在「钥匙环」面板确认后才会复制到剪贴板。工具不会返回明文，也不会自己写剪贴板。确认后发一次性令牌，60 秒过期、用一次即作废。",
    enabled: true,
    risk: "write",
    effectKind: "write",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "条目 id" },
        query: { type: "string", description: "按标题或账号模糊匹配" },
        reason: { type: "string", description: "用户为什么需要这个密码，会记入审计" },
      },
      required: [],
    },
    async execute(args) {
      if (!isUnlocked()) {
        return "钥匙环已锁定。请让用户在「钥匙环」面板里解锁后再试。";
      }
      touch();

      const found = findEntry(args);
      if (found.needQuery) return "请提供 id 或 query。";
      if (!found.entry) {
        if (!found.matches.length) return "没有匹配的条目。";
        return (
          "匹配到多条，请指定一条：\n" +
          found.matches.map((entry) => "- " + entry.id + " | " + describe(entry)).join("\n")
        );
      }

      const entry = found.entry;
      if (entry.access === "panel-only") {
        await appendAudit({ action: "deny", id: entry.id, type: entry.type, source: "agent" });
        return "这条被设置为「只给面板」，Agent 不能取用。";
      }

      const purpose = entry.type === "totp" ? "totp" : "copy";
      const reason = String((args && args.reason) || "").trim();

      // 明文直读：这条被明确允许直接回明文，不再进面板排队。
      // 只在本次解锁内有效，锁定后立即失效。
      if (entry.access === "plaintext") {
        const token = issueToken(entry, purpose);
        const taken = takeToken(token);
        await appendAudit({
          action: "use",
          id: entry.id,
          type: entry.type,
          purpose,
          tokenId: token.slice(0, 8),
          reason,
          source: "plaintext",
        });
        return (
          (purpose === "totp" ? "验证码" : "内容") +
          "（明文直读，本次解锁内有效）：\n" +
          taken.value
        );
      }

      // 本次解锁内已授权：直接执行，不再进面板排队。
      // 值仍然只进剪贴板，工具返回值里没有明文。
      if (entry.access === "session" && sessionGrants.has(entry.id)) {
        const token = issueToken(entry, purpose);
        const taken = takeToken(token);
        copySecret(taken.value);
        await appendAudit({
          action: "use",
          id: entry.id,
          type: entry.type,
          purpose,
          tokenId: token.slice(0, 8),
          reason,
          source: "session",
        });
        return (
          (purpose === "totp" ? "验证码" : "内容") +
          "已复制到剪贴板（本次解锁内免确认），30 秒后自动清除。"
        );
      }

      const req = pushRequest(entry, purpose, reason);
      await appendAudit({
        action: "request",
        id: entry.id,
        type: entry.type,
        purpose,
        requestId: req.id,
        reason,
        source: "agent",
      });
      return [
        "已放进面板待确认：" + describe(entry),
        "请求号：" + req.id,
        "请让用户在「钥匙环」面板点「允许」。确认后发一次性令牌，60 秒内有效，用一次就作废。",
      ].join("\n");
    },
  };
}

function toolOpen() {
  return {
    id: "cyrene-keyring_open",
    name: "打开钥匙环面板",
    description: "打开「钥匙环」面板，可以解锁、查看、添加、编辑条目，以及导出导入加密备份。",
    enabled: true,
    risk: "safe",
    effectKind: "write",
    inputSchema: { type: "object", properties: {}, required: [] },
    async execute() {
      await openPanel();
      return "已打开钥匙环面板。";
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
    vaultFile = await readVaultFile();
    guardData = guardLib.normalize(vaultFile && vaultFile.guard);

    try {
      const saved = await ctx.storage.get(SETTINGS_KEY);
      if (saved && typeof saved === "object") {
        const ms = Math.round(Number(saved.hiddenLockMs));
        let idleMs = DEFAULT_SETTINGS.idleLockMs;
        if (typeof saved.idleLockMs === "number" && Number.isFinite(saved.idleLockMs)) {
          const roundedIdle = Math.round(saved.idleLockMs);
          if (roundedIdle === 0) idleMs = 0;
          else if (roundedIdle >= IDLE_MIN_MS && roundedIdle <= IDLE_MAX_MS) idleMs = roundedIdle;
        }
        settings = {
          ...DEFAULT_SETTINGS,
          hiddenLockMs:
            Number.isFinite(ms) && ms >= HIDDEN_LOCK_MIN_MS && ms <= HIDDEN_LOCK_MAX_MS
              ? ms
              : DEFAULT_SETTINGS.hiddenLockMs,
          idleLockMs: idleMs,
        };
      }
    } catch {
      settings = { ...DEFAULT_SETTINGS };
    }

    try {
      const avail = await helloAvailability();
      hello = { available: avail.ok, code: avail.code, text: avail.text };
    } catch (error) {
      hello = { available: false, code: "Error", text: messageOf(error) };
    }

    ctx.registerTool(toolList());
    ctx.registerTool(toolGet());
    ctx.registerTool(toolUse());
    ctx.registerTool(toolOpen());

    ctx.registerIpc("state", async () => {
      const guard = guardStatus();
      return {
        initialized: Boolean(vaultFile),
        unlocked: isUnlocked(),
        idleMs: settings.idleLockMs,
        hello: {
          available: hello.available,
          code: hello.code,
          text: hello.text,
          enabled: Boolean(vaultFile && vaultFile.helloWrap),
        },
        guard: guardView(guard),
        settings: { hiddenLockMs: settings.hiddenLockMs, idleLockMs: settings.idleLockMs },
        pending: isUnlocked() ? pendingView() : [],
        entries: isUnlocked() ? sortEntries(entries).map(listView) : [],
        sessionGranted: isUnlocked() ? Array.from(sessionGrants) : [],
      };
    });

    ctx.registerIpc("confirmRequest", async (payload) => {
      try {
        requireUnlocked();
        purgeExpired();
        const id = String((payload && payload.id) || "");
        const idx = pendingRequests.findIndex((item) => item.id === id);
        if (idx < 0) return { ok: false, message: "请求已过期或不存在" };

        const item = pendingRequests[idx];
        const entry = entries.find((e) => e.id === item.entryId);
        if (!entry) {
          pendingRequests.splice(idx, 1);
          return { ok: false, message: "条目已经不存在" };
        }

        pendingRequests.splice(idx, 1);
        const token = issueToken(entry, item.purpose);
        const taken = takeToken(token);
        // copy 与 totp 都要落到剪贴板：面板确认后原工具调用已经返回，
        // 验证码只留在返回值里用户就再也拿不到了。
        if (item.purpose === "copy" || item.purpose === "totp") copySecret(taken.value);
        const remember = Boolean(payload && payload.remember);
        if (remember && entry.access === "session") sessionGrants.add(entry.id);

        await appendAudit({
          action: "confirm",
          id: entry.id,
          type: entry.type,
          purpose: item.purpose,
          tokenId: token.slice(0, 8),
          remember,
          source: "panel",
        });
        return {
          ok: true,
          purpose: item.purpose,
          value: item.purpose === "copy" ? "" : taken.value,
          display: item.purpose === "totp" ? taken.display : "",
          remaining: taken.remaining || 0,
          message: remember
            ? "已允许，本次解锁内不再询问这条"
            : item.purpose === "copy"
              ? "已复制到剪贴板，30 秒后自动清除"
              : "已批准，令牌用一次就作废",
        };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("denyRequest", async (payload) => {
      try {
        requireUnlocked();
        const id = String((payload && payload.id) || "");
        const idx = pendingRequests.findIndex((item) => item.id === id);
        if (idx < 0) return { ok: false, message: "请求已过期或不存在" };
        const [item] = pendingRequests.splice(idx, 1);
        await appendAudit({
          action: "deny-request",
          id: item.entryId,
          type: item.type,
          purpose: item.purpose,
          source: "panel",
        });
        return { ok: true, message: "已拒绝" };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("redeemToken", async (payload) => {
      try {
        requireUnlocked();
        const taken = takeToken(payload && payload.token);
        await appendAudit({
          action: "redeem",
          id: taken.entry.id,
          type: taken.entry.type,
          source: "panel",
        });
        return { ok: true, value: taken.value, remaining: taken.remaining || 0 };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("helloReset", async () => {
      try {
        if (!vaultFile) return { ok: false, message: "还没有创建钥匙环" };
        if (!vaultFile.helloWrap) return { ok: false, message: "这个库还没启用 Hello 解锁" };
        if (!hello.available) {
          return { ok: false, message: "这台设备用不了 Windows Hello：" + hello.text };
        }

        const verify = await helloVerify("重置解锁冷却");
        if (!verify.ok) {
          const failed = guardLib.recordHelloFailure(guardData);
          guardData = failed.guard;
          if (failed.folded) {
            // 连续失败，窗口从现在重新计时，等于把等待再拉长一轮
            guardData.windowStart = Date.now();
            guardData = guardLib.normalize(guardData);
          }
          await persistGuard();
          await appendAudit({
            action: "guard-reset-failed",
            source: "hello",
            folded: failed.folded,
          });
          return {
            ok: false,
            message: failed.folded
              ? "Hello 连续 " +
                guardLib.HELLO_FAILS_PER_ATTEMPT +
                " 次没有通过，等待时间又拉长了一轮。"
              : verify.text || "没有通过验证",
            guard: guardView(guardLib.status(guardData)),
          };
        }

        const reset = guardLib.recordSuccess(guardData);
        guardData = reset.guard;
        await persistGuard();
        await appendAudit({ action: "guard-reset", source: "hello" });
        return { ok: true, message: "冷却已重置，现在可以重新解锁", guard: guardView(reset) };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("setSettings", async (payload) => {
      try {
        requireUnlocked();
        const next = { ...settings };
        if (payload && payload.hiddenLockMs !== undefined) {
          const ms = Math.round(Number(payload.hiddenLockMs));
          if (!Number.isFinite(ms) || ms < HIDDEN_LOCK_MIN_MS || ms > HIDDEN_LOCK_MAX_MS) {
            return { ok: false, message: "自动锁时间要在 5 秒到 1 小时之间" };
          }
          next.hiddenLockMs = ms;
        }
        if (payload && payload.idleLockMs !== undefined) {
          const ms = Math.round(Number(payload.idleLockMs));
          const valid =
            Number.isFinite(ms) && (ms === 0 || (ms >= IDLE_MIN_MS && ms <= IDLE_MAX_MS));
          if (!valid) {
            return { ok: false, message: "无操作锁定要设为 0（不自动锁）或 1 分钟到 24 小时" };
          }
          next.idleLockMs = ms;
        }
        settings = next;
        await ctx.storage.set(SETTINGS_KEY, settings);
        return {
          ok: true,
          message: "已保存",
          settings: { hiddenLockMs: settings.hiddenLockMs, idleLockMs: settings.idleLockMs },
        };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("setup", async (payload) => {
      try {
        if (vaultFile) return { ok: false, message: "库已经存在，请直接解锁" };
        const password = String((payload && payload.password) || "");
        const created = createVault(password, [], { guard: guardLib.normalize(null) });
        vaultFile = created.file;
        dek = created.dek;
        entries = [];
        guardData = guardLib.normalize(vaultFile.guard);
        touch();

        // 顺手用 DPAPI 包一份 DEK，供 Hello 解锁
        if (hello.available) {
          try {
            vaultFile.helloWrap = await dpapiProtect(created.dek.toString("base64"));
          } catch {
            vaultFile.helloWrap = "";
          }
        }

        await ctx.storage.set(VAULT_KEY, vaultFile);
        return {
          ok: true,
          message: vaultFile.helloWrap
            ? "钥匙环已创建，可以用 Windows Hello 解锁"
            : "钥匙环已创建",
        };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("unlock", async (payload) => {
      try {
        if (!vaultFile) return { ok: false, message: "还没有创建钥匙环" };

        const attempt = guardLib.beginAttempt(guardData);
        guardData = attempt.guard;
        await persistGuard();

        if (!attempt.ok) {
          await appendAudit({ action: "unlock-blocked", source: "panel", stage: attempt.stage });
          return {
            ok: false,
            blocked: true,
            message:
              "这一档的 " +
              attempt.limit +
              " 次已经用完，要等" +
              attempt.waitText +
              "才能再试。",
            guard: guardView(attempt),
          };
        }

        const password = String((payload && payload.password) || "");
        try {
          const opened = unlockVault(vaultFile, password);
          dek = opened.dek;
          entries = adoptEntries(opened.entries);
        } catch (error) {
          await appendAudit({ action: "unlock-failed", source: "panel", stage: attempt.stage });
          return {
            ok: false,
            message: messageOf(error),
            guard: guardView(attempt),
          };
        }

        const reset = guardLib.recordSuccess(guardData);
        guardData = reset.guard;
        await persistGuard();
        touch();
        await appendAudit({ action: "unlock", source: "panel" });
        return { ok: true, message: "已解锁", guard: guardView(reset) };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("helloUnlock", async () => {
      try {
        if (!vaultFile) return { ok: false, message: "还没有创建钥匙环" };
        if (!vaultFile.helloWrap) return { ok: false, message: "这个库还没启用 Hello 解锁" };
        if (!hello.available) {
          return { ok: false, message: "这台设备用不了 Windows Hello：" + hello.text };
        }

        const current = guardStatus();
        if (current.locked) {
          return {
            ok: false,
            blocked: true,
            message:
              "这一档的 " +
              current.limit +
              " 次已经用完，要等" +
              guardLib.describeWait(current.waitMs) +
              "才能再试。",
            guard: guardView(current),
          };
        }

        const verify = await helloVerify("解锁钥匙环");
        if (!verify.ok) {
          const failed = guardLib.recordHelloFailure(guardData);
          guardData = failed.guard;
          await persistGuard();
          await appendAudit({
            action: "unlock-failed",
            source: "hello",
            detail: verify.code,
            folded: failed.folded,
          });
          const hint = failed.locked
            ? "Hello 没有通过，这一档的 " +
              failed.limit +
              " 次也用完了，要等" +
              failed.waitText +
              "才能再试。"
            : failed.folded
              ? "Hello 连续 " +
                guardLib.HELLO_FAILS_PER_ATTEMPT +
                " 次没有通过，算作一次主密码尝试，这一档还剩 " +
                failed.remaining +
                " 次。"
              : verify.text || "没有通过验证";
          return { ok: false, message: hint, guard: guardView(failed), folded: failed.folded };
        }

        const dekB64 = await dpapiUnprotect(vaultFile.helloWrap);
        const opened = openWithDek(vaultFile, Buffer.from(dekB64, "base64"));
        dek = opened.dek;
        entries = adoptEntries(opened.entries);

        const reset = guardLib.recordSuccess(guardData);
        guardData = reset.guard;
        await persistGuard();
        touch();
        await appendAudit({ action: "unlock", source: "hello" });
        return { ok: true, message: "已解锁", guard: guardView(reset) };
      } catch (error) {
        const failed = guardLib.recordHelloFailure(guardData);
        guardData = failed.guard;
        await persistGuard();
        await appendAudit({ action: "unlock-failed", source: "hello" });
        return { ok: false, message: messageOf(error), guard: guardView(failed) };
      }
    });

    ctx.registerIpc("setHello", async (payload) => {
      try {
        requireUnlocked();
        const enabled = Boolean(payload && payload.enabled);

        if (!enabled) {
          vaultFile.helloWrap = "";
          await ctx.storage.set(VAULT_KEY, vaultFile);
          await appendAudit({ action: "hello-off", source: "panel" });
          return { ok: true, message: "已关闭 Hello 解锁" };
        }

        if (!hello.available) {
          return { ok: false, message: "这台设备用不了 Windows Hello：" + hello.text };
        }

        const verify = await helloVerify("启用 Hello 解锁");
        if (!verify.ok) return { ok: false, message: verify.text || "没有通过验证" };

        vaultFile.helloWrap = await dpapiProtect(dek.toString("base64"));
        await ctx.storage.set(VAULT_KEY, vaultFile);
        await appendAudit({ action: "hello-on", source: "panel" });
        return { ok: true, message: "已启用 Hello 解锁" };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("setUnlockMode", async (payload) => {
      try {
        requireUnlocked();
        const mode = payload && payload.mode === "both" ? "both" : "hello";
        guardData.unlockMode = mode;
        await persistGuard();
        await appendAudit({ action: "unlock-mode", mode, source: "panel" });
        return {
          ok: true,
          mode,
          message:
            mode === "both"
              ? "已切换：Hello 和主密码同时显示，输入任意一个都能进"
              : "已切换：默认 Hello 优先，Hello 不通过才落到主密码",
        };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("lock", async () => {
      lock("manual");
      return { ok: true };
    });

    ctx.registerIpc("touch", async () => {
      if (isUnlocked()) touch();
      return { ok: true };
    });

    ctx.registerIpc("add", async (payload) => {
      try {
        requireUnlocked();
        const raw = payload && payload.entry;
        const entry = normalizeEntry(raw);
        if (entries.some((item) => item.type === entry.type && secretOf(item) === secretOf(entry) && item.title === entry.title)) {
          return { ok: false, message: "已经有一条一样的了" };
        }
        entries.push(entry);
        await persist();
        touch();
        await appendAudit({ action: "add", id: entry.id, type: entry.type, source: "panel" });
        return { ok: true, message: "已添加", id: entry.id };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("update", async (payload) => {
      try {
        requireUnlocked();
        const id = String((payload && payload.id) || "");
        const patch = (payload && payload.entry) || {};
        const index = entries.findIndex((entry) => entry.id === id);
        if (index < 0) return { ok: false, message: "没有找到这个条目" };

        const base = entries[index];
        const merged = { ...base, ...patch, id: base.id, createdAt: base.createdAt };
        // 秘密字段留空表示不改
        for (const field of ["password", "secret", "key", "body"]) {
          if (patch[field] === "" || patch[field] == null) merged[field] = base[field];
        }
        entries[index] = normalizeEntry(merged, { existingId: base.id });
        await persist();
        touch();
        await appendAudit({ action: "update", id, type: base.type, source: "panel" });
        return { ok: true, message: "已保存" };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("remove", async (payload) => {
      try {
        requireUnlocked();
        const id = String((payload && payload.id) || "");
        const next = entries.filter((entry) => entry.id !== id);
        if (next.length === entries.length) return { ok: false, message: "没有找到这个条目" };
        entries = next;
        await persist();
        touch();
        await appendAudit({ action: "remove", id, source: "panel" });
        return { ok: true, message: "已删除" };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("reveal", async (payload) => {
      try {
        requireUnlocked();
        const id = String((payload && payload.id) || "");
        const entry = entries.find((item) => item.id === id);
        if (!entry) return { ok: false, message: "没有找到这个条目" };
        touch();
        await appendAudit({ action: "reveal", id, type: entry.type, source: "panel" });
        return { ok: true, entry };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("copy", async (payload) => {
      try {
        requireUnlocked();
        const id = String((payload && payload.id) || "");
        const field = String((payload && payload.field) || "");
        const entry = entries.find((item) => item.id === id);
        if (!entry) return { ok: false, message: "没有找到这个条目" };

        let value = "";
        if (field === "username") value = entry.username || "";
        else if (field === "url") value = entry.url || "";
        else if (field === "password") value = entry.password || "";
        else if (field === "key") value = entry.key || "";
        else if (field === "secret") value = entry.secret || "";
        else if (field === "totp") {
          if (entry.type !== "totp") return { ok: false, message: "不是 2FA 验证码条目" };
          const out = generateTotp({
            secret: entry.secret,
            digits: entry.digits,
            period: entry.period,
            algorithm: entry.algorithm,
          });
          value = out.code;
        } else value = secretOf(entry);

        copySecret(value);
        touch();
        await appendAudit({ action: "copy", id, field: field || "secret", type: entry.type, source: "panel" });
        return { ok: true, message: field === "totp" ? "验证码已复制" : "已复制，30 秒后清除" };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("totp", async (payload) => {
      try {
        requireUnlocked();
        const id = String((payload && payload.id) || "");
        const entry = entries.find((item) => item.id === id);
        if (!entry || entry.type !== "totp") return { ok: false, message: "不是 2FA 验证码条目" };
        const out = generateTotp({
          secret: entry.secret,
          digits: entry.digits,
          period: entry.period,
          algorithm: entry.algorithm,
        });
        touch();
        return { ok: true, code: formatCode(out.code), raw: out.code, remaining: out.remaining, progress: out.progress };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("changePassword", async (payload) => {
      try {
        requireUnlocked();
        const oldPassword = String((payload && payload.oldPassword) || "");
        const newPassword = String((payload && payload.newPassword) || "");
        // 先验证旧密码确实是当前主密码
        unlockVault(vaultFile, oldPassword);
        vaultFile = changePassword(vaultFile, dek, newPassword);
        await ctx.storage.set(VAULT_KEY, vaultFile);
        touch();
        await appendAudit({ action: "change-password", source: "panel" });
        return { ok: true, message: "主密码已更新" };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("exportFile", async (payload) => {
      try {
        requireUnlocked();
        if (!Electron || !Electron.dialog) return { ok: false, message: "当前环境打不开文件对话框" };
        const password = String((payload && payload.password) || "");
        if (password.length < 12) return { ok: false, message: "导出密码至少 12 位" };

        // 导出时重新用导出密码加密一份，避免把主密码的包裹直接给出去
        const { file } = createVault(password, entries, { now: Date.now() });

        const res = await Electron.dialog.showSaveDialog(panelWin || undefined, {
          title: "导出钥匙环（加密备份）",
          defaultPath: "cyrene-keyring-" + ymd() + ".json",
          filters: [{ name: "加密备份", extensions: ["json"] }],
        });
        if (res.canceled || !res.filePath) return { ok: false, message: "已取消" };

        fs.writeFileSync(res.filePath, JSON.stringify(file, null, 2), "utf8");
        await appendAudit({ action: "export", count: entries.length, source: "panel" });
        return { ok: true, message: "已导出 " + entries.length + " 条", path: res.filePath };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("importFile", async (payload) => {
      try {
        requireUnlocked();
        if (!Electron || !Electron.dialog) return { ok: false, message: "当前环境打不开文件对话框" };
        const password = String((payload && payload.password) || "");
        if (!password) return { ok: false, message: "请输入备份密码" };

        const res = await Electron.dialog.showOpenDialog(panelWin || undefined, {
          title: "选择钥匙环加密备份",
          filters: [{ name: "加密备份", extensions: ["json"] }],
          properties: ["openFile"],
        });
        if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, message: "已取消" };

        const raw = fs.readFileSync(res.filePaths[0], "utf8");
        const info = inspectVault(raw);
        if (!info.ok) return { ok: false, message: info.error };

        const opened = unlockVault(raw, password);
        const seen = new Set(entries.map((entry) => entry.type + "\u0000" + secretOf(entry)));
        let added = 0;
        let skipped = 0;
        for (const incoming of opened.entries) {
          const key = incoming.type + "\u0000" + secretOf(incoming);
          if (seen.has(key)) {
            skipped += 1;
            continue;
          }
          seen.add(key);
          entries.push({
            ...incoming,
            id: crypto.randomUUID(),
            access: normalizeAccess(incoming.access, incoming.type),
          });
          added += 1;
        }
        await persist();
        touch();
        await appendAudit({ action: "import", added, skipped, source: "panel" });
        return { ok: true, message: "导入完成：新增 " + added + " 条，跳过重复 " + skipped + " 条", added, skipped };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("audit", async (payload) => {
      try {
        const raw = await ctx.storage.get(AUDIT_KEY);
        const list = Array.isArray(raw) ? raw : [];
        const limit = Number(payload && payload.limit) || 20;
        return list.slice(0, limit);
      } catch {
        return [];
      }
    });

    ctx.registerIpc("parseUri", async (payload) => {
      try {
        const uri = String((payload && payload.uri) || "");
        return { ok: true, entry: parseOtpauth(uri) };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("legacyScan", async () => {
      try {
        requireUnlocked();
        return { ok: true, ...scanLegacy() };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    ctx.registerIpc("legacyImport", async () => {
      try {
        requireUnlocked();
        const collected = await collectLegacy();
        const seen = new Set(entries.map((entry) => entry.type + "\u0000" + secretOf(entry)));
        let added = 0;
        let skipped = 0;
        let invalid = 0;

        for (const raw of collected.entries) {
          try {
            // 迁移进来的条目一律先只给面板，用户确认后再逐条放权。
            const entry = normalizeEntry(Object.assign({}, raw, { access: "panel-only" }));
            const dedupeKey = entry.type + "\u0000" + secretOf(entry);
            if (seen.has(dedupeKey)) {
              skipped += 1;
              continue;
            }
            seen.add(dedupeKey);
            entries.push(entry);
            added += 1;
          } catch {
            invalid += 1;
          }
        }

        if (added > 0) await persist();
        touch();
        await appendAudit({ action: "legacy-import", added, skipped, invalid, source: "panel" });

        const parts = ["迁移完成：新增 " + added + " 条"];
        if (skipped) parts.push("跳过重复 " + skipped + " 条");
        if (invalid) parts.push("跳过格式不对 " + invalid + " 条");
        return {
          ok: true,
          message: parts.join("，"),
          added,
          skipped,
          invalid,
          report: collected.report,
        };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    });

    idleTimer = setInterval(() => {
      if (!dek || settings.idleLockMs <= 0) return;
      if (Date.now() - lastActive > settings.idleLockMs) lock("idle");
    }, 30 * 1000);

    ctx.log("钥匙环已注册：cyrene-keyring_list / cyrene-keyring_get / cyrene-keyring_use / cyrene-keyring_open");
  },

  unregister() {
    clearInterval(idleTimer);
    clearTimeout(clipboardTimer);
    idleTimer = null;
    clipboardTimer = null;
    lock(null);
    if (panelWin && !panelWin.isDestroyed()) panelWin.close();
    panelWin = null;
  },
};

module.exports.default = module.exports;
