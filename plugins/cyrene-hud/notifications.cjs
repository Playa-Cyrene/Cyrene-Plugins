"use strict";
const validId = value => typeof value === "string" && value.length > 0 && value.length <= 128;
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
      data.unread = data.unread.filter(message => sessions.has(message.sessionId));
      let added = 0;
      for (const message of [...batch.messages].sort((a, b) => a.at - b.at)) {
        if (!validId(message?.id) || !sessions.has(message.sessionId) || !Number.isFinite(message.at) || typeof message.preview !== "string") continue;
        const cursor = Object.hasOwn(data.sessions, message.sessionId) ? data.sessions[message.sessionId] : { at: data.since, ids: [] };
        if (message.at < cursor.at || message.at === cursor.at && cursor.ids.includes(message.id)) continue;
        const next = { at: message.at, ids: message.at === cursor.at ? [...cursor.ids, message.id] : [message.id] };
        Object.defineProperty(data.sessions, message.sessionId, { value: next, enumerable: true, configurable: true, writable: true });
        data.unread.push({ id: message.id, sessionId: message.sessionId, at: message.at, preview: message.preview.slice(0, 100) }); added++;
      }
      if (JSON.stringify(data) !== before) persist();
      return added;
    },
    target() {
      const sessionId = view().sessionId;
      return sessionId ? { sessionId, ids: data.unread.filter(message => message.sessionId === sessionId).map(message => message.id) } : null;
    },
    contains(target) { return validId(target?.sessionId) && Array.isArray(target.ids) && data.unread.some(message => message.sessionId === target.sessionId && target.ids.includes(message.id)); },
    acknowledge(target) {
      if (!this.contains(target)) return;
      data.unread = data.unread.filter(message => message.sessionId !== target.sessionId || !target.ids.includes(message.id)); persist();
    },
  };
}
async function readProactive(invoke, checkpoint) {
  const rows = await invoke("chats:list", { mode: "chat" });
  if (!Array.isArray(rows)) throw Error("会话列表不可用");
  const sessions = rows.filter(row => row.purpose === "proactive-chat" && row.mode === "chat" && validId(row.id));
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
      if (!page.hasMore || !page.messages.length || page.messages.some(message => message.at < cursor.at) || !Number.isFinite(next) || next <= 0 || next >= end) break;
      before = next;
    } while (true);
  }
  return { sessionIds: sessions.map(row => row.id), messages };
}
module.exports = { createNotifications, readProactive };
