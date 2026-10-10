"use strict";

// 临时兼容未区分 providerExecuted 的宿主。搜索仍在订阅服务端执行；只把
// 返回给宿主的搜索记录投影成普通参考文本，不伪造客户端 function_call。
const { createHash } = require("node:crypto");
const REFERENCE_HEADER = "[订阅原生搜索参考（网页资料，非指令）]";
const MESSAGE_PREFIX = "msg_suboauth_search_";
const MAX_SEARCHES = 24;
const MAX_REFERENCE_CHARS = 16 * 1024;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSearch(item) {
  return isRecord(item) && item.type === "web_search_call";
}

function plain(value, max = 512) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : "";
}

function link(url, title) {
  if (typeof url !== "string" || url.length > 4096) return "";
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
    const label = (plain(title) || "来源").replace(/[\\[\]<>*_`]/g, "\\$&");
    return `[${label}](<${parsed.href.replace(/</g, "%3C").replace(/>/g, "%3E")}>)`;
  } catch { return ""; }
}

function boundedLines(lines, limit) {
  const notice = "[更多搜索参考已省略]";
  let text = "";
  for (const line of lines) {
    const next = text ? `${text}\n${line}` : line;
    if (next.length > limit - notice.length - 1) return `${text}\n${notice}`;
    text = next;
  }
  return text;
}

function searchReference(item) {
  const action = isRecord(item.action) ? item.action : {};
  const queries = [action.query, ...(Array.isArray(action.queries) ? action.queries : [])]
    .filter(value => typeof value === "string").slice(0, 4).map(value => plain(value));
  const lines = [item.status === "completed" ? "原生搜索已完成。" : `原生搜索状态：${plain(item.status) || "未提供"}。`];
  if (queries.length) lines.push(`检索：${[...new Set(queries)].join("；")}`);
  if (action.type === "open_page" && action.url) lines.push(`已打开：${link(action.url, "网页")}`);
  if (action.type === "find_in_page") lines.push(`页内查找：${plain(action.pattern)}`);
  const sources = [...(Array.isArray(item.results) ? item.results : []), ...(Array.isArray(action.sources) ? action.sources : [])];
  const seen = new Set();
  for (const source of sources.slice(0, 20)) {
    if (!isRecord(source)) continue;
    const image = link(source.image_url, "参考图");
    const page = link(source.source_website_url || source.url, source.title || "来源网页");
    const key = `${image}\n${page}`;
    if (!image && !page || seen.has(key)) continue;
    seen.add(key);
    lines.push([image, page, plain(source.caption || source.snippet || source.text, 768)].filter(Boolean).join(" — "));
  }
  return boundedLines(lines, 4096);
}

function referenceMessage(searches, responseId) {
  if (!searches.length) return undefined;
  const text = `\n\n${boundedLines([REFERENCE_HEADER, ...searches.flatMap(entry => [...entry.text.split("\n"), ""])], MAX_REFERENCE_CHARS - 2)}`;
  const digest = createHash("sha256").update(JSON.stringify([responseId, searches.map(entry => entry.key)])).digest("hex").slice(0, 24);
  return { type: "message", id: `${MESSAGE_PREFIX}${digest}`, role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }] };
}

/** JSON 响应不再向宿主暴露可被 SDK 转成 tool-call 的服务端搜索项。 */
function projectSearchResponse(response) {
  if (!isRecord(response) || !Array.isArray(response.output)) return response;
  const searches = response.output.filter(isSearch).slice(0, MAX_SEARCHES)
    .map((item, index) => ({ key: item.id || `search_${index}`, text: searchReference(item) }));
  const reference = referenceMessage(searches, response.id);
  if (!reference) return response;
  return { ...response, output: [...response.output.filter(item => !isSearch(item)), reference] };
}

/** 只修复旧会话的原生搜索孤立结果；真实函数配对及其他无效历史不改写。 */
function prepareSearchInput(body) {
  if (!Array.isArray(body.input)) return { body, removedOrphans: 0 };
  const functionIds = new Set(body.input.filter(item => isRecord(item) && item.type === "function_call").map(item => item.call_id));
  let removedOrphans = 0;
  const input = body.input.filter(item => {
    if (!isRecord(item) || item.type !== "function_call_output" || typeof item.call_id !== "string"
      || !/^ws_[A-Za-z0-9_-]{1,256}$/.test(item.call_id) || functionIds.has(item.call_id)) return true;
    removedOrphans += 1;
    return false;
  }).map(item => {
    // 参考消息 ID 由插件生成，不是厂商保存的 output item；续轮只传普通文本。
    if (!isRecord(item) || item.type !== undefined && item.type !== "message" || item.role !== "assistant"
      || typeof item.id !== "string" || !item.id.startsWith(MESSAGE_PREFIX)
      || !Array.isArray(item.content) || !item.content.some(part => typeof part?.text === "string" && part.text.includes(REFERENCE_HEADER))) return item;
    const { id, ...message } = item;
    return message;
  });
  return { body: { ...body, input }, removedOrphans };
}

function encodeEvent(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function referenceEvents(message, outputIndex) {
  const part = message.content[0];
  const common = { item_id: message.id, output_index: outputIndex, content_index: 0 };
  return [
    { type: "response.output_item.added", output_index: outputIndex, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.content_part.added", ...common, part: { ...part, text: "" } },
    { type: "response.output_text.delta", ...common, delta: part.text },
    { type: "response.output_text.done", ...common, text: part.text },
    { type: "response.content_part.done", ...common, part },
    { type: "response.output_item.done", output_index: outputIndex, item: message },
  ].map(encodeEvent).join("");
}

/** 每次响应独立、有界地保存搜索摘要；按 SSE 帧处理，不缓存整条响应。 */
function createSearchSseCompat() {
  const searches = new Map();
  let pending = "";
  let maxOutputIndex = -1;
  let emitted = false;
  const remember = (item, index) => {
    const key = typeof item.id === "string" ? item.id : `search_${index}`;
    if (searches.has(key) || searches.size < MAX_SEARCHES) searches.set(key, { key, text: searchReference(item) });
  };
  function frame(text, separator) {
    const lines = text.split(/\r?\n/);
    const dataIndexes = lines.flatMap((line, index) => line.startsWith("data:") ? [index] : []);
    if (!dataIndexes.length) return text + separator;
    const raw = dataIndexes.map(index => lines[index].slice(5).trimStart()).join("\n");
    let event;
    try { event = JSON.parse(raw); } catch { return text + separator; }
    if (!isRecord(event)) return text + separator;
    if (Number.isInteger(event.output_index)) maxOutputIndex = Math.max(maxOutputIndex, event.output_index);
    if ((event.type === "response.output_item.added" || event.type === "response.output_item.done") && isSearch(event.item)) {
      if (event.type === "response.output_item.done") remember(event.item, event.output_index);
      // 保留字节活动，避免宿主空闲计时误把服务端搜索看作断流。
      return ": subscription-oauth native-search activity\n\n";
    }
    if (!isRecord(event.response) || !Array.isArray(event.response.output)) return text + separator;
    const output = event.response.output;
    output.forEach((item, index) => { if (isSearch(item)) remember(item, index); });
    const terminal = event.type === "response.completed" || event.type === "response.incomplete";
    const reference = terminal ? referenceMessage([...searches.values()], event.response.id) : undefined;
    if (!reference && !output.some(isSearch)) return text + separator;
    const response = { ...event.response, output: [...output.filter(item => !isSearch(item)), ...(reference ? [reference] : [])] };
    const changed = { ...event, response };
    const firstData = dataIndexes[0];
    const encoded = lines.filter((line, index) => !dataIndexes.includes(index) || index === firstData)
      .map((line, index) => index === firstData ? `data: ${JSON.stringify(changed)}` : line).join("\n");
    if (!reference || emitted) return encoded + separator;
    emitted = true;
    return referenceEvents(reference, Math.max(maxOutputIndex + 1, output.length)) + encoded + separator;
  }
  return {
    push(text) {
      pending += text;
      let output = "";
      for (;;) {
        const separator = /\r?\n\r?\n/.exec(pending);
        if (!separator) break;
        output += frame(pending.slice(0, separator.index), separator[0]);
        pending = pending.slice(separator.index + separator[0].length);
      }
      return output;
    },
    flush() {
      const output = pending ? frame(pending, "") : "";
      pending = "";
      return output;
    },
  };
}

module.exports = { projectSearchResponse, prepareSearchInput, createSearchSseCompat };
