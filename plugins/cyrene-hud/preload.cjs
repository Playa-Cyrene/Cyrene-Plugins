"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// plugins/cyrene-hud/navigation-upstream.cjs
var require_navigation_upstream = __commonJS({
  "plugins/cyrene-hud/navigation-upstream.cjs"(exports2, module2) {
    "use strict";
    var MODES = ["chat", "work", "code", "learn"];
    function createUpstreamNavigation2(invoke, send) {
      async function listSessions(mode) {
        if (!MODES.includes(mode)) throw Error("\u4E0D\u652F\u6301\u7684\u4F1A\u8BDD\u6A21\u5F0F");
        const rows = await invoke("chats:list", { mode });
        if (!Array.isArray(rows)) throw Error("\u5BBF\u4E3B\u672A\u8FD4\u56DE\u4F1A\u8BDD\u5217\u8868");
        return rows.filter((row) => row.mode === mode).map((row) => ({ id: row.id, title: row.title, mode: row.mode }));
      }
      async function open(config) {
        const mode = config.avatarTarget;
        if (mode === "none") return { sessionId: null };
        if (mode === "settings") {
          try {
            if (await invoke("settings:request-switch-section") !== true) throw Error("\u5BBF\u4E3B\u672A\u63A5\u53D7\u8BBE\u7F6E\u7A97\u53E3\u6253\u5F00\u8BF7\u6C42");
          } catch (error) {
            if (!/No handler registered for ['"]settings:request-switch-section['"]/.test(error.message || "") || typeof send !== "function") throw error;
            send("sidebar:open-settings");
          }
          return { sessionId: null };
        }
        if (!MODES.includes(mode)) throw Error("\u4E0D\u652F\u6301\u7684\u7A97\u53E3\u76EE\u6807");
        let id;
        if (config.avatarSession === "existing") {
          const session = (await listSessions(mode)).find((row) => row.id === config.avatarSessionId);
          if (!session) throw Error("\u6240\u9009\u4F1A\u8BDD\u4E0D\u5B58\u5728\u6216\u6A21\u5F0F\u5DF2\u6539\u53D8\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9");
          id = session.id;
        } else if (config.avatarSession === "new") {
          const session = await invoke("chats:create", { mode });
          if (!session?.id || session.mode !== mode) throw Error("\u5BBF\u4E3B\u672A\u521B\u5EFA\u6240\u9009\u6A21\u5F0F\u7684\u4F1A\u8BDD");
          id = session.id;
        } else throw Error("\u8BF7\u9009\u62E9\u5DF2\u6709\u4F1A\u8BDD\u6216\u65B0\u5EFA\u4F1A\u8BDD");
        if (await invoke("chats:open-in-react-window", id) !== true) throw Error("\u5BBF\u4E3B\u672A\u63A5\u53D7\u7A97\u53E3\u6253\u5F00\u8BF7\u6C42");
        return { sessionId: id };
      }
      return { listSessions, open };
    }
    module2.exports = { createUpstreamNavigation: createUpstreamNavigation2 };
  }
});

// plugins/cyrene-hud/status.cjs
var require_status = __commonJS({
  "plugins/cyrene-hud/status.cjs"(exports2, module2) {
    "use strict";
    async function readStatus2(invoke) {
      try {
        const [state, config] = await Promise.all([invoke("runtime-state:get"), invoke("model-config:get")]);
        return { available: true, enabled: config?.runtimeSync === "local" || config?.runtimeSync === "llm", connected: config?.connected === true, status: typeof state?.status === "string" ? state.status.slice(0, 30) : "", feeling: typeof state?.feeling === "string" ? state.feeling.slice(0, 30) : "" };
      } catch {
        return { available: false, enabled: false, connected: false, status: "", feeling: "" };
      }
    }
    module2.exports = { readStatus: readStatus2 };
  }
});

// plugins/cyrene-hud/notifications.cjs
var require_notifications = __commonJS({
  "plugins/cyrene-hud/notifications.cjs"(exports2, module2) {
    "use strict";
    var validId = (value) => typeof value === "string" && value.length > 0 && value.length <= 128;
    function createNotifications(storage, now = Date.now) {
      const saved = storage.get("notifications");
      const data = saved?.version === 1 ? saved : { version: 1, since: now(), sessions: {}, unread: [] };
      const persist = () => storage.set("notifications", data);
      if (saved?.version !== 1) persist();
      function view() {
        const last = data.unread.at(-1);
        return { count: data.unread.length, preview: last?.preview || "", sessionId: last?.sessionId || null };
      }
      return {
        checkpoint: () => ({ since: data.since, sessions: data.sessions }),
        view,
        ingest(batch) {
          if (!Array.isArray(batch?.sessionIds) || !Array.isArray(batch.messages)) return 0;
          const sessions = new Set(batch.sessionIds.filter(validId));
          const before = JSON.stringify(data);
          data.unread = data.unread.filter((message) => sessions.has(message.sessionId));
          let added = 0;
          for (const message of [...batch.messages].sort((a, b) => a.at - b.at)) {
            if (!validId(message?.id) || !sessions.has(message.sessionId) || !Number.isFinite(message.at) || typeof message.preview !== "string") continue;
            const cursor = Object.hasOwn(data.sessions, message.sessionId) ? data.sessions[message.sessionId] : { at: data.since, ids: [] };
            if (message.at < cursor.at || message.at === cursor.at && cursor.ids.includes(message.id)) continue;
            const next = { at: message.at, ids: message.at === cursor.at ? [...cursor.ids, message.id] : [message.id] };
            Object.defineProperty(data.sessions, message.sessionId, { value: next, enumerable: true, configurable: true, writable: true });
            data.unread.push({ id: message.id, sessionId: message.sessionId, at: message.at, preview: message.preview.slice(0, 100) });
            added++;
          }
          if (JSON.stringify(data) !== before) persist();
          return added;
        },
        target() {
          const sessionId = view().sessionId;
          return sessionId ? { sessionId, ids: data.unread.filter((message) => message.sessionId === sessionId).map((message) => message.id) } : null;
        },
        contains(target) {
          return validId(target?.sessionId) && Array.isArray(target.ids) && data.unread.some((message) => message.sessionId === target.sessionId && target.ids.includes(message.id));
        },
        acknowledge(target) {
          if (!this.contains(target)) return;
          data.unread = data.unread.filter((message) => message.sessionId !== target.sessionId || !target.ids.includes(message.id));
          persist();
        }
      };
    }
    async function readProactive2(invoke, checkpoint) {
      const rows = await invoke("chats:list", { mode: "chat" });
      if (!Array.isArray(rows)) throw Error("\u4F1A\u8BDD\u5217\u8868\u4E0D\u53EF\u7528");
      const sessions = rows.filter((row) => row.purpose === "proactive-chat" && row.mode === "chat" && validId(row.id));
      const messages = [];
      for (const row of sessions) {
        const cursor = Object.hasOwn(checkpoint.sessions, row.id) ? checkpoint.sessions[row.id] : { at: checkpoint.since, ids: [] };
        if (Number.isFinite(row.updatedAt) && row.updatedAt < cursor.at) continue;
        let before = null;
        do {
          const page = await invoke("chats:get-page", { id: row.id, before, limit: 200 });
          if (!page || page.session?.purpose !== "proactive-chat" || !Array.isArray(page.messages)) break;
          for (const message of page.messages) {
            if (message.role !== "model" || !validId(message.id) || !Number.isFinite(message.at) || message.at < cursor.at || message.at === cursor.at && cursor.ids.includes(message.id) || typeof message.content !== "string" || !message.content.trim()) continue;
            messages.push({ id: message.id, sessionId: row.id, at: message.at, preview: message.content.replace(/\s+/g, " ").trim().slice(0, 100) });
          }
          const end = before ?? page.session.messageCount;
          const next = end - page.messages.length;
          if (!page.hasMore || !page.messages.length || page.messages.some((message) => message.at < cursor.at) || !Number.isFinite(next) || next <= 0 || next >= end) break;
          before = next;
        } while (true);
      }
      return { sessionIds: sessions.map((row) => row.id), messages };
    }
    module2.exports = { createNotifications, readProactive: readProactive2 };
  }
});

// plugins/cyrene-hud/preload.cjs
var { contextBridge, ipcRenderer } = require("electron");
var { createUpstreamNavigation } = require_navigation_upstream();
var { readStatus } = require_status();
var { readProactive } = require_notifications();
var edition = "upstream";
var upstream = createUpstreamNavigation((channel, ...args) => ipcRenderer.invoke(channel, ...args), (channel) => ipcRenderer.send(channel));
var opening;
var listen = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld("cyreneHud", {
  // Fixed endpoints only; no generic IPC, shell or model access.
  snapshot: () => ipcRenderer.invoke("plugin:cyrene-hud:snapshot"),
  status: () => readStatus((channel) => ipcRenderer.invoke(channel)),
  state: () => ipcRenderer.invoke("plugin:cyrene-hud:state"),
  save: (value) => ipcRenderer.invoke("plugin:cyrene-hud:save", value),
  preview: () => ipcRenderer.invoke("plugin:cyrene-hud:preview"),
  testUi: (action) => ipcRenderer.invoke("plugin:cyrene-hud:ui-test", action),
  listSessions: (mode) => edition === "local" ? ipcRenderer.invoke("plugin:cyrene-hud:list-sessions", mode) : upstream.listSessions(mode),
  openTarget: () => {
    if (opening) return opening;
    opening = ipcRenderer.invoke("plugin:cyrene-hud:state").then((state) => state.testing ? void 0 : edition === "local" ? ipcRenderer.invoke("plugin:cyrene-hud:open-target") : upstream.open(state.config)).finally(() => {
      opening = void 0;
    });
    return opening;
  },
  openNotification: async () => {
    const target = await ipcRenderer.invoke("plugin:cyrene-hud:notification-target");
    if (!target) return;
    if (edition === "local") return ipcRenderer.invoke("plugin:cyrene-hud:notification-open", target);
    await upstream.open({ avatarTarget: "chat", avatarSession: "existing", avatarSessionId: target.sessionId });
    await ipcRenderer.invoke("plugin:cyrene-hud:notification-read", target);
  },
  avatarHover: (value) => ipcRenderer.invoke("plugin:cyrene-hud:avatar-hover", value),
  reducedMotion: (value) => ipcRenderer.invoke("plugin:cyrene-hud:reduced-motion", value),
  detailWidths: (value) => ipcRenderer.invoke("plugin:cyrene-hud:detail-widths", value),
  onLayout: (callback) => listen("plugin:cyrene-hud:layout", callback),
  onChange: (callback) => listen("plugin:cyrene-hud:changed", callback),
  onVisibility: (callback) => listen("plugin:cyrene-hud:visibility", callback),
  onSnapshot: (callback) => listen("plugin:cyrene-hud:snapshot", callback)
});
if (location.pathname.endsWith("/hud.html")) {
  let running = false, dirty = false, disposed = false;
  async function refresh() {
    dirty = true;
    if (running || disposed) return;
    running = true;
    try {
      do {
        dirty = false;
        const cursor = await ipcRenderer.invoke("plugin:cyrene-hud:notification-checkpoint");
        const batch = await readProactive((channel, payload) => ipcRenderer.invoke(channel, payload), cursor);
        if (!disposed) await ipcRenderer.invoke("plugin:cyrene-hud:notification-batch", batch);
      } while (dirty && !disposed);
    } catch {
    } finally {
      running = false;
    }
  }
  const remove = listen("chats:changed", refresh), timer = setInterval(refresh, 5e3);
  window.addEventListener("DOMContentLoaded", refresh, { once: true });
  window.addEventListener("unload", () => {
    disposed = true;
    remove();
    clearInterval(timer);
  }, { once: true });
}
