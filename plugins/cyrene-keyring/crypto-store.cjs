"use strict";

/**
 * 钥匙环的加密库。
 *
 * 密钥分层：
 *   主密码 --scrypt--> KEK(32B) --AES-256-GCM 包裹--> DEK(32B)
 *   DEK --AES-256-GCM--> 条目库密文
 *
 * 换主密码只需要用新 KEK 重新包裹同一个 DEK，不用重加密整库。
 *
 * 库文件不存任何明文，也不存 KEK。GCM 的 tag 同时保证机密性和完整性，
 * 头部字段（KDF 参数、盐、计数、时间）全部进 AAD，改任何一项都会解密失败。
 */

const crypto = require("node:crypto");

const MAGIC = "CYRENE-KEYRING";
const VERSION = 1;
const KDF_NAME = "scrypt";

// 生产参数：128 MiB 内存，约 0.5–1 秒
const DEFAULT_SCRYPT = Object.freeze({
  N: 131072,
  r: 8,
  p: 1,
  maxmem: 256 * 1024 * 1024,
});

const MIN_SCRYPT_N = 16384;
const MAX_SCRYPT_N = 1048576;
const MIN_PASSWORD_LENGTH = 12;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ------------------------------ 基础封装 ------------------------------ */

function seal(key, plainBuffer, aad) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function unseal(key, box, aad) {
  if (!isRecord(box)) throw new Error("加密块格式不对");
  const iv = Buffer.from(String(box.iv || ""), "base64");
  const tag = Buffer.from(String(box.tag || ""), "base64");
  const data = Buffer.from(String(box.data || ""), "base64");
  if (iv.length !== IV_BYTES) throw new Error("加密块的 IV 长度不对");
  if (tag.length !== TAG_BYTES) throw new Error("加密块的校验标签长度不对");
  if (!data.length) throw new Error("加密块没有内容");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function deriveKek(password, saltBuffer, params) {
  return crypto.scryptSync(Buffer.from(stringOf(password), "utf8"), saltBuffer, KEY_BYTES, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem,
  });
}

function stringOf(value) {
  return value == null ? "" : String(value);
}

/* ------------------------------ AAD ------------------------------ */

function headerAad({ n, r, p, salt }) {
  return [MAGIC, String(VERSION), KDF_NAME, String(n), String(r), String(p), salt].join("|");
}

function bodyAad(entryCount, updatedAt) {
  return [MAGIC, String(VERSION), String(entryCount), String(updatedAt)].join("|");
}

/* ------------------------------ 校验 ------------------------------ */

function validateScrypt(params) {
  const n = Number(params && params.N);
  const r = Number(params && params.r);
  const p = Number(params && params.p);
  if (!Number.isInteger(n) || n < MIN_SCRYPT_N || n > MAX_SCRYPT_N) {
    throw new Error("scrypt 的 N 参数非法");
  }
  if ((n & (n - 1)) !== 0) throw new Error("scrypt 的 N 必须是 2 的幂");
  if (!Number.isInteger(r) || r < 1 || r > 32) throw new Error("scrypt 的 r 参数非法");
  if (!Number.isInteger(p) || p < 1 || p > 16) throw new Error("scrypt 的 p 参数非法");
  return { N: n, r, p, maxmem: Math.max(Number(params.maxmem) || 0, 128 * n * r * 2) };
}

function parseFile(file) {
  let value = file;
  if (typeof file === "string") {
    try {
      value = JSON.parse(file);
    } catch {
      throw new Error("库文件不是合法 JSON");
    }
  }
  if (!isRecord(value)) throw new Error("库文件必须是一个对象");
  if (value.magic !== MAGIC) throw new Error("这不是钥匙环的库文件");
  if (value.version !== VERSION) throw new Error("不支持的库文件版本：" + String(value.version));

  const kdf = value.kdf;
  if (!isRecord(kdf) || kdf.name !== KDF_NAME) throw new Error("库文件的 KDF 信息不对");

  const params = validateScrypt({ N: kdf.N, r: kdf.r, p: kdf.p, maxmem: kdf.maxmem });
  const salt = String(kdf.salt || "");
  const saltBuffer = Buffer.from(salt, "base64");
  if (saltBuffer.length !== SALT_BYTES) throw new Error("库文件的盐长度不对");

  const entryCount = Number(value.entryCount);
  if (!Number.isInteger(entryCount) || entryCount < 0) throw new Error("库文件的条目计数不对");
  const updatedAt = Number(value.updatedAt) || 0;

  if (!isRecord(value.wrappedKey)) throw new Error("库文件缺少被包裹的密钥");
  if (!isRecord(value.vault)) throw new Error("库文件缺少条目密文");

  return {
    magic: MAGIC,
    version: VERSION,
    kdf: { name: KDF_NAME, N: params.N, r: params.r, p: params.p, salt, maxmem: params.maxmem },
    saltBuffer,
    wrappedKey: value.wrappedKey,
    vault: value.vault,
    entryCount,
    updatedAt,
    digest: String(value.digest || ""),
    helloWrap: typeof value.helloWrap === "string" ? value.helloWrap : "",
    guard: isRecord(value.guard) ? value.guard : null,
    bodyAad: bodyAad(entryCount, updatedAt),
    headerAad: headerAad({ n: params.N, r: params.r, p: params.p, salt }),
  };
}

/* ------------------------------ 对外接口 ------------------------------ */

/**
 * 建库。返回 { file, dek }。
 * dek 只在内存里存在，退出即丢。
 */
function createVault(password, entries, options = {}) {
  const pass = stringOf(password);
  if (pass.length < MIN_PASSWORD_LENGTH) throw new Error("主密码至少 " + MIN_PASSWORD_LENGTH + " 位");
  if (!Array.isArray(entries)) throw new Error("条目必须是数组");

  const params = validateScrypt({ ...DEFAULT_SCRYPT, ...(options.scrypt || {}) });
  const saltBuffer = crypto.randomBytes(SALT_BYTES);
  const salt = saltBuffer.toString("base64");
  const kek = deriveKek(pass, saltBuffer, params);
  const dek = crypto.randomBytes(KEY_BYTES);

  const header = headerAad({ n: params.N, r: params.r, p: params.p, salt });
  const wrappedKey = seal(kek, dek, header);

  const updatedAt = Number(options.now) || Date.now();
  const plain = Buffer.from(JSON.stringify(entries), "utf8");
  const vault = seal(dek, plain, bodyAad(entries.length, updatedAt));

  return {
    file: {
      magic: MAGIC,
      version: VERSION,
      kdf: { name: KDF_NAME, N: params.N, r: params.r, p: params.p, salt, maxmem: params.maxmem },
      wrappedKey,
      vault,
      entryCount: entries.length,
      updatedAt,
      digest: crypto.createHash("sha256").update(plain).digest("hex"),
      helloWrap: String(options.helloWrap || ""),
      guard: isRecord(options.guard) ? options.guard : null,
    },
    dek,
  };
}

/**
 * 用主密码解锁。口令错或文件被改过都会在这里失败。
 */
function unlockVault(file, password) {
  const parsed = parseFile(file);
  const pass = stringOf(password);
  if (!pass) throw new Error("请输入主密码");

  const kek = deriveKek(pass, parsed.saltBuffer, parsed.kdf);

  let dek;
  try {
    dek = unseal(kek, parsed.wrappedKey, parsed.headerAad);
  } catch {
    throw new Error("主密码不对，或者库文件被改过");
  }

  return openWithDek(parsed, dek);
}

/**
 * 用一个已经拿到的 DEK 解开条目。
 * 走 Hello 解锁时，DEK 来自 DPAPI，不经过主密码。
 */
function openWithDek(file, dek) {
  const parsed = parseFile(file);
  if (!Buffer.isBuffer(dek) || dek.length !== KEY_BYTES) throw new Error("DEK 不可用");

  let plain;
  try {
    plain = unseal(dek, parsed.vault, parsed.bodyAad);
  } catch {
    throw new Error("条目数据校验失败，库文件可能被改过");
  }

  if (parsed.digest) {
    const actual = crypto.createHash("sha256").update(plain).digest("hex");
    if (actual !== parsed.digest) throw new Error("库文件完整性校验失败");
  }

  let entries;
  try {
    entries = JSON.parse(plain.toString("utf8"));
  } catch {
    throw new Error("库里的条目不是合法 JSON");
  }
  if (!Array.isArray(entries)) throw new Error("库里的条目格式不对");

  return { entries, dek };
}

/**
 * 用已解锁的 DEK 写回库文件。KDF 参数和盐保持不变。
 */
function saveVault(file, dek, entries, options = {}) {
  const parsed = parseFile(file);
  if (!Buffer.isBuffer(dek) || dek.length !== KEY_BYTES) throw new Error("DEK 不可用");
  if (!Array.isArray(entries)) throw new Error("条目必须是数组");

  const updatedAt = Number(options.now) || Date.now();
  const plain = Buffer.from(JSON.stringify(entries), "utf8");

  return {
    magic: MAGIC,
    version: VERSION,
    kdf: parsed.kdf,
    wrappedKey: parsed.wrappedKey,
    vault: seal(dek, plain, bodyAad(entries.length, updatedAt)),
    entryCount: entries.length,
    updatedAt,
    digest: crypto.createHash("sha256").update(plain).digest("hex"),
    helloWrap: parsed.helloWrap,
    guard: parsed.guard,
  };
}

/**
 * 改主密码：新盐、新 KEK，包裹同一个 DEK。
 */
function changePassword(file, dek, newPassword, options = {}) {
  const parsed = parseFile(file);
  if (!Buffer.isBuffer(dek) || dek.length !== KEY_BYTES) throw new Error("DEK 不可用");
  const pass = stringOf(newPassword);
  if (pass.length < MIN_PASSWORD_LENGTH) throw new Error("新主密码至少 " + MIN_PASSWORD_LENGTH + " 位");

  const params = validateScrypt({ ...parsed.kdf, ...(options.scrypt || {}) });
  const saltBuffer = crypto.randomBytes(SALT_BYTES);
  const salt = saltBuffer.toString("base64");
  const kek = deriveKek(pass, saltBuffer, params);

  return {
    ...file,
    kdf: { name: KDF_NAME, N: params.N, r: params.r, p: params.p, salt, maxmem: params.maxmem },
    wrappedKey: seal(
      kek,
      dek,
      headerAad({ n: params.N, r: params.r, p: params.p, salt })
    ),
  };
}

/** 不解密，只看外壳。 */
function inspectVault(file) {
  try {
    const parsed = parseFile(file);
    return {
      ok: true,
      version: parsed.version,
      entryCount: parsed.entryCount,
      updatedAt: parsed.updatedAt,
      kdf: { N: parsed.kdf.N, r: parsed.kdf.r, p: parsed.kdf.p },
      guard: parsed.guard,
    };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

module.exports = {
  MAGIC,
  VERSION,
  KDF_NAME,
  DEFAULT_SCRYPT,
  MIN_PASSWORD_LENGTH,
  createVault,
  unlockVault,
  openWithDek,
  saveVault,
  changePassword,
  inspectVault,
  parseFile,
};
