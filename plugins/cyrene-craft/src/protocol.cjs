"use strict";

/**
 * 行协议：宿主插件进程 <-> 机器人子进程。
 *
 * 为什么用 JSON 行而不是别的：
 * - 子进程用 ELECTRON_RUN_AS_NODE 跑，只能靠 stdio 通信，stdin/stdout 天然是字节流
 * - 一行一条消息，只要不出现裸换行就能无损切分；JSON.stringify 会把换行转义成 \n
 * - 调试时直接看日志就能读，不需要额外解码工具
 *
 * 消息形状：
 *   请求   { id, cmd, args }
 *   响应   { id, ok: true, data }  /  { id, ok: false, error }
 *   事件   { event, data }          （没有 id，单向推送）
 *   握手   { kind: "ready", pid, version }
 */

const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * 把一条消息编码成可安全写入管道的一行文本。
 * 关键：禁用裸换行，避免把一条消息切成两条。
 */
function encode(message) {
  return JSON.stringify(message) + "\n";
}

/**
 * 流式解码器。stdout 的 chunk 边界和消息边界无关，
 * 必须自己缓冲到遇到换行才切一条出来。
 */
function createDecoder(onMessage, onError) {
  let buffer = "";

  return function feed(chunk) {
    buffer += chunk;

    // 防止对端发疯把内存撑爆
    if (buffer.length > MAX_LINE_BYTES) {
      buffer = "";
      onError?.(new Error("行协议单条消息超过上限，已丢弃缓冲"));
      return;
    }

    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim() === "") continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        // 单条坏消息不该拖垮整个通道，丢掉继续读
        onError?.(new Error(`行协议解析失败：${e.message}`));
        continue;
      }
      try {
        onMessage(parsed);
      } catch (e) {
        onError?.(e);
      }
    }
  };
}

/** 判断是否是响应消息 */
function isResponse(msg) {
  return msg !== null && typeof msg === "object" && typeof msg.id === "number";
}

/** 判断是否是事件消息 */
function isEvent(msg) {
  return msg !== null && typeof msg === "object" && typeof msg.event === "string";
}

module.exports = { encode, createDecoder, isResponse, isEvent, MAX_LINE_BYTES };
