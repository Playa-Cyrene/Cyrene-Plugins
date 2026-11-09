'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['get-state', 'save-config', 'start-gateway', 'stop-gateway', 'refresh', 'select-instance', 'inspect-scene', 'capture-preview', 'submit-render', 'cancel-job']);

contextBridge.exposeInMainWorld('CyrenePanel', {
  invoke(channel, ...args) {
    if (!allowed.has(channel)) return Promise.reject(new Error('不支持的工作台操作。'));
    return ipcRenderer.invoke(`plugin:cyrene-blender:${channel}`, ...args);
  },
  onTheme(callback) {
    if (typeof callback === 'function') queueMicrotask(() => callback({ theme: 'light' }));
    return () => {};
  },
});
