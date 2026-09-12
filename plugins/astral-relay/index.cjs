"use strict";

// src/core/gate.ts
var DEFAULT_WINDOW_TTL_MS = 18e4;
function createGate(options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_WINDOW_TTL_MS;
  const now = options.now ?? (() => Date.now());
  let openedAt = 0;
  const isExpired = () => openedAt !== 0 && now() - openedAt > ttlMs;
  return {
    open() {
      openedAt = now();
    },
    close() {
      openedAt = 0;
    },
    check(token, expectedToken) {
      if (!constantTimeEquals(token, expectedToken)) return { allowed: false, code: "bad_token" };
      if (openedAt === 0) return { allowed: false, code: "closed" };
      if (isExpired()) {
        openedAt = 0;
        return { allowed: false, code: "expired" };
      }
      return { allowed: true };
    },
    snapshot() {
      if (isExpired()) return { open: false, openedAt: 0 };
      return { open: openedAt !== 0, openedAt };
    }
  };
}
function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// src/core/providers.ts
var PROVIDERS = [
  {
    id: "grok",
    label: "xAI Grok（订阅 OAuth）",
    kind: "general",
    available: true,
    experimental: true,
    auth: "oauth",
    protocol: "openai",
    baseUrl: "https://api.x.ai/v1",
    termsUrl: "https://x.ai/news/grok-opencode",
    note: "使用 Grok OAuth 连接订阅；支持 Chat、Work、Learn、Code 全模式。"
  },
  {
    id: "minimax",
    label: "MiniMax Token Plan",
    kind: "general",
    available: true,
    regions: [
      { id: "global", label: "国际站", baseUrl: "https://api.minimax.io/v1" },
      { id: "cn", label: "中国大陆", baseUrl: "https://api.minimaxi.com/v1" }
    ],
    keyPrefix: "sk-cp-",
    termsUrl: "https://platform.minimax.io/docs/token-plan/intro",
    note: "订阅 Key 可用于任意 OpenAI 兼容工具，未把场景限定在编程工具，因此全模式可用。"
  },
  {
    id: "qwen",
    label: "通义千问 Coding Plan",
    kind: "coding-only",
    available: true,
    baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
    keyPrefix: "sk-sp-",
    termsUrl: "https://help.aliyun.com/zh/model-studio/coding-plan",
    note: "条款：仅限在编程工具中交互式使用，禁止自动化脚本与应用后端。只在 Code 模式放行。"
  },
  {
    id: "tencent",
    label: "腾讯云 Coding Plan",
    kind: "coding-only",
    available: true,
    // Coding Plan 专属端点，与按量付费的 api.lkeap.cloud.tencent.com/v1 不互通，
    // 官方文档明确写了「请勿混用」。填错会直接鉴权失败。
    baseUrl: "https://api.lkeap.cloud.tencent.com/coding/v3",
    keyPrefix: "sk-sp-",
    termsUrl: "https://cloud.tencent.com/document/product/1823/130092",
    note: "条款：仅限指定编程工具的交互式场景，禁止批量与后端调用。只在 Code 模式放行。"
  },
  {
    id: "copilot",
    label: "GitHub Copilot（本地 CLI）",
    kind: "agent-cli",
    // 未实现：Copilot 的 SDK 依赖 koffi 原生模块并自带 CLI 二进制，
    // 与「插件自包含 + 零运行时依赖」冲突。可行路线是驱动用户自己安装并登录的
    // copilot CLI（copilot --headless --port N，走 JSON-RPC），
    // 但本机没装 CLI，协议没法实测，不带未验证的实现上线。
    available: false,
    termsUrl: "https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate",
    note: "计划中：驱动你自己安装并登录的 copilot CLI。当前版本未实现，面板置灰。"
  }
];
function findProvider(id) {
  return PROVIDERS.find((p) => p.id === id);
}
function requiresCodeMode(provider) {
  return provider.kind === "coding-only";
}
function resolveBaseUrl(provider, regionId) {
  if (provider.regions && provider.regions.length > 0) {
    const picked = provider.regions.find((r) => r.id === regionId);
    return (picked ?? provider.regions[0]).baseUrl;
  }
  return provider.baseUrl;
}
function secretKeyOf(providerId) {
  return `astral_relay_key_${providerId}`;
}

// src/config.ts
var CONFIG_KEY = "config";
var DEFAULT_CONFIG = {
  providers: {},
  windowTtlMs: DEFAULT_WINDOW_TTL_MS
};
function loadConfig(storage) {
  const saved = storage.get(CONFIG_KEY) ?? {};
  return {
    providers: typeof saved.providers === "object" && saved.providers !== null ? { ...saved.providers } : {},
    windowTtlMs: typeof saved.windowTtlMs === "number" && Number.isFinite(saved.windowTtlMs) ? saved.windowTtlMs : DEFAULT_CONFIG.windowTtlMs
  };
}
function saveConfig(storage, config) {
  storage.set(CONFIG_KEY, config);
}
function mergeConfigPatch(current, patch) {
  if (typeof patch !== "object" || patch === null) return current;
  const incoming = patch;
  const next = {
    providers: { ...current.providers },
    windowTtlMs: current.windowTtlMs
  };
  if (typeof incoming.windowTtlMs === "number" && Number.isFinite(incoming.windowTtlMs)) {
    next.windowTtlMs = Math.min(Math.max(Math.floor(incoming.windowTtlMs), 1e4), 6e5);
  }
  if (typeof incoming.providerId === "string" && typeof incoming.regionId === "string") {
    const provider = findProvider(incoming.providerId);
    const known = provider?.regions?.some((r) => r.id === incoming.regionId) ?? false;
    if (provider && known) {
      next.providers[provider.id] = { ...next.providers[provider.id], regionId: incoming.regionId };
    }
  }
  return next;
}
function regionOf(config, providerId) {
  return config.providers[providerId]?.regionId;
}

// src/core/turn-binding.ts
var import_node_crypto = require("node:crypto");
var DEFAULT_BINDING_TTL_MS = 2 * 60 * 60 * 1e3;
var DEFAULT_BINDING_MAX = 64;
function fingerprint(text) {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  return (0, import_node_crypto.createHash)("sha256").update(normalized).digest("hex");
}
function createTurnBinding(options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_BINDING_TTL_MS;
  const max = options.max ?? DEFAULT_BINDING_MAX;
  const now = options.now ?? (() => Date.now());
  const entries = /* @__PURE__ */ new Map();
  const sweep = () => {
    const cutoff = now() - ttlMs;
    for (const [hash, at] of entries) {
      if (at < cutoff) entries.delete(hash);
    }
  };
  return {
    register(input) {
      if (input.mode !== "code" || input.source !== "conversation") return false;
      const hash = fingerprint(typeof input.userText === "string" ? input.userText : "");
      if (!hash) return false;
      sweep();
      entries.delete(hash);
      entries.set(hash, now());
      while (entries.size > max) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      return true;
    },
    matchesAny(texts) {
      sweep();
      for (const text of texts) {
        const hash = fingerprint(text);
        if (hash && entries.has(hash)) return true;
      }
      return false;
    },
    size() {
      sweep();
      return entries.size;
    },
    clear() {
      entries.clear();
    }
  };
}
function lastUserTexts(body) {
  let parsed;
  try {
    parsed = JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const messages = parsed.messages;
  if (!Array.isArray(messages)) return [];
  let content;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && typeof message === "object" && message.role === "user") {
      content = message.content;
      break;
    }
  }
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (part && typeof part === "object") {
      const text = part.text;
      if (typeof text === "string") parts.push(text);
    }
  }
  if (parts.length === 0) return [];
  return [parts.join("\n"), parts.join("")];
}

// src/core/request-auth.ts
var import_node_crypto2 = require("node:crypto");
var CONTEXT_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var NONCE_USE_WINDOW_MS = 2 * 60 * 60 * 1e3;
var NONCE_STORE_MAX = 512;
function createNonceStore(options = {}) {
  const windowMs = options.windowMs ?? NONCE_USE_WINDOW_MS;
  const max = options.max ?? NONCE_STORE_MAX;
  const now = options.now ?? (() => Date.now());
  const seen = /* @__PURE__ */ new Map();
  const sweep = () => {
    const cutoff = now() - CONTEXT_MAX_AGE_MS;
    for (const [nonce, at] of seen) {
      if (at < cutoff) seen.delete(nonce);
    }
  };
  return {
    accept(nonce) {
      sweep();
      const firstSeen = seen.get(nonce);
      if (firstSeen !== void 0) return now() - firstSeen <= windowMs;
      seen.set(nonce, now());
      while (seen.size > max) {
        const oldest = seen.keys().next();
        if (oldest.done) break;
        seen.delete(oldest.value);
      }
      return true;
    },
    size() {
      sweep();
      return seen.size;
    }
  };
}
function readRelayContext(credential, secret, provider, now = Date.now()) {
  if (credential.length > 2048) return null;
  const parts = credential.split(".");
  if (parts.length !== 3 || parts[0] !== "ar1" || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2])) return null;
  const expected = (0, import_node_crypto2.createHmac)("sha256", secret).update(`ar1.${parts[1]}`).digest();
  if (!(0, import_node_crypto2.timingSafeEqual)(expected, Buffer.from(parts[2], "hex"))) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!value || value.provider !== provider || typeof value.mode !== "string" || typeof value.source !== "string" || typeof value.nonce !== "string" || !value.nonce || !Number.isSafeInteger(value.issuedAt) || value.issuedAt > now || now - value.issuedAt >= CONTEXT_MAX_AGE_MS) return null;
    return value;
  } catch {
    return null;
  }
}

// src/proxy/server.ts
var import_node_http = require("node:http");

// src/network.ts
var electronFetch = (input, init) => {
  const { net } = require("electron");
  return net.fetch(input, init);
};

// src/oauth/specs.ts
var OAUTH_SPECS = {
  grok: {
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    authorizeUrl: "https://auth.x.ai/oauth2/authorize",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
    port: 56121,
    redirectHost: "127.0.0.1",
    pathname: "/callback",
    // grok-cli:access 与 api:access 都在 discovery 的 scopes_supported 里，是公开广告的 scope。
    scopes: ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"],
    // 刻意不带 referrer=opencode：本插件不是 OpenCode，冒名是唯一真正失实的字段。
    extra: { plan: "generic" }
  }
};
var isOAuthProvider = (id) => id === "grok";
var DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
var redirectUri = (spec) => `http://${spec.redirectHost}:${spec.port}${spec.pathname}`;

// src/oauth/upstream.ts
function oauthHeaders(_id, tokens) {
  return {
    authorization: `Bearer ${tokens.accessToken}`,
    "user-agent": "astral-relay/0.5.0"
  };
}
async function fetchCatalog(id, tokens, signal, doFetch = electronFetch) {
  const response = await doFetch("https://api.x.ai/v1/models", {
    headers: { ...oauthHeaders(id, tokens), accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15e3)]),
    redirect: "error"
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`读取模型目录失败（HTTP ${response.status}）`);
  }
  const json = await response.json();
  if (!Array.isArray(json.data)) throw new Error("模型目录格式无效");
  const result = /* @__PURE__ */ new Map();
  for (const row of json.data) {
    if (!row || typeof row !== "object") continue;
    const modelId = row.id;
    if (typeof modelId !== "string" || !modelId || /imagine|image-|video|embed/i.test(modelId)) continue;
    result.set(modelId, { id: modelId, name: modelId });
  }
  if (!result.size) throw new Error("订阅没有返回可用模型");
  return [...result.values()];
}

// src/proxy/server.ts
var import_node_stream = require("node:stream");
var import_promises = require("node:stream/promises");
var MAX_BODY_BYTES = 8 * 1024 * 1024;
var UPSTREAM_TIMEOUT_MS = 18e4;
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}
function sendError(res, status, message) {
  sendJson(res, status, { error: { message, type: "invalid_request_error" } });
}
function refusalMessage(provider, code) {
  if (code === "bad_token") {
    return "星驿：token 不匹配。请把模型档案里的 API Key 换成插件面板显示的 token。";
  }
  if (code === "expired") {
    return `星驿：本轮授权窗口已过期。${provider.label} 只在 Code 模式的交互式对话里可用，请回到 Code 模式重新发一条消息。`;
  }
  return `星驿：当前不是 Code 模式的交互式对话，已拒绝 ${provider.label}。该套餐条款只允许在编程工具里交互式使用，禁止用于定时任务、朋友圈发帖等非交互场景。请切到 Code 模式，或给这些场景换一个按量付费的模型档案。`;
}
function parseRoute(url) {
  const match = /^\/p\/([a-z0-9-]+)(\/.*)$/.exec(url);
  if (!match) return null;
  return { providerId: match[1], rest: match[2] };
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求体超过 8MB 上限"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function extractToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey) return apiKey;
  return "";
}
async function handle(req, res, token, deps) {
  const { resolveUpstream, getKey, log } = deps;
  const doFetch = deps.fetchImpl ?? electronFetch;
  if (req.method !== "POST" || !req.url) {
    sendError(res, 404, "星驿只转发 POST /p/<厂商>/v1/*。");
    return;
  }
  const route = parseRoute(req.url);
  if (!route) {
    sendError(res, 404, "星驿只转发 POST /p/<厂商>/v1/*。");
    return;
  }
  const provider = findProvider(route.providerId);
  if (!provider || !provider.available) {
    sendError(res, 404, `星驿：未知或未启用的厂商 ${route.providerId}。`);
    return;
  }
  const credential = extractToken(req);
  const context = readRelayContext(credential, token, provider.id);
  if (!context && !constantTimeEquals(credential, token)) {
    sendError(res, 401, credential.startsWith("ar1.") ? "星驿：本轮模式凭据无效或已过期。请确认模型档案使用当前面板的 Base URL 和 token，再开始新轮次。" : refusalMessage(provider, "bad_token"));
    return;
  }
  if (context && deps.nonces && !deps.nonces.accept(context.nonce)) {
    sendError(res, 401, "星驿：本轮模式凭据已超出首次使用后的可用时限，请回到 Code 模式开始新一轮对话。");
    return;
  }
  const upstreamBase = resolveUpstream(provider);
  if (!upstreamBase) {
    sendError(res, 503, `星驿：${provider.label} 尚未配置可用端点。`);
    return;
  }
  const expectedPath = provider.protocol === "responses" ? "/v1/responses" : "/v1/chat/completions";
  if (route.rest !== expectedPath) {
    sendError(res, 400, `星驿：${provider.label} 请使用 ${provider.protocol === "responses" ? "Responses" : "OpenAI 兼容"} 协议（${expectedPath}）。`);
    return;
  }
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, `请求体读取失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (requiresCodeMode(provider)) {
    const allowed = context ? context.mode === "code" && context.source === "conversation" : deps.binding?.matchesAny(lastUserTexts(body)) === true;
    if (!allowed) {
      log.warn(`模式检查拒绝 ${provider.id}`);
      sendError(res, 403, context ? `星驿：${provider.label} 仅限 Code 交互式会话，当前模式 ${context.mode} / 来源 ${context.source} 不支持。请切换到 Code 模式，或选择通用套餐。` : `星驿：${provider.label} 仅限 Code 模式的交互式对话。本轮请求没有匹配到任何 Code 模式的用户输入：定时任务、朋友圈发帖、模型档案的「连接测试」以及 Chat / Work / Learn 都会被拒绝。请切到 Code 模式直接发消息，或给这些场景换一个按量付费的模型档案。`);
      return;
    }
  }
  const suffix = route.rest.startsWith("/v1/") ? route.rest.slice(3) : route.rest;
  const upstreamUrl = upstreamBase.replace(/\/+$/, "") + suffix;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);
  res.on("close", () => abort.abort());
  const onStop = () => abort.abort();
  deps.signal?.addEventListener("abort", onStop, { once: true });
  try {
    if (deps.signal?.aborted || res.destroyed) abort.abort();
    abort.signal.throwIfAborted();
    let headers;
    let requestBody = body;
    if (isOAuthProvider(provider.id)) {
      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      } catch {
        sendError(res, 400, "请求体必须为 JSON 对象。");
        return;
      }
      const tokens = await deps.getOAuthTokens?.(provider.id);
      if (!tokens) {
        sendError(res, 503, `星驿：请打开面板连接 ${provider.label}。`);
        return;
      }
      headers = oauthHeaders(provider.id, tokens);
    } else {
      const key = await getKey(provider.id);
      if (!key) {
        sendError(res, 503, `星驿：尚未填写 ${provider.label} 的订阅 Key。`);
        return;
      }
      headers = { authorization: `Bearer ${key}` };
    }
    abort.signal.throwIfAborted();
    const upstream = await doFetch(upstreamUrl, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        accept: req.headers.accept ?? "application/json"
      },
      body: requestBody,
      signal: abort.signal,
      redirect: "error"
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      sendError(res, upstream.status, `星驿：${provider.label} 返回 HTTP ${upstream.status}。${upstream.status === 401 ? "请重新连接订阅。" : "请检查模型与订阅额度。"}`);
      return;
    }
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store"
    });
    if (!upstream.body) {
      res.end();
      return;
    }
    const stream = import_node_stream.Readable.fromWeb(upstream.body);
    await (0, import_promises.pipeline)(stream, res, { signal: abort.signal });
  } catch {
    log.warn(`上游请求失败（${provider.id}）`);
    if (res.destroyed) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendError(res, abort.signal.aborted ? 504 : 502, `星驿：${provider.label} 请求失败或超时，请检查连接并在面板重新连接订阅。`);
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onStop);
  }
}
function startProxy(deps, token) {
  const server = (0, import_node_http.createServer)((req, res) => {
    void handle(req, res, token, deps).catch(() => {
      if (!res.headersSent) {
        sendError(res, 500, "代理内部错误，请重新启用插件。");
      } else res.destroy();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("拿不到监听端口"));
        return;
      }
      const port = address.port;
      resolve({
        baseUrlFor: (providerId) => `http://127.0.0.1:${port}/p/${providerId}/v1`,
        token,
        port,
        close: () => new Promise((done) => {
          server.close(() => done());
          server.closeAllConnections();
        })
      });
    });
  });
}

// src/ui/ipc.ts
var GET_STATE = "get-state";
var SAVE_CONFIG = "save-config";
var SAVE_KEY = "save-key";
var CLEAR_KEY = "clear-key";
var OAUTH_CHANNELS = ["oauth-login", "oauth-cancel", "oauth-logout", "oauth-models"];
function registerUiIpc(ctx, deps) {
  const { gate, storage, log, getProxy } = deps;
  const getState = async () => {
    const config = loadConfig(storage);
    const proxy = getProxy();
    const providers = [];
    for (const provider of PROVIDERS) {
      let keyConfigured = false;
      let oauthState = { connected: false, connecting: false };
      if (isOAuthProvider(provider.id) && deps.oauth) {
        try {
          oauthState = await deps.oauth.status(provider.id);
        } catch {
        }
      }
      if (provider.available && ctx.deps.secrets) {
        try {
          keyConfigured = Boolean(await ctx.deps.secrets.get(secretKeyOf(provider.id)));
        } catch {
          keyConfigured = false;
        }
      }
      providers.push({
        id: provider.id,
        label: provider.label,
        kind: provider.kind,
        available: provider.available,
        experimental: provider.experimental === true,
        auth: provider.auth ?? "key",
        protocol: provider.protocol ?? "openai",
        oauth: oauthState,
        note: provider.note,
        termsUrl: provider.termsUrl,
        keyPrefix: provider.keyPrefix ?? "",
        regions: provider.regions ?? [],
        regionId: regionOf(config, provider.id) ?? provider.regions?.[0]?.id ?? "",
        upstream: resolveBaseUrl(provider, regionOf(config, provider.id)) ?? "",
        keyConfigured,
        // 只有 available 的厂商才给 baseUrl：置灰的厂商给了也没法用
        baseUrl: proxy && provider.available ? proxy.baseUrlFor(provider.id) : ""
      });
    }
    return {
      providers,
      windowTtlMs: config.windowTtlMs,
      gate: gate.snapshot(),
      // 只回传条目数量，不回传任何指纹或原文：面板不需要知道用户说了什么。
      binding: { pending: deps.binding?.size() ?? 0, ttlMs: DEFAULT_BINDING_TTL_MS },
      proxy: proxy ? { port: proxy.port, token: proxy.token } : null
    };
  };
  const saveConfigPatch = (patch) => {
    try {
      const next = mergeConfigPatch(loadConfig(storage), patch);
      saveConfig(storage, next);
      return { ok: true };
    } catch (err) {
      log.warn("save-config 失败：", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "保存失败" };
    }
  };
  const saveKey = async (payload) => {
    const input = typeof payload === "object" && payload !== null ? payload : {};
    const providerId = typeof input.providerId === "string" ? input.providerId : "";
    const key = typeof input.key === "string" ? input.key.trim() : "";
    const provider = findProvider(providerId);
    if (!provider) return { ok: false, error: "未知的厂商 id" };
    if (!provider.available) return { ok: false, error: `${provider.label} 当前版本未实现` };
    if (provider.auth === "oauth") return { ok: false, error: "此订阅使用浏览器登录，请点击连接" };
    if (!key) return { ok: false, error: "Key 不能为空" };
    if (!ctx.deps.secrets) return { ok: false, error: "宿主安全存储不可用" };
    const prefixMismatch = Boolean(provider.keyPrefix) && !key.startsWith(provider.keyPrefix);
    try {
      await ctx.deps.secrets.set(secretKeyOf(provider.id), key);
      return { ok: true, prefixMismatch, expectedPrefix: provider.keyPrefix ?? "" };
    } catch (err) {
      log.warn("保存 Key 失败：", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "安全存储写入失败" };
    }
  };
  const clearKey = async (payload) => {
    const providerId = typeof payload === "string" ? payload : "";
    const provider = findProvider(providerId);
    if (!provider || !ctx.deps.secrets) return { ok: false };
    try {
      await ctx.deps.secrets.delete(secretKeyOf(provider.id));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  };
  const allChannels = [GET_STATE, SAVE_CONFIG, SAVE_KEY, CLEAR_KEY, ...OAUTH_CHANNELS];
  const oauthAction = async (id, action) => {
    if (typeof id !== "string" || !isOAuthProvider(id) || !deps.oauth || ctx.signal.aborted) return { ok: false, error: "订阅不可用" };
    try {
      return { ok: true, result: await action(id, deps.oauth) };
    } catch {
      return { ok: false, error: "订阅操作失败或已取消，请检查网络、登录端口、订阅账号及安全存储后重试。" };
    }
  };
  for (const channel of allChannels) {
    try {
      ctx.unregisterIpc(channel);
    } catch {
    }
  }
  try {
    ctx.registerIpc(GET_STATE, () => getState());
    ctx.registerIpc(SAVE_CONFIG, (patch) => saveConfigPatch(patch));
    ctx.registerIpc(SAVE_KEY, (payload) => saveKey(payload));
    ctx.registerIpc(CLEAR_KEY, (payload) => clearKey(payload));
    ctx.registerIpc("oauth-login", (id) => oauthAction(id, (provider, oauth) => oauth.login(provider)));
    ctx.registerIpc("oauth-cancel", (id) => oauthAction(id, async (provider, oauth) => oauth.cancel(provider)));
    ctx.registerIpc("oauth-logout", (id) => oauthAction(id, (provider, oauth) => oauth.logout(provider)));
    ctx.registerIpc("oauth-models", (id) => oauthAction(id, async (provider, oauth) => {
      const tokens = await oauth.getTokens(provider);
      if (!tokens) throw new Error("未连接");
      return fetchCatalog(provider, tokens, ctx.signal);
    }));
  } catch (err) {
    log.warn("注册面板 IPC 失败：", err instanceof Error ? err.message : String(err));
  }
  ctx.onDispose(() => {
    try {
      for (const channel of allChannels) ctx.unregisterIpc(channel);
    } catch (err) {
      log.warn("移除面板 IPC 失败：", err instanceof Error ? err.message : String(err));
    }
  });
}

// src/ui/window.ts
var WINDOW_TITLE = "星驿 · Astral Relay";
var WINDOW_WIDTH = 760;
var WINDOW_HEIGHT = 640;
function createWindowManager(deps) {
  const { log } = deps;
  let win = null;
  const close = () => {
    const target = win;
    win = null;
    if (!target) return;
    try {
      if (!target.isDestroyed()) target.close();
    } catch (err) {
      log.warn("关闭窗口失败：", err instanceof Error ? err.message : String(err));
    }
  };
  const open = async (ctx) => {
    if (ctx.signal.aborted) return;
    ctx.signal.addEventListener("abort", close, { once: true });
    if (win && !win.isDestroyed()) {
      try {
        if (win.isMinimized()) win.restore();
        win.focus();
      } catch (err) {
        log.warn("聚焦窗口失败：", err instanceof Error ? err.message : String(err));
      }
      return;
    }
    win = null;
    try {
      const electron = require("electron");
      const created = new electron.BrowserWindow({
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
        minWidth: 560,
        minHeight: 480,
        title: WINDOW_TITLE,
        autoHideMenuBar: true,
        backgroundColor: "#fff8fb",
        // 面板是随插件分发的受信静态页，panel.js 直接用 ipcRenderer。
        webPreferences: { nodeIntegration: true, contextIsolation: false }
      });
      const documentationUrls = new Set(PROVIDERS.map((provider) => provider.termsUrl));
      created.webContents.setWindowOpenHandler(({ url }) => {
        if (documentationUrls.has(url)) void electron.shell.openExternal(url).catch(() => log.warn("无法打开文档链接"));
        return { action: "deny" };
      });
      created.webContents.on("will-navigate", (event) => event.preventDefault());
      created.on("closed", () => {
        if (win === created) win = null;
      });
      win = created;
      await created.loadFile(`${__dirname}/panel/index.html`);
      if (ctx.signal.aborted) close();
    } catch (err) {
      log.warn("打开窗口失败：", err instanceof Error ? err.message : String(err));
      close();
    }
  };
  return { open, close };
}

// src/logger.ts
function createLogger(raw) {
  const prefix = "[星驿]";
  const log = raw.log.bind(raw);
  return {
    log: (...args) => log(prefix, ...args),
    warn: (...args) => log(prefix, "[warn]", ...args),
    error: (...args) => log(prefix, "[error]", ...args)
  };
}

// src/index.ts
var import_node_crypto4 = require("node:crypto");

// src/oauth/manager.ts
var import_node_crypto3 = require("node:crypto");

// src/oauth/callback.ts
var import_node_http2 = require("node:http");
async function prepareCallback(spec, state, signal) {
  signal.throwIfAborted();
  let resolveCode;
  let rejectCode;
  const code = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  void code.catch(() => {
  });
  let settled = false;
  const server = (0, import_node_http2.createServer)((req, res) => {
    let url;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      res.writeHead(400).end("Invalid request");
      return;
    }
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    if (req.method !== "GET" || url.pathname !== spec.pathname) {
      res.writeHead(404).end("Not found");
      return;
    }
    if (url.searchParams.get("state") !== state) {
      res.writeHead(400).end("Invalid OAuth state");
      return;
    }
    if (url.searchParams.has("error")) {
      res.writeHead(400).end("Authorization declined. Return to Astral Relay.");
      finish(new Error("授权被拒绝，请重试"));
      return;
    }
    const value = url.searchParams.get("code");
    if (!value || value.length > 4096) {
      res.writeHead(400).end("Missing authorization code");
      return;
    }
    res.end("Authorization received. Return to Astral Relay to check connection status.");
    finish(void 0, value);
  });
  server.requestTimeout = 1e4;
  server.headersTimeout = 1e4;
  function finish(error, value) {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", onAbort);
    server.close();
    server.closeIdleConnections();
    if (error) rejectCode(error);
    else resolveCode(value);
  }
  const onAbort = () => {
    finish(new Error("登录已取消或超时"));
    server.closeAllConnections();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(spec.port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    server.on("error", () => finish(new Error("登录回调连接失败")));
    if (signal.aborted) onAbort();
    signal.throwIfAborted();
  } catch {
    onAbort();
    throw new Error(`无法监听登录端口 ${spec.port}，请关闭占用端口的登录窗口后重试`);
  }
  return { code, close: onAbort, port: server.address().port };
}

// src/oauth/manager.ts
var DEVICE_POLL_DEFAULT_MS = 5e3;
var DEVICE_POLL_MIN_MS = 1e3;
var DEVICE_SLOW_DOWN_STEP_MS = 5e3;
var oauthSecretKey = (id) => `astral_relay_oauth_${id}`;
function createOAuthManager(deps) {
  const doFetch = deps.fetchImpl ?? electronFetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const active = /* @__PURE__ */ new Map();
  const generation = /* @__PURE__ */ new Map();
  const refreshes = /* @__PURE__ */ new Map();
  const writes = /* @__PURE__ */ new Map();
  const current = (id) => generation.get(id) ?? 0;
  const bump = (id) => {
    generation.set(id, current(id) + 1);
  };
  const secrets = () => {
    if (!deps.secrets) throw new Error("宿主安全存储不可用，无法连接订阅");
    return deps.secrets;
  };
  const mutate = (id, action) => {
    const next = (writes.get(id) ?? Promise.resolve()).catch(() => {
    }).then(action);
    writes.set(id, next);
    return next;
  };
  async function read(id) {
    const raw = await secrets().get(oauthSecretKey(id));
    if (!raw) return void 0;
    try {
      const value = JSON.parse(raw);
      if (typeof value.accessToken === "string" && value.accessToken && Number.isFinite(value.expiresAt)) return value;
    } catch {
    }
    throw new Error("订阅凭据无效，请重新连接");
  }
  async function requestTokens(id, params, signal, previous) {
    const spec = OAUTH_SPECS[id];
    let response;
    try {
      response = await doFetch(spec.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ client_id: spec.clientId, ...params }).toString(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(3e4)]),
        redirect: "error"
      });
    } catch {
      throw new Error("订阅授权网络请求失败或已取消，请重试");
    }
    if (!response.ok) {
      let code = "";
      try {
        const body = await response.json();
        if (typeof body.error === "string") code = body.error;
      } catch {
      }
      throw new Error(code ? `订阅授权失败（${code}）` : `订阅授权失败（HTTP ${response.status}），请重新连接`);
    }
    let json;
    try {
      json = await response.json();
    } catch {
      throw new Error("订阅授权响应不是有效 JSON");
    }
    if (!json || typeof json.access_token !== "string" || !json.access_token) throw new Error("订阅授权未返回访问凭据");
    const seconds = typeof json.expires_in === "number" && Number.isFinite(json.expires_in) && json.expires_in > 0 ? json.expires_in : 3600;
    return {
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : previous?.refreshToken,
      expiresAt: Date.now() + seconds * 1e3
    };
  }
  async function save(id, value, version, signal) {
    await mutate(id, async () => {
      signal.throwIfAborted();
      if (current(id) !== version) throw new Error("连接已改变，请重试");
      await secrets().set(oauthSecretKey(id), JSON.stringify(value));
    });
  }
  return {
    async status(id) {
      const tokens = deps.secrets ? await read(id) : void 0;
      return { connected: Boolean(tokens), connecting: active.has(id), expiresAt: tokens?.expiresAt };
    },
    async login(id) {
      secrets();
      deps.signal.throwIfAborted();
      if (active.has(id)) throw new Error("该订阅正在连接，请完成或取消当前登录");
      const controller = new AbortController();
      active.set(id, controller);
      bump(id);
      const version = current(id);
      const signal = AbortSignal.any([deps.signal, controller.signal, AbortSignal.timeout(3e5)]);
      let callback;
      try {
        const spec = OAUTH_SPECS[id];
        const state = (0, import_node_crypto3.randomBytes)(24).toString("base64url");
        const verifier = (0, import_node_crypto3.randomBytes)(32).toString("base64url");
        const url = new URL(spec.authorizeUrl);
        for (const [key, value] of Object.entries({
          response_type: "code",
          client_id: spec.clientId,
          redirect_uri: redirectUri(spec),
          scope: spec.scopes.join(" "),
          state,
          code_challenge: (0, import_node_crypto3.createHash)("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
          ...spec.extra
        })) url.searchParams.set(key, value);
        callback = await (deps.callback ?? prepareCallback)(spec, state, signal);
        await (deps.openExternal ?? ((href) => require("electron").shell.openExternal(href)))(url.toString());
        const code = await callback.code;
        const tokens = await requestTokens(id, { grant_type: "authorization_code", code, redirect_uri: redirectUri(spec), code_verifier: verifier }, signal);
        await save(id, tokens, version, signal);
      } finally {
        callback?.close();
        if (active.get(id) === controller) active.delete(id);
      }
    },
    /**
     * 设备码登录（实验性）。
     *
     * 端点与 grant type 来自 xAI 自己发布的 OIDC discovery，不是从别人的构建里扒的常量。
     * 但本机没有 SuperGrok / X Premium 账号可完成一次真实授权，因此这条路径
     * 只有单元测试覆盖，没有端到端验证——面板上标注为实验性即为此意。
     *
     * 与 login() 并存而不是替换：login() 的回环回调流程有 7 条测试覆盖且能跑通，
     * 用未经实测的实现去换掉能跑的实现是倒退。
     */
    async loginDevice(id, onPrompt) {
      secrets();
      deps.signal.throwIfAborted();
      if (active.has(id)) throw new Error("该订阅正在连接，请完成或取消当前登录");
      const controller = new AbortController();
      active.set(id, controller);
      bump(id);
      const version = current(id);
      const signal = AbortSignal.any([deps.signal, controller.signal, AbortSignal.timeout(3e5)]);
      try {
        const spec = OAUTH_SPECS[id];
        let response;
        try {
          response = await doFetch(spec.deviceCodeUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: new URLSearchParams({ client_id: spec.clientId, scope: spec.scopes.join(" ") }).toString(),
            signal: AbortSignal.any([signal, AbortSignal.timeout(3e4)]),
            redirect: "error"
          });
        } catch {
          throw new Error("设备码请求失败或已取消，请重试");
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`设备码申请失败（HTTP ${response.status}）`);
        }
        let json;
        try {
          json = await response.json();
        } catch {
          throw new Error("设备码响应不是有效 JSON");
        }
        const deviceCode = typeof json.device_code === "string" ? json.device_code : "";
        const userCode = typeof json.user_code === "string" ? json.user_code : "";
        const verificationUri = typeof json.verification_uri === "string" ? json.verification_uri : "";
        if (!deviceCode || !userCode || !verificationUri) throw new Error("设备码响应缺少必要字段");
        const lifetime = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 600;
        onPrompt({
          userCode,
          verificationUri,
          verificationUriComplete: typeof json.verification_uri_complete === "string" ? json.verification_uri_complete : void 0,
          expiresAt: Date.now() + lifetime * 1e3
        });
        let intervalMs = typeof json.interval === "number" && json.interval > 0 ? Math.max(json.interval * 1e3, DEVICE_POLL_MIN_MS) : DEVICE_POLL_DEFAULT_MS;
        const deadline = Date.now() + lifetime * 1e3;
        for (; ; ) {
          signal.throwIfAborted();
          if (Date.now() > deadline) throw new Error("设备码已过期，请重新连接");
          await sleep(intervalMs);
          signal.throwIfAborted();
          try {
            const tokens = await requestTokens(id, { grant_type: DEVICE_CODE_GRANT_TYPE, device_code: deviceCode }, signal);
            await save(id, tokens, version, signal);
            return;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("slow_down")) {
              intervalMs += DEVICE_SLOW_DOWN_STEP_MS;
              continue;
            }
            if (message.includes("authorization_pending")) continue;
            throw error;
          }
        }
      } finally {
        if (active.get(id) === controller) active.delete(id);
      }
    },
    cancel(id) {
      active.get(id)?.abort();
    },
    async logout(id) {
      bump(id);
      active.get(id)?.abort();
      await mutate(id, () => secrets().delete(oauthSecretKey(id)));
    },
    async getTokens(id) {
      deps.signal.throwIfAborted();
      const version = current(id);
      const tokens = await read(id);
      if (current(id) !== version) return void 0;
      if (!tokens || tokens.expiresAt > Date.now() + 6e4) return tokens;
      if (!tokens.refreshToken) throw new Error("订阅已过期，请重新连接");
      if (!refreshes.has(id)) {
        const pending = requestTokens(id, { grant_type: "refresh_token", refresh_token: tokens.refreshToken }, deps.signal, tokens).then(async (next) => {
          await save(id, next, version, deps.signal);
          return next;
        }).finally(() => {
          if (refreshes.get(id) === pending) refreshes.delete(id);
        });
        refreshes.set(id, pending);
      }
      return refreshes.get(id);
    }
  };
}

// src/index.ts
var activeCtx = null;
var winManager = null;
var PROVIDER_ID = "code-mode-gate";
var plugin = {
  async register(ctx) {
    const log = createLogger(ctx);
    const gate = createGate({ ttlMs: loadConfig(ctx.storage).windowTtlMs });
    const binding = createTurnBinding();
    const nonces = createNonceStore();
    const token = "ar-secret-v1." + (0, import_node_crypto4.randomBytes)(24).toString("hex");
    const oauth = createOAuthManager({ secrets: ctx.deps.secrets, signal: ctx.signal });
    const resolveUpstream = (provider) => resolveBaseUrl(provider, regionOf(loadConfig(ctx.storage), provider.id));
    const getKey = async (providerId) => {
      const provider = findProvider(providerId);
      if (!provider || !ctx.deps.secrets) return void 0;
      try {
        return await ctx.deps.secrets.get(secretKeyOf(provider.id));
      } catch (err) {
        log.warn("读取订阅 Key 失败：", err instanceof Error ? err.message : String(err));
        return void 0;
      }
    };
    let proxy = null;
    try {
      proxy = await startProxy({ gate, binding, nonces, resolveUpstream, getKey, getOAuthTokens: (id) => oauth.getTokens(id), signal: ctx.signal, log }, token);
      log.log(`代理已启动：127.0.0.1:${proxy.port}`);
    } catch (err) {
      log.error("代理启动失败：", err instanceof Error ? err.message : String(err));
    }
    ctx.registerPromptProvider({
      id: PROVIDER_ID,
      modes: ["code"],
      sources: ["conversation"],
      provide: (input) => {
        if (!input.signal.aborted && input.mode === "code" && input.source === "conversation") {
          gate.open();
          binding.register({ mode: input.mode, source: input.source, userText: input.userText });
        }
        return "";
      }
    });
    ctx.events.on("host:turn:finished", () => {
      gate.close();
    });
    registerUiIpc(ctx, { gate, binding, storage: ctx.storage, log, getProxy: () => proxy, oauth });
    winManager = createWindowManager({ log });
    ctx.onDispose(async () => {
      gate.close();
      binding.clear();
      winManager?.close();
      winManager = null;
      if (proxy) {
        try {
          await proxy.close();
        } catch (err) {
          log.warn("关闭代理失败：", err instanceof Error ? err.message : String(err));
        }
        proxy = null;
      }
    });
    activeCtx = ctx;
    log.log("已启用（编程套餐按 Code 轮次绑定放行，无需宿主改动；通用 BYOS 全模式可用）");
  },
  async unregister() {
    winManager?.close();
    winManager = null;
    activeCtx = null;
  },
  async open() {
    if (activeCtx && winManager) {
      await winManager.open(activeCtx);
    }
  }
};
module.exports = plugin;
