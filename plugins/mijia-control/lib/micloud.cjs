"use strict";
/**
 * 米家云（MiOT Cloud）自包含客户端 —— 纯 Node，无第三方依赖。
 *
 * 忠实移植自已验证可用的社区实现 micloud / al-one hass-xiaomi-miot 的签名方案：
 *   - 登录：account.xiaomi.com 扫码（sid=xiaomiio，回调 sts.api.io.mi.com/sts）；
 *   - 请求：api.io.mi.com/app 的 RC4 drop-1024 签名（signed_nonce = sha256(ssecurity+nonce)）；
 *   - 控制：miotspec/prop/get · miotspec/prop/set · miotspec/action；
 *   - 设备：home/device_list；房间：v2/homeroom/gethome_merged。
 *
 * Token 由调用方（index.cjs）经 ctx.deps.secrets 注入 / 保存，本模块不落盘。
 * 仅依赖 node:crypto 与 Node 全局 fetch / AbortSignal / Headers.getSetCookie。
 */

const { createHash, randomBytes } = require("node:crypto");

const ACCOUNT_BASE = "https://account.xiaomi.com";
const QR_URL = `${ACCOUNT_BASE}/longPolling/loginUrl`;
const SERVICE_LOGIN_URL = `${ACCOUNT_BASE}/pass/serviceLogin`;
const STS_URL = "https://sts.api.io.mi.com/sts";
const API_BASE = "https://api.io.mi.com/app";
const LOGIN_SID = "xiaomiio";
const REQUEST_TIMEOUT_MS = 30_000;
// 米家 App 风格的 UA，云端对 UA 有一定识别度，沿用社区验证值。
const SMARTHOME_UA =
  "Android-7.1.1-1.0.0-ONEPLUS A3010-136-APP/xiaomi.smarthome APPV/62830";
const LOGIN_UA =
  "Mozilla/5.0 (Linux; U; Android 12; zh-cn) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 MicroMessenger";

class MiCloudError extends Error {}
class TokenExpiredError extends MiCloudError {}

// ── 编码辅助 ────────────────────────────────────────────────────
function b64(bytesIn) {
  return Buffer.from(bytesIn).toString("base64");
}
function unb64(value) {
  const normalized = String(value)
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  return new Uint8Array(Buffer.from(normalized, "base64"));
}
function asObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function stringValue(value, fallback = "") {
  return typeof value === "string" ? value : value === undefined || value === null ? fallback : String(value);
}
function numberValue(value, fallback = 0) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function jsonEncode(data) {
  return JSON.stringify(data);
}

// ── 加密原语：RC4 drop-1024（纯 JS，新版 OpenSSL 已移除 RC4）──────────
function rc4(keyBytes, inputBytes, skip = 1024) {
  if (!keyBytes.length) throw new MiCloudError("RC4 key is empty");
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + keyBytes[i % keyBytes.length]) & 255;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }
  let i = 0;
  j = 0;
  const next = () => {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    const t = s[i]; s[i] = s[j]; s[j] = t;
    return s[(s[i] + s[j]) & 255];
  };
  for (let n = 0; n < skip; n += 1) next();
  return Uint8Array.from(inputBytes, (v) => v ^ next());
}
function genNonce() {
  const part2 = Math.floor(Date.now() / 60_000);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(part2 >>> 0, 0);
  return b64(Buffer.concat([randomBytes(8), tail]));
}
function signedNonce(ssecurity, nonce) {
  const hash = createHash("sha256")
    .update(Buffer.concat([Buffer.from(ssecurity, "base64"), Buffer.from(nonce, "base64")]))
    .digest();
  return b64(hash);
}
function sha1Base64(value) {
  return createHash("sha1").update(value, "utf8").digest("base64");
}
// 签名路径：去掉 /app 前缀（/app/miotspec/action → /miotspec/action）
function signPath(url) {
  const path = new URL(url).pathname;
  return path.startsWith("/app/") ? path.slice(4) : path;
}
function sha1Sign(method, url, params, snonce) {
  const arr = [String(method).toUpperCase(), signPath(url)];
  for (const [k, v] of Object.entries(params)) arr.push(`${k}=${v}`);
  arr.push(snonce);
  return sha1Base64(arr.join("&"));
}
function encryptData(snonce, text) {
  return b64(rc4(unb64(snonce), new Uint8Array(Buffer.from(text, "utf8"))));
}
function decryptData(snonce, cipherB64) {
  return Buffer.from(rc4(unb64(snonce), unb64(cipherB64))).toString("utf8");
}
// 每个值单独 RC4 加密；参数按插入顺序参与签名（不可排序，否则签名不符）。
function rc4Params(method, url, params, ssec) {
  const nonce = genNonce();
  const sn = signedNonce(ssec, nonce);
  const body = { ...params };
  body.rc4_hash__ = sha1Sign(method, url, body, sn);
  for (const k of Object.keys(body)) body[k] = encryptData(sn, String(body[k]));
  body.signature = sha1Sign(method, url, body, sn);
  body.ssecurity = ssec;
  body._nonce = nonce;
  return { body, snonce: sn };
}

function parseMiResponse(text) {
  const body = text.startsWith("&&&START&&&") ? text.slice("&&&START&&&".length) : text;
  try {
    return asObject(JSON.parse(body));
  } catch {
    throw new MiCloudError(`Xiaomi response is not JSON: ${body.slice(0, 200)}`);
  }
}

// ── HTTP（维护 cookie、30s 超时、redirect manual）───────────────────
class MiHttp {
  constructor(baseHeaders) {
    this._headers = baseHeaders;
    this.cookies = new Map();
  }
  setCookie(name, value) {
    if (value !== undefined && value !== null && value !== "") this.cookies.set(name, String(value));
  }
  async request(url, init = {}) {
    const headers = new Headers(this._headers);
    for (const [k, v] of Object.entries(init.headers ?? {})) headers.set(k, v);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    try {
      const response = await fetch(url, { ...init, headers, redirect: "manual", signal });
      for (const cookie of response.headers.getSetCookie?.() ?? []) {
        const pair = cookie.split(";", 1)[0] ?? "";
        const idx = pair.indexOf("=");
        if (idx > 0) this.cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }
  get cookieSnapshot() {
    return Object.fromEntries(this.cookies);
  }
}

// ── 认证：扫码登录（sid=xiaomiio）+ passToken 刷新 ─────────────────────
class MiCloudAuth {
  constructor(token) {
    this.token = token || {
      user_id: "",
      c_user_id: "",
      service_token: "",
      ssecurity: "",
      pass_token: "",
      device_id: `an_${randomBytes(16).toString("hex")}`,
    };
    this.http = new MiHttp({ "user-agent": LOGIN_UA, "content-type": "application/x-www-form-urlencoded" });
  }
  get isAuthenticated() {
    return Boolean(this.token.service_token && this.token.ssecurity && this.token.user_id);
  }
  get canRefresh() {
    return Boolean(this.token.pass_token && this.token.user_id);
  }
  /**
   * 扫码登录。callback(qrImageUrl, loginUrl) 拿到二维码图片地址；轮询直到确认，
   * 取 ssecurity/userId/passToken/cUserId/location，跟随 location 拿 serviceToken。
   */
  async loginQr(onQr, maxWait = 300) {
    this.http.setCookie("deviceId", this.token.device_id);
    const query = new URLSearchParams({
      _qrsize: "480",
      qs: "%3Fsid%3Dxiaomiio%26_json%3Dtrue",
      callback: STS_URL,
      _hasLogo: "false",
      sid: LOGIN_SID,
      serviceParam: "",
      _locale: "zh_CN",
      _dc: String(Date.now()),
    });
    const qrResp = await this.http.request(`${QR_URL}?${query}`);
    if (!qrResp.ok) throw new MiCloudError(`QR request failed: ${qrResp.status}`);
    const qr = parseMiResponse(await qrResp.text());
    const image = stringValue(qr.qr);
    const loginUrl = stringValue(qr.loginUrl);
    const pollingUrl = stringValue(qr.lp);
    if (!image || !pollingUrl) throw new MiCloudError("Xiaomi did not return a QR polling URL");
    if (onQr) await onQr(image, loginUrl);
    const timeout = Math.min(numberValue(qr.timeout, maxWait), maxWait) * 1000;
    const started = Date.now();
    let resp;
    while (Date.now() - started < timeout) {
      try {
        resp = await this.http.request(pollingUrl);
        if (resp.status === 200) break;
        await sleep(2000);
      } catch {
        await sleep(2000);
      }
    }
    if (!resp || resp.status !== 200) throw new MiCloudError("Xiaomi QR login timed out");
    const data = parseMiResponse(await resp.text());
    this.token.ssecurity = stringValue(data.ssecurity);
    this.token.user_id = stringValue(data.userId);
    this.token.pass_token = stringValue(data.passToken);
    this.token.c_user_id = stringValue(data.cUserId);
    const location = stringValue(data.location);
    if (location) {
      const redirect = await this.http.request(location);
      const loc = redirect.headers.get("location") ?? location;
      this.token.service_token =
        stringValue(this.http.cookieSnapshot.serviceToken) ||
        stringValue(new URL(loc).searchParams.get("serviceToken"));
    }
    if (!this.token.service_token) throw new MiCloudError("Xiaomi login did not return serviceToken");
    return this.token;
  }
  async refreshWithPassToken() {
    if (!this.canRefresh) throw new TokenExpiredError("Xiaomi passToken credentials are missing");
    this.http.setCookie("passToken", this.token.pass_token);
    this.http.setCookie("deviceId", this.token.device_id);
    this.http.setCookie("userId", this.token.user_id);
    const query = new URLSearchParams({ _json: "true", sid: LOGIN_SID });
    const resp = await this.http.request(`${SERVICE_LOGIN_URL}?${query}`);
    if (!resp.ok) throw new TokenExpiredError(`Xiaomi token refresh failed: ${resp.status}`);
    const data = parseMiResponse(await resp.text());
    const ssec = stringValue(data.ssecurity);
    if (!ssec) throw new TokenExpiredError("Xiaomi serviceLogin did not return ssecurity");
    this.token.ssecurity = ssec;
    const nextCUserId = stringValue(data.cUserId, this.token.c_user_id);
    if (nextCUserId) this.http.setCookie("cUserId", nextCUserId);
    const location = stringValue(data.location);
    let nextServiceToken = "";
    if (location) {
      const nonce = stringValue(data.nonce);
      const clientSign = encodeURIComponent(sha1Base64(`nonce=${nonce}&${ssec}`)).replaceAll("%2F", "/");
      const redirect = await this.http.request(`${location}&clientSign=${clientSign}`);
      const loc = redirect.headers.get("location") ?? location;
      nextServiceToken =
        stringValue(this.http.cookieSnapshot.serviceToken) ||
        stringValue(new URL(loc).searchParams.get("serviceToken"));
    }
    nextServiceToken ||= stringValue(this.http.cookieSnapshot.serviceToken);
    if (!nextServiceToken) throw new TokenExpiredError("Xiaomi token refresh did not return serviceToken");
    this.token.c_user_id = nextCUserId;
    this.token.service_token = nextServiceToken;
    return this.token;
  }
}

// ── 米家云客户端 ────────────────────────────────────────────────────
class MiCloudClient {
  constructor(auth) {
    this.auth = auth;
    this.http = new MiHttp({
      "user-agent": SMARTHOME_UA,
      "content-type": "application/x-www-form-urlencoded",
      "miot-encrypt-algorithm": "ENCRYPT-RC4",
      "accept-encoding": "identity",
      "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
    });
    this._refreshPromise = undefined;
  }
  _syncCookies() {
    const t = this.auth.token;
    this.http.setCookie("userId", t.user_id);
    this.http.setCookie("cUserId", t.c_user_id);
    this.http.setCookie("serviceToken", t.service_token);
    this.http.setCookie("yetAnotherServiceToken", t.service_token);
    this.http.setCookie("deviceId", t.device_id);
    this.http.setCookie("channel", "MI_APP_STORE");
  }
  async request(method, api, dataObj, retry = true) {
    const t = this.auth.token;
    if (!t.service_token || !t.ssecurity || !t.user_id) throw new MiCloudError("米家云未登录");
    this._syncCookies();
    const url = `${API_BASE}/${String(api).replace(/^\/+/, "")}`;
    const { body, snonce } = rc4Params(method, url, { data: jsonEncode(dataObj ?? {}) }, t.ssecurity);
    const resp = await this.http.request(url, {
      method,
      ...(method.toUpperCase() === "GET"
        ? {}
        : { body: new URLSearchParams(body) }),
    });
    if (resp.status === 401 || resp.status === 403) {
      if (!retry || !this.auth.canRefresh) throw new TokenExpiredError("米家登录已过期");
      await this._refresh();
      return this.request(method, api, dataObj, false);
    }
    const text = await resp.text();
    if (!resp.ok) throw new MiCloudError(`米家云 ${api} 失败：HTTP ${resp.status}`);
    let payload = text;
    if (!text.includes("{")) {
      // 密文响应：先解密再解析
      payload = decryptData(snonce, text.trim());
    } else {
      // 少数端点返回明文 JSON；若带 rc4 头仍尝试解密兜底
      try {
        payload = decryptData(snonce, text.trim());
        JSON.parse(payload);
      } catch {
        payload = text.startsWith("&&&START&&&") ? text.slice("&&&START&&&".length) : text;
      }
    }
    let result;
    try {
      result = asObject(JSON.parse(payload));
    } catch {
      throw new MiCloudError(`米家云 ${api} 响应解析失败：${payload.slice(0, 160)}`);
    }
    const code = numberValue(result.code, 0);
    if (code !== 0) {
      const msg = stringValue(result.message ?? result.msg ?? result.description, "unknown");
      if (code === -9 || code === 3 || /token|auth|unauthor/i.test(msg)) throw new TokenExpiredError(`米家鉴权失败：${msg}`);
      throw new MiCloudError(`米家云 ${api} 错误 ${code}：${msg}`);
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

  // 设备列表（含 did/name/model/localip/token/isOnline/extra 等）
  // 拉全部设备（含手环/手表等穿戴）；能否操控交由各设备的 MIoT-Spec 判定（见 lib/miot_spec.cjs）。
  async getDevices() {
    const resp = await this.request("POST", "home/device_list", {
      getVirtualModel: true,
      getHuamiDevices: 1,
      get_split_device: false,
      support_smart_home: true,
    });
    return Array.isArray(resp.result?.list) ? resp.result.list : [];
  }
  // 房间归属：did → { homeName, roomName }
  async getRoomMap() {
    const resp = await this.request("POST", "v2/homeroom/gethome_merged", {
      fg: true,
      fetch_share: true,
      fetch_share_dev: true,
      fetch_cariot: true,
      limit: 300,
      app_ver: 7,
      plat_form: 0,
    });
    const map = {};
    const homes = Array.isArray(resp.result?.homelist) ? resp.result.homelist : [];
    for (const h of homes) {
      for (const r of Array.isArray(h.roomlist) ? h.roomlist : []) {
        for (const did of Array.isArray(r.dids) ? r.dids : []) {
          map[String(did)] = { homeName: stringValue(h.name), roomName: stringValue(r.name) };
        }
      }
    }
    return map;
  }
  // 读取属性：props = [{did, siid, piid}]
  async getProps(props) {
    const resp = await this.request("POST", "miotspec/prop/get", {
      params: props.map((p) => ({ did: String(p.did), siid: p.siid, piid: p.piid })),
    });
    return Array.isArray(resp.result) ? resp.result : [];
  }
  // 写属性：props = [{did, siid, piid, value}]
  async setProp(did, siid, piid, value) {
    const resp = await this.request("POST", "miotspec/prop/set", {
      params: [{ did: String(did), siid, piid, value }],
    });
    return Array.isArray(resp.result) ? resp.result[0] : resp.result;
  }
  // 执行动作：{did, siid, aiid, in:[]}
  async callAction(did, siid, aiid, inArgs = []) {
    const resp = await this.request("POST", "miotspec/action", {
      params: [{ did: String(did), siid, aiid, in: inArgs }],
    });
    return Array.isArray(resp.result) ? resp.result[0] : resp.result;
  }
}

module.exports = {
  MiCloudError,
  TokenExpiredError,
  MiCloudAuth,
  MiCloudClient,
  __internals: { rc4, signedNonce, genNonce, sha1Sign, encryptData, decryptData, rc4Params },
};
