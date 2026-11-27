"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const CH = "plugin:gh-vault:";

contextBridge.exposeInMainWorld("ghVault", {
  invoke(action, payload) {
    const name = String(action || "");
    if (!name) throw new Error("缺少 IPC 动作名");
    return ipcRenderer.invoke(CH + name, payload);
  },
});
