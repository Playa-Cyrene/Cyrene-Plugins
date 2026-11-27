"use strict";

/**
 * 条目模型：四类条目 + 校验 + 脱敏视图。
 *
 * 秘密字段只在这一层被识别，上层（工具、面板列表）默认拿到的都是脱敏视图。
 */

const crypto = require("node:crypto");

const TYPES = ["password", "totp", "api_key", "note"];
// 四档：只给面板 / 每次确认（剪贴板）/ 本次解锁免确认（剪贴板）/ 确认后回明文
const ACCESS_MODES = ["panel-only", "ask", "session", "plaintext"];
// 0.4.0 及更早版本把「本次解锁免确认」叫 always，读旧库时自动迁到 session。
const LEGACY_ACCESS = { always: "session" };
const ALGORITHMS = ["sha1", "sha256", "sha512"];

/** 每类条目的秘密字段。note 的正文也算秘密。 */
const SECRET_FIELD = {
  password: "password",
  totp: "secret",
  api_key: "key",
  note: "body",
};

const DEFAULT_ACCESS = {
  password: "panel-only",
  note: "panel-only",
  totp: "session",
  api_key: "session",
};

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function normalizeAccess(value, type) {
  const raw = text(value);
  const migrated = LEGACY_ACCESS[raw] || raw;
  return ACCESS_MODES.includes(migrated) ? migrated : DEFAULT_ACCESS[type];
}

function normalizeBase32(value) {
  const raw = text(value).toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  if (!raw) throw new Error("secret 不能为空");
  if (!/^[A-Z2-7]+$/.test(raw)) throw new Error("secret 只能是 Base32 字符（A–Z 和 2–7）");
  if (raw.length < 16) throw new Error("secret 太短，至少 16 个字符");
  return raw;
}

function normalizeDigits(value) {
  const digits = Number(value) || 6;
  if (digits !== 6 && digits !== 8) throw new Error("位数只能是 6 或 8");
  return digits;
}

function normalizePeriod(value) {
  const period = Number(value) || 30;
  if (!Number.isInteger(period) || period < 10 || period > 300) {
    throw new Error("周期要在 10–300 秒之间");
  }
  return period;
}

function normalizeAlgorithm(value) {
  const algorithm = text(value).toLowerCase() || "sha1";
  if (!ALGORITHMS.includes(algorithm)) throw new Error("算法只能是 SHA1 / SHA256 / SHA512");
  return algorithm;
}

/**
 * 规范化一条输入。编辑时传 options.existingId 保留原 id。
 */
function normalizeEntry(input, options = {}) {
  if (!isRecord(input)) throw new Error("条目必须是对象");

  const type = text(input.type);
  if (!TYPES.includes(type)) throw new Error("条目类型只能是 " + TYPES.join(" / "));

  const now = Number(options.now) || Date.now();
  const id = text(input.id) || text(options.existingId) || crypto.randomUUID();
  const createdAt = Number(input.createdAt) || now;

  const entry = {
    id,
    type,
    title: text(input.title),
    group: text(input.group),
    tags: Array.isArray(input.tags) ? input.tags.map(text).filter(Boolean).slice(0, 12) : [],
    note: text(input.note).slice(0, 4000),
    access: normalizeAccess(input.access, type),
    createdAt,
    updatedAt: now,
    usedAt: Number(input.usedAt) || 0,
  };

  if (type === "password") {
    entry.username = text(input.username);
    entry.password = String(input.password == null ? "" : input.password);
    entry.url = text(input.url);
    if (!entry.password) throw new Error("密码不能为空");
    if (!entry.title) entry.title = entry.username || entry.url || "未命名密码";
  }

  if (type === "totp") {
    entry.secret = normalizeBase32(input.secret);
    entry.issuer = text(input.issuer);
    entry.account = text(input.account);
    entry.digits = normalizeDigits(input.digits);
    entry.period = normalizePeriod(input.period);
    entry.algorithm = normalizeAlgorithm(input.algorithm);
    if (!entry.title) entry.title = entry.issuer || entry.account || "未命名 2FA 验证码";
  }

  if (type === "api_key") {
    entry.key = String(input.key == null ? "" : input.key).trim();
    entry.service = text(input.service);
    entry.scope = text(input.scope);
    if (!entry.key) throw new Error("Key 不能为空");
    if (!entry.title) entry.title = entry.service || "未命名 Key";
  }

  if (type === "note") {
    entry.body = String(input.body == null ? "" : input.body);
    if (!entry.body.trim()) throw new Error("笔记内容不能为空");
    if (!entry.title) entry.title = "未命名笔记";
  }

  return entry;
}

/** 取这条条目的秘密值，用于复制或比对。 */
function secretOf(entry) {
  const field = SECRET_FIELD[entry && entry.type];
  return field ? String(entry[field] || "") : "";
}

/** 脱敏视图：不含秘密字段，只告诉调用方有没有。 */
function publicView(entry) {
  const field = SECRET_FIELD[entry.type];
  const view = {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    group: entry.group,
    tags: entry.tags,
    note: entry.note,
    access: entry.access,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    usedAt: entry.usedAt,
    hasSecret: Boolean(field && entry[field]),
  };

  if (entry.type === "password") {
    view.username = entry.username;
    view.url = entry.url;
    view.hint = mask(entry.password);
  }
  if (entry.type === "totp") {
    view.issuer = entry.issuer;
    view.account = entry.account;
    view.digits = entry.digits;
    view.period = entry.period;
    view.algorithm = entry.algorithm;
  }
  if (entry.type === "api_key") {
    view.service = entry.service;
    view.scope = entry.scope;
    view.hint = mask(entry.key);
  }
  if (entry.type === "note") {
    view.hint = entry.body ? entry.body.length + " 字" : "";
  }

  return view;
}

function mask(value) {
  const raw = String(value || "");
  if (!raw) return "";
  if (raw.length <= 4) return "••••";
  return raw.slice(0, 2) + "••••" + raw.slice(-2);
}

/** 列表视图：比 publicView 更轻，用于面板列表和 Agent 的 list 工具。 */
function listView(entry) {
  const view = {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    group: entry.group,
    tags: entry.tags,
    access: entry.access,
    updatedAt: entry.updatedAt,
  };
  if (entry.type === "totp") {
    view.issuer = entry.issuer;
    view.account = entry.account;
  }
  if (entry.type === "password") view.username = entry.username;
  if (entry.type === "api_key") view.service = entry.service;
  return view;
}

function sortEntries(entries) {
  return entries.slice().sort((a, b) => {
    const ga = a.group || "";
    const gb = b.group || "";
    if (ga !== gb) {
      // 没有分组的条目排在最后
      if (!ga) return 1;
      if (!gb) return -1;
      return ga.localeCompare(gb, "zh-CN");
    }
    return String(a.title).localeCompare(String(b.title), "zh-CN");
  });
}

module.exports = {
  TYPES,
  ACCESS_MODES,
  LEGACY_ACCESS,
  ALGORITHMS,
  SECRET_FIELD,
  DEFAULT_ACCESS,
  normalizeEntry,
  normalizeBase32,
  secretOf,
  publicView,
  listView,
  sortEntries,
  mask,
};
