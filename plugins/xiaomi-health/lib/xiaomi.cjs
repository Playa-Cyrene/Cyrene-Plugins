"use strict";
/**
 * 小米运动健康 CN 区客户端（自包含、纯 Node，无第三方依赖）。
 *
 * 由已验证可用的参考实现（miband-bot TS）忠实移植而来，只依赖 node:crypto 与
 * Node 24 全局 fetch / AbortSignal.any / Headers.getSetCookie。适配 CN：
 * baseUrl = https://hlth.io.mi.com（实测裸域可解出真实步数/睡眠/心率），
 * region_tag = "cn"，stsExchange 的 p_ur = "CN"。
 *
 * Token 结构（AuthToken）由调用方（插件 index.cjs）经 ctx.deps.secrets 注入 / 保存，
 * 本模块不落盘。
 */

const { createDecipheriv, createHash, randomBytes } = require("node:crypto");

const API_BASE_CN = "https://hlth.io.mi.com";
const STS_URL = "https://sts-hlth.io.mi.com/healthapp/sts";
const QR_URL = "https://account.xiaomi.com/longPolling/loginUrl";
const SERVICE_LOGIN_URL = "https://account.xiaomi.com/pass/serviceLogin";
const DEFAULT_UA = "Android-12-3.53.1-vivo-V2284A";
const LOGIN_UA =
  "Dalvik/2.1.0 (Linux; U; Android 12; V2284A Build/ab8c0d1.1) APP/mi.health APPV/353001 MK/VjIyODRB SDKV/5.3.0.release.68 CPN/com.mi.health PassportSDK/";
const XIAOMI_REQUEST_TIMEOUT_MS = 30_000;

class XiaomiError extends Error {}
class TokenExpiredError extends XiaomiError {}
class AuthError extends XiaomiError {}
class APIError extends XiaomiError {
  constructor(message, details = {}) {
    super(message);
    this.name = "APIError";
    this.details = details;
  }
}
class DataNotSharedError extends XiaomiError {
  constructor(message, dataType = "") {
    super(message);
    this.name = "DataNotSharedError";
    this.dataType = dataType;
  }
}
class FamilyMemberNotFoundError extends XiaomiError {}

// ── 编码/取值辅助 ────────────────────────────────────────────────
function base64(bytesIn) {
  return Buffer.from(bytesIn).toString("base64");
}
function bytes(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return new Uint8Array(Buffer.from(normalized, "base64"));
}
function asObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function numberValue(value, fallback = 0) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function stringValue(value, fallback = "") {
  return typeof value === "string" ? value : value === undefined || value === null ? fallback : String(value);
}
function parseValue(value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    return asObject(JSON.parse(value));
  } catch {
    return {};
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 加密原语：RC4 drop-1024（纯 JS，新版 OpenSSL 已移除 RC4）+ AES 走 node:crypto ──
function rc4(key, input, skip = 1024) {
  if (!key.length) throw new XiaomiError("RC4 key is empty");
  const s = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + (s[i] ?? 0) + (key[i % key.length] ?? 0)) & 255;
    const tmp = s[i]; s[i] = s[j]; s[j] = tmp;
  }
  let i = 0;
  j = 0;
  const next = () => {
    i = (i + 1) & 255;
    j = (j + (s[i] ?? 0)) & 255;
    const tmp = s[i]; s[i] = s[j]; s[j] = tmp;
    return s[((s[i] ?? 0) + (s[j] ?? 0)) & 255] ?? 0;
  };
  for (let n = 0; n < skip; n += 1) next();
  return Uint8Array.from(input, (value) => value ^ next());
}
function signedNonce(ssecurity, nonce) {
  const hash = createHash("sha256")
    .update(Buffer.concat([Buffer.from(ssecurity, "base64"), Buffer.from(nonce, "base64")]))
    .digest();
  return base64(hash);
}
function sha1Base64(value) {
  return createHash("sha1").update(value, "utf8").digest("base64");
}
function signatureMessage(method, path, params, nonce) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return [
    method.toUpperCase(),
    normalized,
    ...Object.keys(params).sort().map((key) => `${key}=${params[key]}`),
    nonce,
  ].join("&");
}
function encryptedParams(method, path, ssecurity, params) {
  const nonce = base64(
    Buffer.concat([
      randomBytes(8),
      (() => {
        const result = Buffer.alloc(4);
        result.writeUInt32BE(Math.floor(Date.now() / 60_000), 0);
        return result;
      })(),
    ]),
  );
  const snonce = signedNonce(ssecurity, nonce);
  const raw = {};
  if (params) raw.data = JSON.stringify(params);
  const rc4Hash = sha1Base64(signatureMessage(method, path, raw, snonce));
  raw.rc4_hash__ = rc4Hash;
  const entries = Object.entries(raw).sort(([a], [b]) => a.localeCompare(b));
  const plaintext = Buffer.concat(entries.map(([, value]) => Buffer.from(value, "utf8")));
  const encrypted = rc4(bytes(snonce), plaintext);
  const output = {};
  let position = 0;
  for (const [key, value] of entries) {
    const length = Buffer.byteLength(value, "utf8");
    output[key] = base64(encrypted.slice(position, position + length));
    position += length;
  }
  output.signature = sha1Base64(signatureMessage(method, path, output, snonce));
  output._nonce = nonce;
  return output;
}
function decryptResponse(ssecurity, nonce, ciphertext) {
  const snonce = signedNonce(ssecurity, nonce);
  const plaintext = Buffer.from(rc4(bytes(snonce), bytes(ciphertext))).toString("utf8");
  try {
    return JSON.parse(plaintext);
  } catch {
    return plaintext;
  }
}

// ── 解析聚合数据（睡眠时长字段单位为分钟；timezone=32 表示 UTC+8）──────
function dataItem(item) {
  const value = asObject(item);
  const raw = value.value;
  return {
    sid: stringValue(value.sid),
    tag: stringValue(value.tag),
    key: stringValue(value.key),
    time: numberValue(value.time),
    value: typeof raw === "string" ? raw : JSON.stringify(raw ?? {}),
    update_time: numberValue(value.update_time),
    watermark: stringValue(value.watermark),
  };
}
function parseSegments(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((x) => x && typeof x === "object").map((item) => {
    const entry = asObject(item);
    return {
      bedtime: numberValue(entry.bedtime),
      wake_up_time: numberValue(entry.wake_up_time),
      duration: numberValue(entry.duration),
      sleep_deep_duration: numberValue(entry.sleep_deep_duration),
      sleep_light_duration: numberValue(entry.sleep_light_duration),
      timezone: numberValue(entry.timezone),
      sleep_awake_duration: numberValue(entry.sleep_awake_duration),
    };
  });
}
function parseAggregated(item, key) {
  const value = parseValue(item.value);
  value.time = item.time;
  if (key === "sleep") value.segment_details = parseSegments(value.segment_details);
  return value;
}
function parseHeartRate(item) {
  const value = parseAggregated(item, "heart_rate");
  const latest = asObject(value.latest_hr);
  return {
    time: numberValue(value.time),
    avg_hr: numberValue(value.avg_hr),
    avg_rhr: numberValue(value.avg_rhr),
    max_hr: numberValue(value.max_hr),
    min_hr: numberValue(value.min_hr),
    latest_hr: Object.keys(latest).length ? { bpm: numberValue(latest.bpm), time: numberValue(latest.time) } : null,
  };
}
function parseSleep(item) {
  const value = parseAggregated(item, "sleep");
  return {
    time: numberValue(value.time),
    total_duration: numberValue(value.total_duration),
    sleep_score: numberValue(value.sleep_score),
    sleep_deep_duration: numberValue(value.sleep_deep_duration),
    sleep_light_duration: numberValue(value.sleep_light_duration),
    sleep_rem_duration: numberValue(value.sleep_rem_duration),
    sleep_awake_duration: numberValue(value.sleep_awake_duration),
    avg_hr: numberValue(value.avg_hr),
    avg_spo2: numberValue(value.avg_spo2),
    segment_details: parseSegments(value.segment_details),
  };
}
function parseSteps(item) {
  const value = parseAggregated(item, "steps");
  return {
    time: numberValue(value.time),
    steps: numberValue(value.steps),
    distance: numberValue(value.distance),
    calories: numberValue(value.calories),
    goal: numberValue(value.goal),
  };
}
function windowArguments(queryDateOrDays, days = 1) {
  if (typeof queryDateOrDays === "number") return [new Date(), Math.max(1, queryDateOrDays)];
  return [queryDateOrDays ?? new Date(), Math.max(1, days)];
}
function dateWindow(days, queryDate = new Date()) {
  const endDate = new Date(
    Date.UTC(queryDate.getUTCFullYear(), queryDate.getUTCMonth(), queryDate.getUTCDate() + 1, 0, 0, 0),
  );
  const end = Math.floor(endDate.getTime() / 1000) - 1;
  const windowDays = Math.max(1, days);
  return [end - 86_400 * windowDays + 1, end, windowDays];
}

// ── HTTP（自动维护 cookie、30s 超时、redirect manual）──────────────
class XiaomiHttp {
  constructor(headers) {
    this._headers = headers;
    this.cookies = new Map();
  }
  setCookie(name, value) {
    this.cookies.set(name, value);
  }
  async request(url, init = {}) {
    const headers = new Headers(this._headers);
    for (const [key, value] of Object.entries(init.headers ?? {})) headers.set(key, value);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), XIAOMI_REQUEST_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    try {
      const response = await fetch(url, { ...init, headers, redirect: "manual", signal });
      for (const cookie of response.headers.getSetCookie?.() ?? []) {
        const pair = cookie.split(";", 1)[0] ?? "";
        const index = pair.indexOf("=");
        if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
      const body = await response.arrayBuffer();
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
      clearTimeout(timeout);
    }
  }
  get cookiesSnapshot() {
    return Object.fromEntries(this.cookies);
  }
}

function parseMiResponse(text) {
  const body = text.startsWith("&&&START&&&") ? text.slice("&&&START&&&".length) : text;
  try {
    return asObject(JSON.parse(body));
  } catch {
    throw new XiaomiError(`Xiaomi response is not JSON: ${body.slice(0, 200)}`);
  }
}

// ── 认证：扫码登录 + STS 交换 + passToken 刷新 ──────────────────────
class XiaomiAuth {
  constructor(token) {
    this.token = token || {
      user_id: "",
      c_user_id: "",
      service_token: "",
      ssecurity: "",
      pass_token: "",
      device_id: `an_${randomBytes(16).toString("hex")}`,
    };
    this.http = new XiaomiHttp({ "user-agent": LOGIN_UA, "content-type": "application/x-www-form-urlencoded" });
  }
  get isAuthenticated() {
    return Boolean(this.token.service_token && this.token.ssecurity);
  }
  get canRefresh() {
    return Boolean(this.token.pass_token && this.token.user_id);
  }
  /**
   * 扫码登录。callback(qrImageUrl, loginUrl) 拿到成品二维码图片地址（带 &_qrsize=480，
   * 直接 GET 即 PNG）。轮询 lp 直到扫码确认，取 ssecurity/userId/passToken/cUserId/location，
   * 跟随 location 拿 serviceToken，最后 stsExchange。
   */
  async loginQr(callback, maxWait = 300) {
    this.http.setCookie("deviceId", this.token.device_id);
    const query = new URLSearchParams({
      _qrsize: "480",
      qs: "%3Fsid%3Dmiothealth%26_json%3Dtrue",
      callback: STS_URL,
      _hasLogo: "false",
      sid: "miothealth",
      serviceParam: "",
      _locale: "zh_CN",
      _dc: String(Date.now()),
    });
    const qrResponse = await this.http.request(`${QR_URL}?${query}`);
    if (!qrResponse.ok) throw new XiaomiError(`QR request failed: ${qrResponse.status}`);
    const qr = parseMiResponse(await qrResponse.text());
    const image = stringValue(qr.qr);
    const loginUrl = stringValue(qr.loginUrl);
    const pollingUrl = stringValue(qr.lp);
    if (!image || !pollingUrl) throw new XiaomiError("Xiaomi did not return a QR polling URL");
    if (callback) await callback(image, loginUrl);
    const timeout = Math.min(numberValue(qr.timeout, maxWait), maxWait) * 1000;
    const started = Date.now();
    let response;
    while (Date.now() - started < timeout) {
      try {
        response = await this.http.request(pollingUrl);
        if (response.status === 200) break;
        await sleep(2000);
      } catch {
        await sleep(2000);
      }
    }
    if (!response || response.status !== 200) throw new XiaomiError("Xiaomi QR login timed out");
    const data = parseMiResponse(await response.text());
    this.token.ssecurity = stringValue(data.ssecurity);
    this.token.user_id = stringValue(data.userId);
    this.token.pass_token = stringValue(data.passToken);
    this.token.c_user_id = stringValue(data.cUserId);
    const location = stringValue(data.location);
    if (location) {
      const redirect = await this.http.request(location);
      const locationHeader = redirect.headers.get("location") ?? location;
      this.token.service_token =
        stringValue(this.http.cookiesSnapshot.serviceToken) ||
        stringValue(new URL(locationHeader).searchParams.get("serviceToken"));
    }
    if (!this.token.service_token) throw new XiaomiError("Xiaomi login did not return serviceToken");
    await this.stsExchange();
    return this.token;
  }
  async stsExchange() {
    const query = new URLSearchParams({
      d: this.token.device_id,
      ticket: "0",
      pwd: "0",
      p_ts: String(Date.now()),
      fid: "0",
      p_lm: "2",
      p_ur: "CN",
      sid: "hlth.io.mi.com",
    });
    const response = await this.http.request(`${STS_URL}?${query}`);
    if (response.ok && (await response.text()).trim() === "ok") {
      const serviceToken = this.http.cookiesSnapshot.serviceToken;
      if (serviceToken) this.token.service_token = serviceToken;
    }
  }
  async refreshWithPassToken() {
    if (!this.token.pass_token || !this.token.user_id) {
      throw new TokenExpiredError("Xiaomi passToken credentials are missing");
    }
    this.http.setCookie("passToken", this.token.pass_token);
    this.http.setCookie("deviceId", this.token.device_id);
    this.http.setCookie("userId", this.token.user_id);
    const query = new URLSearchParams({ _json: "true", sid: "miothealth" });
    const response = await this.http.request(`${SERVICE_LOGIN_URL}?${query}`);
    if (!response.ok) throw new TokenExpiredError(`Xiaomi token refresh failed: ${response.status}`);
    const data = parseMiResponse(await response.text());
    const ssecurity = stringValue(data.ssecurity);
    if (!ssecurity) throw new TokenExpiredError("Xiaomi serviceLogin did not return ssecurity");
    const previous = {
      c_user_id: this.token.c_user_id,
      service_token: this.token.service_token,
      ssecurity: this.token.ssecurity,
    };
    const nextCUserId = stringValue(data.cUserId, this.token.c_user_id);
    if (nextCUserId) this.http.setCookie("cUserId", nextCUserId);
    let nextServiceToken = "";
    const location = stringValue(data.location);
    if (location) {
      const nonce = stringValue(data.nonce);
      const clientSign = encodeURIComponent(sha1Base64(`nonce=${nonce}&${ssecurity}`)).replaceAll("%2F", "/");
      const redirect = await this.http.request(`${location}&clientSign=${clientSign}`);
      const locationHeader = redirect.headers.get("location") ?? location;
      const serviceToken =
        stringValue(this.http.cookiesSnapshot.serviceToken) ||
        stringValue(new URL(locationHeader).searchParams.get("serviceToken"));
      if (serviceToken) nextServiceToken = serviceToken;
    }
    await this.stsExchange();
    nextServiceToken ||= stringValue(this.http.cookiesSnapshot.serviceToken);
    if (!nextServiceToken || nextServiceToken === previous.service_token) {
      this.token.c_user_id = previous.c_user_id;
      this.token.service_token = previous.service_token;
      this.token.ssecurity = previous.ssecurity;
      throw new TokenExpiredError("Xiaomi token refresh did not return a new serviceToken");
    }
    this.token.c_user_id = nextCUserId;
    this.token.service_token = nextServiceToken;
    this.token.ssecurity = ssecurity;
    return this.token;
  }
}

// ── 健康数据客户端（CN）─────────────────────────────────────────────
class MiHealthClient {
  constructor(auth, baseUrl = API_BASE_CN) {
    this.auth = auth;
    this.baseUrl = baseUrl;
    this.http = new XiaomiHttp({ "user-agent": DEFAULT_UA, region_tag: "cn", handleparams: "true" });
    this._refreshPromise = undefined;
  }
  async request(method, path, params, retry = true) {
    if (!this.auth.token.service_token || !this.auth.token.ssecurity)
      throw new XiaomiError("Xiaomi token is not authenticated");
    this.http.setCookie("cUserId", this.auth.token.c_user_id);
    this.http.setCookie("serviceToken", this.auth.token.service_token);
    const signingPath = path === "/healthapp/service/gen_download_url" ? "/service/gen_download_url" : path;
    const encoded = encryptedParams(method, signingPath, this.auth.token.ssecurity, params);
    const url = new URL(`${this.baseUrl}${path}`);
    if (method.toUpperCase() === "GET")
      for (const [key, value] of Object.entries(encoded)) url.searchParams.set(key, value);
    const response = await this.http.request(url.toString(), {
      method,
      ...(method.toUpperCase() === "GET" ? {} : { body: new URLSearchParams(encoded) }),
      headers: method.toUpperCase() === "GET" ? undefined : { "content-type": "application/x-www-form-urlencoded" },
    });
    if (response.status === 401) {
      if (!retry || !this.auth.token.pass_token || !this.auth.token.user_id)
        throw new TokenExpiredError("Xiaomi token expired");
      await this._refresh();
      return this.request(method, path, params, false);
    }
    if (!response.ok)
      throw new APIError(`Xiaomi API ${method} ${path} failed: ${response.status}`, { statusCode: response.status });
    const nonce = encoded._nonce;
    if (!nonce) throw new XiaomiError("Xiaomi request nonce is missing");
    const decrypted = decryptResponse(this.auth.token.ssecurity, nonce, await response.text());
    const result = asObject(decrypted);
    const code = numberValue(result.code, -1);
    if (code !== 0) {
      const message = stringValue(result.message ?? result.msg ?? result.desc ?? result.description, "unknown error");
      const requestedKey = stringValue(params && params.key);
      if (code === -4002001) throw new FamilyMemberNotFoundError(`Not a family member: ${message}`);
      if (code === -4002004) throw new DataNotSharedError(message, requestedKey);
      throw new APIError(`Xiaomi API error ${code}: ${message}`, { code });
    }
    return result;
  }
  async _refresh() {
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = (async () => {
      await this.auth.refreshWithPassToken();
    })().finally(() => {
      this._refreshPromise = undefined;
    });
    return this._refreshPromise;
  }
  async getAggregatedData(uid, key, start, end, limitOrOptions = 30) {
    const options = typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
    const response = await this.request("GET", "/app/v1/data/get_aggregated_fitness_data_by_time", {
      relative_uid: uid,
      key,
      tag: options.tag ?? "daily_report",
      start_time: start,
      end_time: end,
      limit: options.limit ?? 30,
    });
    const result = asObject(response.result);
    return (Array.isArray(result.data_list) ? result.data_list : []).map(dataItem);
  }
  async getSteps(uid, queryDateOrDays = 1, options = {}) {
    const [queryDate, days] = windowArguments(queryDateOrDays, options.days);
    const [start, end, limit] = dateWindow(days, queryDate);
    return (await this.getAggregatedData(uid, "steps", start, end, limit)).map(parseSteps);
  }
  async getSleep(uid, queryDateOrDays = 1, options = {}) {
    const [queryDate, days] = windowArguments(queryDateOrDays, options.days);
    const [start, end, limit] = dateWindow(days, queryDate);
    return (await this.getAggregatedData(uid, "sleep", start, end, limit)).map(parseSleep);
  }
  async getHeartRate(uid, queryDateOrDays = 1, options = {}) {
    const [queryDate, days] = windowArguments(queryDateOrDays, options.days);
    const [start, end, limit] = dateWindow(days, queryDate);
    return (await this.getAggregatedData(uid, "heart_rate", start, end, limit)).map(parseHeartRate);
  }
  /** 某天的三合一摘要（步数/睡眠/心率），DataNotShared 的项降级为 null。 */
  async getDailySummary(uid, queryDate = new Date()) {
    const grab = (p) =>
      p.then((items) => items[0] ?? null).catch((error) => {
        if (error instanceof DataNotSharedError) return null;
        throw error;
      });
    const [heartRate, sleep, steps] = await Promise.all([
      grab(this.getHeartRate(uid, queryDate)),
      grab(this.getSleep(uid, queryDate)),
      grab(this.getSteps(uid, queryDate)),
    ]);
    return { date: queryDate.toISOString().slice(0, 10), relative_uid: uid, heart_rate: heartRate, sleep, steps };
  }
}

module.exports = {
  API_BASE_CN,
  XIAOMI_REQUEST_TIMEOUT_MS,
  XiaomiError,
  TokenExpiredError,
  AuthError,
  APIError,
  DataNotSharedError,
  FamilyMemberNotFoundError,
  XiaomiAuth,
  MiHealthClient,
  __internals: { rc4, signedNonce, encryptedParams, decryptResponse, sha1Base64, signatureMessage },
};
