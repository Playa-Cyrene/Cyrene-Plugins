"use strict";

/**
 * 订阅 OAuth 本地代理服务器。
 *
 * 对外按订阅原生协议暴露三个端点，由 Cyrene 档案选择对应 transport：
 *  - /v1/responses        → ChatGPT Codex（Responses API）
 *  - /v1/messages         → Claude Code（Messages API）
 *  - /v1/chat/completions → xAI（OpenAI Chat Completions）
 * token 由调用方（index.cjs）通过 getTokens 闭包注入，过期自动刷新。
 */
const http = require("node:http");
const { PROVIDERS, authHeaders, chatBodyFrom, providerForModel, decodeJwtPayload } = require("./vendor-http.cjs");

const DEFAULT_PORT = 6231;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * ChatGPT Codex 的 Responses SSE 在 `response.output_item.done` 中给出完整
 * output item，但部分版本的终态 `response.completed.response.output` 为空。
 * Cyrene 依赖终态 output 保存 function_call 供工具续轮回放；这里边收集边补齐，
 * 不缓存整条响应，也不改动正常（终态 output 非空）的事件。
 */
function createResponsesSseRepair() {
  const outputItems = new Map();
  let pending = "";

  function transformFrame(frame) {
    const lineBreak = frame.includes("\r\n") ? "\r\n" : "\n";
    const lines = frame.split(/\r?\n/);
    const dataIndexes = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].startsWith("data:")) dataIndexes.push(index);
    }
    // Responses 事件均为单行 JSON。遇到扩展 SSE 形状时原样透传。
    if (dataIndexes.length !== 1) return frame;
    const dataIndex = dataIndexes[0];
    const raw = lines[dataIndex].slice(5).trimStart();
    if (!raw || raw === "[DONE]") return frame;

    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return frame;
    }

    if (event && event.type === "response.output_item.done" && event.item && typeof event.item === "object") {
      const index = Number.isInteger(event.output_index) ? event.output_index : outputItems.size;
      outputItems.set(index, event.item);
    }

    if (event && (event.type === "response.completed" || event.type === "response.incomplete")) {
      const response = event.response;
      const collected = [...outputItems.entries()]
        .sort((a, b) => a[0] - b[0])
        .map((entry) => entry[1]);
      if (response && typeof response === "object"
        && (!Array.isArray(response.output) || response.output.length === 0)
        && collected.length > 0) {
        response.output = collected;
        lines[dataIndex] = `data: ${JSON.stringify(event)}`;
        return lines.join(lineBreak);
      }
    }

    return frame;
  }

  return {
    push(text) {
      pending += text;
      let output = "";
      for (;;) {
        const separator = /\r?\n\r?\n/.exec(pending);
        if (!separator) break;
        const frame = pending.slice(0, separator.index);
        output += transformFrame(frame) + separator[0];
        pending = pending.slice(separator.index + separator[0].length);
      }
      return output;
    },
    flush() {
      if (!pending) return "";
      const output = transformFrame(pending);
      pending = "";
      return output;
    },
  };
}

/** 从 token 的 JWT 解析 tier，用于用量展示降级。 */
function tierOf(tokens) {
  const claims = decodeJwtPayload(tokens.accessToken || tokens.idToken);
  if (claims && claims.tier) return String(claims.tier);
  if (claims && claims.plan) return String(claims.plan);
  return undefined;
}

/**
 * 创建代理服务器。
 * @param {object} options
 * @param {(providerId: string) => Promise<{tokens: object} | null>} options.getTokens
 *   token 解析器：返回 null 表示未登录；内部负责刷新。
 * @param {(message: string) => void} options.log
 * @param {(providerId: string) => Promise<object>} options.fetchUsage  （可选）用量查询
 * @param {(providerId: string) => Promise<object>} options.fetchCatalog （可选）模型目录查询
 * @returns {{ server: import('node:http').Server, port: () => number, start: () => Promise<number>, stop: () => Promise<void> }}
 */
function createProxy({ getTokens, log = () => {}, fetchUsage, fetchCatalog }) {
  /** 当前监听端口；0 表示未启动或已停止。 */
  let currentPort = 0;
  let server = null;

  /**
 * 协议端点 → 上游路由表。
 * 关键：每种订阅用其**原生协议**直通，代理注入认证头并只做必要的
 * 上游兼容性校正，不做跨协议转换——Cyrene 的对应 transport 本来就发对格式
 * （Responses transport 恒定发 store:false + instructions，见
 *  src/main/orchestrator/vendors/responses-adapter.ts 头注释）。
 */
const ENDPOINTS = {
  "/v1/chat/completions": {
    provider: "grok",
    upstream: "https://api.x.ai/v1/chat/completions",
  },
  "/v1/responses": {
    provider: "chatgpt",
    upstream: "https://chatgpt.com/backend-api/codex/responses",
  },
  "/v1/messages": {
    provider: "claude",
    upstream: "https://api.anthropic.com/v1/messages?beta=true",
  },
};

/** 按模型名判断请求是否允许打到该端点（防串线）。 */
function endpointAcceptsModel(providerId, model) {
  const detected = providerForModel(model);
  return detected === providerId;
}

async function handleChatCompletions(req, res, endpoint) {
    const body = await readBody(req).catch((error) => {
      json(res, 400, { error: { message: error.message } });
      return null;
    });
    if (!body) return;
    const model = String(body.model || "");
    const providerId = endpoint.provider;
    if (!endpointAcceptsModel(providerId, model)) {
      json(res, 400, {
        error: {
          message: `该端点只接受 ${PROVIDERS[providerId].displayName} 模型（收到 ${model || "(空)"}）`,
        },
      });
      return;
    }
    const auth = await getTokens(providerId).catch((error) => {
      json(res, 502, { error: { message: `读取订阅 token 失败：${error.message}` } });
      return null;
    });
    if (!auth || !auth.tokens) {
      json(res, 401, { error: { message: `${PROVIDERS[providerId].displayName} 订阅未登录，请打开插件登录后再试` } });
      return;
    }
    const tokens = auth.tokens;
    const headers = authHeaders(providerId, tokens);
    headers["content-type"] = "application/json";

    // 原样透传请求体，仅做必要的防御性修正
    const upstreamBody = { ...body };
    if (providerId === "chatgpt") {
      // Codex 端点强制要求 store:false（Cyrene 的 Responses transport 已带，
      // 这里兜底以防其它客户端省略）
      upstreamBody.store = false;
      // Codex 端点校验比官方 Responses API 更严：assistant 历史消息的
      // content part 只接受 output_text / refusal，收到 input_text 直接 400。
      // 注意：不能要求 item.type === "message"——通用客户端（含 Cyrene）发的
      // assistant 历史项可能不带该字段，只按 role 判定。
      if (Array.isArray(upstreamBody.input)) {
        for (const item of upstreamBody.input) {
          if (!item || item.role !== "assistant") continue;
          if (!Array.isArray(item.content)) continue;
          for (const part of item.content) {
            if (part && part.type === "input_text") part.type = "output_text";
          }
        }
      }
      headers["openai-beta"] = "responses=experimental";
    }

    log(`[proxy] ${model} → ${providerId} ${endpoint.upstream.split("?")[0]} (stream=${Boolean(body.stream)})`);

    const upstream = await fetch(endpoint.upstream, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(300_000),
    });

    if (body.stream) {
      // SSE 真流式转发；ChatGPT 只缓存已完成 output item，并在空终态中补回，
      // 让 Cyrene 能保存 function_call 后继续发送工具结果。
      res.writeHead(upstream.status, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        res.write(`data: ${JSON.stringify({ error: { message: `上游 ${providerId} 返回 HTTP ${upstream.status}: ${text.slice(0, 300)}` } })}\n\n`);
        res.end();
        return;
      }
      if (upstream.body) {
        const reader = upstream.body.getReader();
        const repair = providerId === "chatgpt" ? createResponsesSseRepair() : null;
        const decoder = repair ? new TextDecoder() : null;
        const pump = async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value) continue;
              if (repair && decoder) {
                const repaired = repair.push(decoder.decode(value, { stream: true }));
                if (repaired) res.write(repaired);
              } else {
                res.write(Buffer.from(value));
              }
            }
          } catch {
            // 客户端断开或上游中断：直接结束
          } finally {
            if (repair && decoder) {
              const repaired = repair.push(decoder.decode()) + repair.flush();
              if (repaired) res.write(repaired);
            }
            res.end();
          }
        };
        await pump();
      } else {
        res.end();
      }
      return;
    }

    const text = await upstream.text().catch(() => "");
    if (!upstream.ok) {
      json(res, upstream.status, { error: { message: `上游 ${providerId} 返回 HTTP ${upstream.status}: ${text.slice(0, 300)}` } });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      json(res, 502, { error: { message: `上游 ${providerId} 返回了非 JSON 内容` } });
      return;
    }
    json(res, 200, parsed);
  }

  async function handleModels(res) {
    if (!fetchCatalog) {
      const models = [];
      for (const key of Object.keys(PROVIDERS)) {
        const auth = await getTokens(key).catch(() => null);
        if (auth && auth.tokens) models.push({ id: `${key}-default`, object: "model" });
      }
      json(res, 200, { object: "list", data: models });
      return;
    }
    const out = [];
    for (const key of Object.keys(PROVIDERS)) {
      const auth = await getTokens(key).catch(() => null);
      if (!auth || !auth.tokens) continue;
      const catalog = await fetchCatalog(key).catch(() => null);
      if (catalog && Array.isArray(catalog.models)) {
        for (const m of catalog.models) out.push({ id: m.id, object: "model", owned_by: key, name: m.name });
      }
    }
    json(res, 200, { object: "list", data: out });
  }

  server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${currentPort || DEFAULT_PORT}`);
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, port: currentPort });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      handleModels(res).catch((error) => json(res, 500, { error: { message: error.message } }));
      return;
    }
    if (req.method === "POST" && ENDPOINTS[url.pathname]) {
      handleChatCompletions(req, res, ENDPOINTS[url.pathname]).catch((error) => {
        json(res, 500, { error: { message: error.message } });
      });
      return;
    }
    json(res, 404, {
      error: {
        message: `未知端点 ${url.pathname}（支持 POST ${Object.keys(ENDPOINTS).join(" / ")}，GET /v1/models，GET /health）`,
      },
    });
  });

  return {
    server,
    port: () => currentPort,
    async start(preferredPort = DEFAULT_PORT) {
      if (server && currentPort) return currentPort;
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener("listening", onListen);
          reject(error);
        };
        const onListen = () => {
          server.removeListener("error", onError);
          const addr = server.address();
          currentPort = addr && typeof addr === "object" ? addr.port : preferredPort;
          log(`[proxy] 已监听 127.0.0.1:${currentPort}`);
          resolve(currentPort);
        };
        server.once("error", onError);
        server.once("listening", onListen);
        server.listen(preferredPort, "127.0.0.1");
      });
    },
    async stop() {
      if (!server) return;
      const s = server;
      server = null;
      currentPort = 0;
      await new Promise((resolve) => s.close(() => resolve()));
    },
  };
}

module.exports = { createProxy, createResponsesSseRepair, DEFAULT_PORT, tierOf };
