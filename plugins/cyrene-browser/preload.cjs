"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const ACTION_CHANNEL = "plugin:cyrene-browser:ui-action";
const STATE_CHANNEL = "plugin:cyrene-browser:ui-state";
const COMMAND_CHANNEL = "plugin:cyrene-browser:ui-command";

contextBridge.exposeInMainWorld("cyreneBrowser", {
  action(payload) {
    return ipcRenderer.invoke(ACTION_CHANNEL, payload);
  },
  onState(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on(STATE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(STATE_CHANNEL, listener);
  },
  onCommand(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, command) => callback(command);
    ipcRenderer.on(COMMAND_CHANNEL, listener);
    return () => ipcRenderer.removeListener(COMMAND_CHANNEL, listener);
  },
});
