"use strict";

// 沙箱 preload 只使用 Electron 提供的受限 require；页面本身没有 Node 权限。
const { contextBridge, ipcRenderer } = require("electron");

const PREFIX = "plugin:better-lessons:";
const REQUESTS = new Set([
  "state", "advance", "review", "clear-classroom", "pick-lesson",
  "replay", "replay-all", "win-minimize", "win-maximize", "win-close",
]);
const EVENTS = new Set(["bind", "push", "restore", "notice"]);
const NO_PAYLOAD = new Set(["state", "win-minimize", "win-maximize", "win-close"]);

function checkedPayload(name, payload) {
  if (NO_PAYLOAD.has(name)) {
    if (payload !== undefined) throw new TypeError(`${name} 不接受参数`);
    return undefined;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError(`${name} 需要参数对象`);
  }
  const allowed = name === "replay" ? ["conversationId", "file"] : ["conversationId"];
  if (Object.keys(payload).some((key) => !allowed.includes(key))) {
    throw new TypeError(`${name} 含有未知参数`);
  }
  if (!Object.prototype.hasOwnProperty.call(payload, "conversationId")) {
    throw new TypeError("缺少会话标识");
  }
  const conversationId = payload.conversationId;
  if (conversationId !== null &&
      (typeof conversationId !== "string" || !conversationId ||
       conversationId.length > 512 || conversationId.includes("\0"))) {
    throw new TypeError("会话标识无效");
  }
  const safe = { conversationId };
  if (name === "replay") {
    if (!Object.prototype.hasOwnProperty.call(payload, "file")) {
      throw new TypeError("缺少剧本文件名");
    }
    const file = payload.file;
    if (typeof file !== "string" || !file || file.length > 2048 ||
        /[\\/\0]/.test(file)) {
      throw new TypeError("剧本文件名无效");
    }
    safe.file = file;
  }
  return safe;
}

contextBridge.exposeInMainWorld("betterLessons", Object.freeze({
  invoke(name, payload) {
    if (!REQUESTS.has(name)) return Promise.reject(new TypeError("未授权的课堂操作"));
    try {
      return ipcRenderer.invoke(PREFIX + name, checkedPayload(name, payload));
    } catch (error) {
      return Promise.reject(error);
    }
  },
  on(name, callback) {
    if (!EVENTS.has(name) || typeof callback !== "function") {
      throw new TypeError("未授权的课堂事件");
    }
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(PREFIX + name, listener);
    return () => ipcRenderer.removeListener(PREFIX + name, listener);
  },
}));
