"use strict";

/**
 * TOTP 核心（RFC 6238）
 *
 * 只依赖 Node 内置 crypto。secret 用 Base32，支持 SHA1 / SHA256 / SHA512，
 * 6 位或 8 位，默认 30 秒一步。
 */

const crypto = require("node:crypto");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ALGORITHMS = { sha1: "sha1", sha256: "sha256", sha512: "sha512" };

function base32Decode(input) {
  const clean = String(input || "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/=+$/, "");
  if (!clean) throw new Error("secret 是空的");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("secret 里含有不是 Base32 的字符：" + ch);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function normalizeSecret(input) {
  return String(input || "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/=+$/, "");
}

function hotp(key, counter, digits, algorithm) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac(algorithm, key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const bin =
    (((digest[offset] & 0x7f) << 24) |
      (digest[offset + 1] << 16) |
      (digest[offset + 2] << 8) |
      digest[offset + 3]) >>>
    0;
  const mod = 10 ** digits;
  return String(bin % mod).padStart(digits, "0");
}

function normalizeOptions(opts) {
  const digits = Number(opts && opts.digits) || 6;
  const period = Number(opts && opts.period) || 30;
  const algorithm = String((opts && opts.algorithm) || "sha1").toLowerCase();
  if (digits !== 6 && digits !== 8) throw new Error("digits 只支持 6 或 8");
  if (!Number.isFinite(period) || period < 10 || period > 300) {
    throw new Error("period 需要在 10 到 300 秒之间");
  }
  if (!ALGORITHMS[algorithm]) throw new Error("algorithm 只支持 SHA1 / SHA256 / SHA512");
  return { digits, period, algorithm };
}

/**
 * 生成当前验证码。
 * @param {{secret:string, digits?:number, period?:number, algorithm?:string, now?:number}} opts
 * @returns {{code:string, remaining:number, period:number, counter:number, progress:number}}
 */
function generateTotp(opts) {
  const secret = normalizeSecret(opts && opts.secret);
  const key = base32Decode(secret);
  const { digits, period, algorithm } = normalizeOptions(opts);
  const now = Number(opts && opts.now) || Date.now();
  const counter = Math.floor(now / 1000 / period);
  const code = hotp(key, counter, digits, algorithm);
  const elapsed = (now / 1000) % period;
  const remaining = Math.max(1, Math.ceil(period - elapsed));
  return {
    code,
    remaining,
    period,
    counter,
    progress: elapsed / period,
  };
}

function formatCode(code) {
  const text = String(code || "");
  if (text.length === 6) return text.slice(0, 3) + " " + text.slice(3);
  if (text.length === 8) return text.slice(0, 4) + " " + text.slice(4);
  return text;
}

/**
 * 解析 otpauth://totp/... 链接。
 * 也接受只填了 secret 的裸字符串（此时 issuer / account 由调用方另给）。
 */
function parseOtpauth(uri) {
  const raw = String(uri || "").trim();
  if (!raw) throw new Error("链接是空的");
  if (!/^otpauth:\/\//i.test(raw)) throw new Error("不是 otpauth:// 开头的链接");

  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("链接格式不对，无法解析");
  }
  const type = String(u.host || "").toLowerCase();
  if (type !== "totp") {
    if (type === "hotp") throw new Error("暂不支持 HOTP（计数器型）");
    throw new Error("只支持 totp 类型");
  }

  const label = decodeURIComponent(String(u.pathname || "").replace(/^\/+/, "")).trim();
  const segments = label.split(":");
  const labelIssuer = segments.length > 1 ? segments[0].trim() : "";
  const account = (segments.length > 1 ? segments.slice(1).join(":") : label).trim();

  const issuer = String(u.searchParams.get("issuer") || labelIssuer || "").trim();
  const secret = normalizeSecret(u.searchParams.get("secret") || "");
  if (!secret) throw new Error("链接里没有 secret 参数");

  const digits = Number(u.searchParams.get("digits") || 6);
  const period = Number(u.searchParams.get("period") || 30);
  const algorithm = String(u.searchParams.get("algorithm") || "SHA1").toLowerCase();

  const normalized = normalizeOptions({ digits, period, algorithm });
  base32Decode(secret);
  if (!account) throw new Error("链接里没有账号名");

  return {
    issuer: issuer || "未命名",
    account,
    secret,
    digits: normalized.digits,
    period: normalized.period,
    algorithm: normalized.algorithm,
  };
}

/** 把用户手动输入的三项组装成同一种条目结构。 */
function buildEntry(input) {
  const issuer = String((input && input.issuer) || "").trim() || "未命名";
  const account = String((input && input.account) || "").trim();
  const secret = normalizeSecret(input && input.secret);
  if (!account) throw new Error("账号名不能为空");
  if (!secret) throw new Error("secret 不能为空");
  base32Decode(secret);
  const normalized = normalizeOptions(input || {});
  return {
    issuer,
    account,
    secret,
    digits: normalized.digits,
    period: normalized.period,
    algorithm: normalized.algorithm,
  };
}

module.exports = {
  base32Decode,
  normalizeSecret,
  generateTotp,
  formatCode,
  parseOtpauth,
  buildEntry,
};
